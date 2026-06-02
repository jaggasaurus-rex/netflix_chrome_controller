// Netflix Controller — maps Xbox gamepad input to keyboard events

const DEADZONE = 0.2;
const AXIS_REPEAT_DELAY = 400;    // ms before a held stick direction starts repeating
const AXIS_REPEAT_INTERVAL = 150; // ms between repeats once repeating starts

// Standard Xbox controller button indices (W3C standard mapping)
// 0:A  1:B  2:X  3:Y  4:LB  5:RB  6:LT  7:RT  8:Back  9:Start
// 10:L3  11:R3  12:DUp  13:DDown  14:DLeft  15:DRight  16:Home
const BUTTON_MAP = {
  0:  'Enter',       // A       — select / confirm
  1:  'Escape',      // B       — back
  2:  ' ',           // X       — play/pause
  3:  'f',           // Y       — toggle fullscreen
  4:  'ArrowLeft',   // LB      — rewind 10s
  5:  'ArrowRight',  // RB      — fast forward 10s
  8:  'Escape',      // Back    — back
  9:  ' ',           // Start   — play/pause
  12: 'ArrowUp',     // D-Up    — navigate up
  13: 'ArrowDown',   // D-Down  — navigate down
  14: 'ArrowLeft',   // D-Left  — navigate left
  15: 'ArrowRight',  // D-Right — navigate right
};

const KEY_TO_CODE = {
  ' ':           'Space',
  'Enter':       'Enter',
  'Escape':      'Escape',
  'f':           'KeyF',
  'm':           'KeyM',
  'ArrowUp':     'ArrowUp',
  'ArrowDown':   'ArrowDown',
  'ArrowLeft':   'ArrowLeft',
  'ArrowRight':  'ArrowRight',
};

// Left stick axes: [axisIndex, direction, key]
// Axis 0 = horizontal (left: -1, right: +1)
// Axis 1 = vertical   (up:   -1, down:  +1)
const STICK_DIRS = [
  [0, -1, 'ArrowLeft'],
  [0,  1, 'ArrowRight'],
  [1, -1, 'ArrowUp'],
  [1,  1, 'ArrowDown'],
];

const prevButtonState = new Map(); // `${gpIndex}-${btnIndex}` → boolean
const stickActive     = new Map(); // `${gpIndex}-${axis}-${dir}` → boolean
const stickTimers     = new Map(); // same key → setTimeout handle

let pollingActive = false;

function fireKey(key, type) {
  const event = new KeyboardEvent(type, {
    key,
    code: KEY_TO_CODE[key] ?? '',
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
}

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
      const key = BUTTON_MAP[i];
      if (!key) return;

      const id = `${gp.index}-${i}`;
      const wasPressed = prevButtonState.get(id) ?? false;

      if (btn.pressed !== wasPressed) {
        fireKey(key, btn.pressed ? 'keydown' : 'keyup');
        prevButtonState.set(id, btn.pressed);
      }
    });

    // --- Left analog stick with deadzone and auto-repeat ---
    STICK_DIRS.forEach(([axis, dir, key]) => {
      const id = `${gp.index}-${axis}-${dir}`;
      const raw = gp.axes[axis] ?? 0;
      // Active when the stick exceeds the deadzone in the relevant direction
      const active = dir > 0 ? raw > DEADZONE : raw < -DEADZONE;
      const wasActive = stickActive.get(id) ?? false;

      if (active && !wasActive) {
        stickActive.set(id, true);
        fireKey(key, 'keydown');
        // Initial delay before repeat starts
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

// Pick up gamepads that connected before the content script loaded
if ([...navigator.getGamepads()].some(Boolean)) {
  startPolling();
}
