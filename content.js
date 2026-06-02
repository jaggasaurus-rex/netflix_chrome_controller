// Netflix Controller — maps Xbox gamepad input to keyboard events

const DEADZONE          = 0.2;
const AXIS_REPEAT_DELAY    = 400;  // ms before a held stick direction starts repeating
const AXIS_REPEAT_INTERVAL = 150;  // ms between repeats once repeating starts
const MOUSE_SPEED       = 10;      // px per frame at full stick deflection
const MOUSE_DPAD_STEP   = 10;      // px per d-pad press in mouse mode

// Non-remappable button aliases — always hardcoded
// 4:LB → rewind, 5:RB → fast forward, 8:Back → back, 9:Start → play/pause
const FIXED_BUTTON_MAP = {
  4: 'ArrowLeft',
  5: 'ArrowRight',
  8: 'Escape',
  9: ' ',
};

// Storage key name (lowercase) → KeyboardEvent key value
const STORAGE_KEY_TO_EVENT_KEY = {
  enter:      'Enter',
  escape:     'Escape',
  space:      ' ',
  f:          'f',
  backspace:  'Backspace',
  w:          'w',
  a:          'a',
  s:          's',
  d:          'd',
  arrowup:    'ArrowUp',
  arrowdown:  'ArrowDown',
  arrowleft:  'ArrowLeft',
  arrowright: 'ArrowRight',
};

const KEY_TO_CODE = {
  ' ':          'Space',
  'Enter':      'Enter',
  'Escape':     'Escape',
  'Backspace':  'Backspace',
  'f':          'KeyF',
  'w':          'KeyW',
  'a':          'KeyA',
  's':          'KeyS',
  'd':          'KeyD',
  'ArrowUp':    'ArrowUp',
  'ArrowDown':  'ArrowDown',
  'ArrowLeft':  'ArrowLeft',
  'ArrowRight': 'ArrowRight',
};

// Direction name → event key per joystick mode
const DIR_KEYS = {
  arrows: { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' },
  wasd:   { left: 'a',         right: 'd',          up: 'w',       down: 's'         },
};

// D-pad button index → direction name
const DPAD_DIR = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };

// Left stick: [axisIndex, dir (+1/-1), dirName]
// Axis 0 = horizontal (left: -1, right: +1)
// Axis 1 = vertical   (up:   -1, down:  +1)
const STICK_AXES = [
  [0, -1, 'left'],
  [0,  1, 'right'],
  [1, -1, 'up'],
  [1,  1, 'down'],
];

// ---------------------------------------------------------------------------
// Runtime config — loaded from storage once, refreshed on overlay close
// ---------------------------------------------------------------------------

// Inverted mapping: buttonIndex → eventKey, built from stored remappable mappings
let remappableButtonMap = {};
let joystickMode = 'arrows';

async function refreshConfig() {
  const [mappings, mode] = await Promise.all([
    window.NCCMappings.loadMappings(),
    window.NCCMappings.loadJoystickMode(),
  ]);

  remappableButtonMap = {};
  if (mappings) {
    for (const [storageKey, btnIndex] of Object.entries(mappings)) {
      const eventKey = STORAGE_KEY_TO_EVENT_KEY[storageKey];
      if (eventKey !== undefined && btnIndex !== undefined) {
        remappableButtonMap[btnIndex] = eventKey;
      }
    }
  }

  joystickMode = mode ?? 'arrows';
}

// ---------------------------------------------------------------------------
// Input state
// ---------------------------------------------------------------------------

const prevButtonState = new Map(); // `${gpIndex}-${btnIndex}` → boolean
const stickActive     = new Map(); // `${gpIndex}-${axis}-${dir}` → boolean
const stickTimers     = new Map(); // same key → setTimeout handle

let virtualMouseX = window.innerWidth  / 2;
let virtualMouseY = window.innerHeight / 2;

let pollingActive = false;

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

function fireKey(key, type) {
  document.dispatchEvent(new KeyboardEvent(type, {
    key,
    code: KEY_TO_CODE[key] ?? '',
    bubbles: true,
    cancelable: true,
  }));
}

function fireMouseMove(dx, dy) {
  virtualMouseX = Math.max(0, Math.min(window.innerWidth,  virtualMouseX + dx));
  virtualMouseY = Math.max(0, Math.min(window.innerHeight, virtualMouseY + dy));
  document.dispatchEvent(new MouseEvent('mousemove', {
    clientX:    virtualMouseX,
    clientY:    virtualMouseY,
    movementX:  dx,
    movementY:  dy,
    bubbles:    true,
    cancelable: true,
  }));
}

