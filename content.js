// Netflix Controller — maps Xbox gamepad input to keyboard events

const IS_TOP_FRAME = window === window.top;

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

// Remapping capture state — read by pollGamepads to suppress game input
let listeningForKey  = null; // storage key currently being remapped, or null
let onButtonCaptured = null; // callback(btnIndex) set by overlay while listening

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

      // While a row is listening, intercept the first new press as the
      // assignment target and suppress all game input dispatch.
      if (listeningForKey !== null) {
        if (btn.pressed !== wasPressed) {
          prevButtonState.set(id, btn.pressed);
          if (btn.pressed && onButtonCaptured) {
            const cb = onButtonCaptured;
            onButtonCaptured = null;
            listeningForKey = null;
            cb(i);
          }
        }
        return;
      }

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
      // Suppress stick output while remapping
      if (listeningForKey !== null) return;

      const id = `${gp.index}-${axis}-${dir}`;
      const raw = gp.axes[axis] ?? 0;
      const active = dir > 0 ? raw > DEADZONE : raw < -DEADZONE;
      const wasActive = stickActive.get(id) ?? false;

      if (joystickMode === 'mouse') {
        if (active) applyMouseDir(dirName, Math.abs(raw) * MOUSE_SPEED);
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
// Overlay — top frame only
// ---------------------------------------------------------------------------

if (IS_TOP_FRAME) {

const KEY_LABELS = {
  enter:      'Enter',
  escape:     'Escape',
  space:      'Space',
  f:          'F',
  backspace:  'Backspace',
  w:          'W',
  a:          'A',
  s:          'S',
  d:          'D',
  arrowup:    'Arrow Up',
  arrowdown:  'Arrow Down',
  arrowleft:  'Arrow Left',
  arrowright: 'Arrow Right',
};

const JOYSTICK_MODE_OPTIONS = [
  { value: 'arrows', label: 'Arrow Keys'      },
  { value: 'wasd',   label: 'WASD'            },
  { value: 'mouse',  label: 'Mouse Movement'  },
];

let overlay         = null;
let overlayBuilding = false;
let overlayGrid     = null;
let overlayMappings = {};
let overlayModeSelect = null;

// --- Row helpers ---

function makeEl(tag, css) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  return e;
}

function buildRow(storageKey, mappings) {
  const assignedIndex = mappings[storageKey];

  const row = makeEl('div', [
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'padding:7px 0',
    'border-bottom:1px solid rgba(255,255,255,0.07)',
  ].join(';'));
  row.dataset.key = storageKey;

  const labelEl = makeEl('span', 'font-size:14px;color:#e5e5e5;flex:1');
  labelEl.textContent = KEY_LABELS[storageKey];

  const chip = makeEl('button', [
    'background:rgba(255,255,255,0.08)',
    'border:1px solid rgba(255,255,255,0.15)',
    'border-radius:4px',
    'color:' + (assignedIndex !== undefined ? '#fff' : '#666'),
    'font-size:13px',
    'padding:4px 10px',
    'cursor:pointer',
    'min-width:120px',
    'text-align:center',
  ].join(';'));
  chip.textContent = assignedIndex !== undefined ? `Button ${assignedIndex}` : 'Unassigned';

  chip.addEventListener('mouseenter', () => {
    if (listeningForKey !== storageKey) chip.style.background = 'rgba(255,255,255,0.15)';
  });
  chip.addEventListener('mouseleave', () => {
    if (listeningForKey !== storageKey) chip.style.background = 'rgba(255,255,255,0.08)';
  });
  chip.addEventListener('click', () => handleRowClick(storageKey, chip));

  row.appendChild(labelEl);
  row.appendChild(chip);
  return row;
}

function buildGrid(mappings) {
  const grid = makeEl('div', [
    'display:grid',
    'grid-template-columns:1fr 1fr',
    'grid-auto-flow:column',
    'grid-template-rows:repeat(7,auto)',
    'column-gap:24px',
    'margin:16px 0 8px',
  ].join(';'));
  for (const key of window.NCCMappings.VALID_KEYS) {
    grid.appendChild(buildRow(key, mappings));
  }
  return grid;
}

function setChipListening(chip) {
  chip.textContent = 'Press a button…';
  chip.style.background    = 'rgba(229,9,20,0.25)';
  chip.style.borderColor   = 'rgba(229,9,20,0.7)';
  chip.style.color         = '#fff';
}

function resetChip(chip, mappings, storageKey) {
  const idx = mappings[storageKey];
  chip.textContent         = idx !== undefined ? `Button ${idx}` : 'Unassigned';
  chip.style.background    = 'rgba(255,255,255,0.08)';
  chip.style.borderColor   = 'rgba(255,255,255,0.15)';
  chip.style.color         = idx !== undefined ? '#fff' : '#666';
}

// --- Row click handler ---

function handleRowClick(storageKey, chip) {
  if (listeningForKey !== null) {
    const prevKey  = listeningForKey;
    const prevRow  = overlayGrid.querySelector(`[data-key="${prevKey}"]`);
    const prevChip = prevRow?.querySelector('button');

    listeningForKey  = null;
    onButtonCaptured = null;
    if (prevChip) resetChip(prevChip, overlayMappings, prevKey);

    // Clicking the already-listening row just cancels it
    if (prevKey === storageKey) return;
  }

  listeningForKey = storageKey;
  setChipListening(chip);

  const capturedKey = storageKey;
  onButtonCaptured = async (btnIndex) => {
    overlayMappings = await window.NCCMappings.assignButton(capturedKey, btnIndex);
    const newGrid = buildGrid(overlayMappings);
    overlayGrid.replaceWith(newGrid);
    overlayGrid = newGrid;
    await refreshConfig();
  };
}

// --- Mode dropdown ---

function buildModeSection(currentMode) {
  const section = makeEl('div', [
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'padding:12px 0 2px',
    'border-top:1px solid rgba(255,255,255,0.1)',
    'margin-top:4px',
  ].join(';'));

  const label = makeEl('span', 'font-size:14px;color:#e5e5e5');
  label.textContent = 'Joystick Mode';

  const select = makeEl('select', [
    'background:#222',
    'border:1px solid rgba(255,255,255,0.2)',
    'border-radius:4px',
    'color:#fff',
    'font-size:13px',
    'padding:4px 8px',
    'cursor:pointer',
    'min-width:140px',
  ].join(';'));

  for (const { value, label: text } of JOYSTICK_MODE_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    if (value === currentMode) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', async () => {
    await window.NCCMappings.saveJoystickMode(select.value);
    await refreshConfig();
  });

  overlayModeSelect = select;

  section.appendChild(label);
  section.appendChild(select);
  return section;
}