function applyMouseDir(dirName, pixels) {
  const dx = dirName === 'left' ? -pixels : dirName === 'right' ? pixels : 0;
  const dy = dirName === 'up'   ? -pixels : dirName === 'down'  ? pixels : 0;
  fireMouseMove(dx, dy);
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

function scheduleRepeat(id, key) {
  stickTimers.set(id, setTimeout(() => {
    if (!stickActive.get(id)) return;
    fireKey(key, 'keydown');
    scheduleRepeat(id, key);
  }, AXIS_REPEAT_INTERVAL));
}

function pollGamepads() {
  for (const gp of navigator.getGamepads()) {
    if (!gp) continue;

    // --- Buttons ---
    gp.buttons.forEach((btn, i) => {
      const id = `${gp.index}-${i}`;
      const wasPressed = prevButtonState.get(id) ?? false;

      // D-pad: unified direction system (shares output with left stick)
      const dpadDir = DPAD_DIR[i];
      if (dpadDir !== undefined) {
        if (btn.pressed !== wasPressed) {
          prevButtonState.set(id, btn.pressed);
          if (joystickMode === 'mouse') {
            if (btn.pressed) applyMouseDir(dpadDir, MOUSE_DPAD_STEP);
          } else {
            const key = DIR_KEYS[joystickMode]?.[dpadDir];
            if (key) fireKey(key, btn.pressed ? 'keydown' : 'keyup');
          }
        }
        return;
      }

      // Remappable face buttons (0–3 by default) + fixed buttons (4,5,8,9)
      const key = remappableButtonMap[i] ?? FIXED_BUTTON_MAP[i];
      if (!key) return;

      if (btn.pressed !== wasPressed) {
        fireKey(key, btn.pressed ? 'keydown' : 'keyup');
        prevButtonState.set(id, btn.pressed);
      }
    });

    // --- Left analog stick (axes 0 & 1) ---
    STICK_AXES.forEach(([axis, dir, dirName]) => {
      const id = `${gp.index}-${axis}-${dir}`;
      const raw = gp.axes[axis] ?? 0;
      const active = dir > 0 ? raw > DEADZONE : raw < -DEADZONE;
      const wasActive = stickActive.get(id) ?? false;

      if (joystickMode === 'mouse') {
        // Continuous per-frame movement proportional to deflection magnitude
        if (active) applyMouseDir(dirName, Math.abs(raw) * MOUSE_SPEED);
        // Clean up any key-mode state left over from a mode switch
        if (wasActive) {
          stickActive.set(id, false);
          clearTimeout(stickTimers.get(id));
        }
        return;
      }

      const key = DIR_KEYS[joystickMode]?.[dirName];
      if (!key) return;

      if (active && !wasActive) {
        stickActive.set(id, true);
        fireKey(key, 'keydown');
        stickTimers.set(id, setTimeout(() => {
          if (stickActive.get(id)) {
            fireKey(key, 'keydown');
            scheduleRepeat(id, key);
          }
        }, AXIS_REPEAT_DELAY));
      } else if (!active && wasActive) {
        stickActive.set(id, false);
        clearTimeout(stickTimers.get(id));
        fireKey(key, 'keyup');
      }
    });
  }

  requestAnimationFrame(pollGamepads);
}

function startPolling() {
  if (pollingActive) return;
  pollingActive = true;
  console.log('[Controller] Polling started');
  requestAnimationFrame(pollGamepads);
}

window.addEventListener('gamepadconnected', (e) => {
  console.log(`[Controller] Connected: ${e.gamepad.id}`);
  startPolling();
});

window.addEventListener('gamepaddisconnected', (e) => {
  console.log(`[Controller] Disconnected: ${e.gamepad.id}`);
});

// Load config first, then check for already-connected gamepads
refreshConfig().then(() => {
  if ([...navigator.getGamepads()].some(Boolean)) startPolling();
});

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

let overlay = null;

function createOverlay() {
  const panel = document.createElement('div');
  panel.id = 'ncc-overlay';
  panel.style.cssText = [
    'position:fixed',
    'top:50%',
    'left:50%',
    'transform:translate(-50%,-50%)',
    'z-index:2147483647',
    'background:#141414',
    'color:#fff',
    'border-radius:8px',
    'padding:28px 32px 24px',
    'min-width:320px',
    'box-shadow:0 8px 40px rgba(0,0,0,0.85)',
    'font-family:"Netflix Sans","Helvetica Neue",Helvetica,Arial,sans-serif',
  ].join(';');

  const title = document.createElement('h2');
  title.textContent = 'Controller Settings';
  title.style.cssText = 'margin:0;font-size:20px;font-weight:700;letter-spacing:0.01em';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.style.cssText = [
    'position:absolute',
    'top:10px',
    'right:14px',
    'background:none',
    'border:none',
    'color:#fff',
    'font-size:22px',
    'line-height:1',
    'cursor:pointer',
    'padding:4px 6px',
    'opacity:0.7',
  ].join(';');
  closeBtn.addEventListener('mouseover', () => { closeBtn.style.opacity = '1'; });
  closeBtn.addEventListener('mouseout',  () => { closeBtn.style.opacity = '0.7'; });
  closeBtn.addEventListener('click', hideOverlay);

  panel.appendChild(title);
  panel.appendChild(closeBtn);
  return panel;
}

function showOverlay() {
  if (overlay) return;
  overlay = createOverlay();
  document.body.appendChild(overlay);
}

function hideOverlay() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  refreshConfig();
}

function toggleOverlay() {
  overlay ? hideOverlay() : showOverlay();
}

// Backtick keyboard toggle
document.addEventListener('keydown', (e) => {
  if (e.key === '`') toggleOverlay();
});

// Icon-click toggle (message from background service worker)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'toggleOverlay') toggleOverlay();
});