function buildResetSection() {
  const section = makeEl('div', [
    'display:flex',
    'justify-content:flex-end',
    'padding:12px 0 2px',
    'border-top:1px solid rgba(255,255,255,0.1)',
    'margin-top:8px',
  ].join(';'));

  const btn = makeEl('button', [
    'background:rgba(255,255,255,0.07)',
    'border:1px solid rgba(255,255,255,0.2)',
    'border-radius:4px',
    'color:#ccc',
    'font-size:13px',
    'padding:5px 14px',
    'cursor:pointer',
  ].join(';'));
  btn.textContent = 'Reset to Default';

  btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.13)'; btn.style.color = '#fff'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,255,255,0.07)'; btn.style.color = '#ccc'; });

  btn.addEventListener('click', async () => {
    const { mappings, mode } = await window.NCCMappings.resetToDefaults();
    overlayMappings = mappings;

    const newGrid = buildGrid(overlayMappings);
    overlayGrid.replaceWith(newGrid);
    overlayGrid = newGrid;

    if (overlayModeSelect) overlayModeSelect.value = mode;

    await refreshConfig();
  });

  section.appendChild(btn);
  return section;
}

function buildFooter() {
  const footer = makeEl('div', 'margin-top:14px;text-align:center');

  const link = makeEl('a', [
    'color:rgba(255,255,255,0.28)',
    'font-size:11px',
    'text-decoration:none',
  ].join(';'));
  link.textContent = 'Buy me a coffee ☕';
  link.href = 'https://buymeacoffee.com/localization';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.addEventListener('mouseenter', () => { link.style.color = 'rgba(255,255,255,0.55)'; });
  link.addEventListener('mouseleave', () => { link.style.color = 'rgba(255,255,255,0.28)'; });

  footer.appendChild(link);
  return footer;
}

// --- Show / hide / toggle ---

async function showOverlay() {
  if (overlay || overlayBuilding) return;
  overlayBuilding = true;

  try {
    const [mappings, mode] = await Promise.all([
      window.NCCMappings.loadMappings(),
      window.NCCMappings.loadJoystickMode(),
    ]);
    overlayMappings = mappings ?? {};

    const panel = makeEl('div', [
      'position:fixed',
      'top:50%',
      'left:50%',
      'transform:translate(-50%,-50%)',
      'z-index:2147483647',
      'background:#141414',
      'color:#fff',
      'border-radius:8px',
      'padding:28px 32px 24px',
      'min-width:580px',
      'max-height:90vh',
      'overflow-y:auto',
      'box-shadow:0 8px 40px rgba(0,0,0,0.85)',
      'font-family:"Netflix Sans","Helvetica Neue",Helvetica,Arial,sans-serif',
    ].join(';'));
    panel.id = 'ncc-overlay';

    const title = makeEl('h2', 'margin:0;font-size:20px;font-weight:700;letter-spacing:0.01em');
    title.textContent = 'Controller Settings';

    const closeBtn = makeEl('button', [
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
    ].join(';'));
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('mouseover', () => { closeBtn.style.opacity = '1'; });
    closeBtn.addEventListener('mouseout',  () => { closeBtn.style.opacity = '0.7'; });
    closeBtn.addEventListener('click', hideOverlay);

    overlayGrid = buildGrid(overlayMappings);

    panel.appendChild(title);
    panel.appendChild(closeBtn);
    panel.appendChild(overlayGrid);
    panel.appendChild(buildModeSection(mode ?? 'arrows'));
    panel.appendChild(buildResetSection());
    panel.appendChild(buildFooter());

    overlay = panel;
    document.body.appendChild(overlay);
  } finally {
    overlayBuilding = false;
  }
}

function hideOverlay() {
  if (!overlay) return;
  listeningForKey  = null;
  onButtonCaptured = null;
  overlay.remove();
  overlay           = null;
  overlayGrid       = null;
  overlayModeSelect = null;
  refreshConfig();
}

function toggleOverlay() {
  overlay ? hideOverlay() : showOverlay();
}

} // end IS_TOP_FRAME overlay block

// Backtick keyboard toggle — runs in all frames.
// Top frame: toggle overlay. Child frames: bubble intent up to the top frame.
document.addEventListener('keydown', (e) => {
  if (e.key !== '`' || document.fullscreenElement === null) return;
  if (IS_TOP_FRAME) {
    toggleOverlay();
  } else {
    window.top.postMessage({ type: 'nccToggle' }, '*');
  }
});

if (IS_TOP_FRAME) {
  // Messages from background service worker
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ping') {
      sendResponse({ status: 'ready' });
    } else if (msg.type === 'toggleOverlay') {
      toggleOverlay();
    }
  });

  // Relay nccToggle posted by the backtick handler in child frames
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'nccToggle') toggleOverlay();
  });
}
