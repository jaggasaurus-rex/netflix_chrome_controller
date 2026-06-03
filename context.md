# Netflix Controller — Project Context

## What this is

A Chrome extension (Manifest V3) that injects into Netflix pages on demand and maps Xbox gamepad input to keyboard events, enabling controller navigation of the Netflix UI and player. Includes an in-page settings overlay for remapping buttons and choosing a joystick mode.

---

## File structure

```
manifest.json    — MV3 extension manifest
background.js    — Service worker: on-demand injection + overlay toggle
mappings.js      — Storage layer: button mappings + joystick mode
content.js       — All runtime logic: polling loop, input dispatch, overlay UI
context.md       — This file
```

---

## manifest.json

- Permissions: `activeTab`, `storage`, `scripting`
- Background service worker: `background.js`
- `"action": {}` with no `default_popup` — required for `chrome.action.onClicked` to fire
- **No `content_scripts` block** — scripts are injected on demand by the service worker, not on page load

---

## background.js

Handles icon clicks with a ping-then-inject pattern:

1. Send `{ type: 'ping' }` to the active tab (top frame only — no `frameId`) and await a response
2. **If ping succeeds** (content script already running): send `{ type: 'toggleOverlay' }`
3. **If ping throws** (content script not yet injected): inject `mappings.js` first, then `content.js` (order matters — `content.js` depends on `window.NCCMappings`), then send `{ type: 'toggleOverlay' }`

Both `executeScript` calls use **`allFrames: true`** so the scripts are injected into every frame of the tab, including cross-origin iframes. The ping and `toggleOverlay` messages still target the top frame only (Chrome's default when no `frameId` is specified).

The `chrome.tabs.sendMessage` rejection is the injection-state signal — no extra bookkeeping needed.

---

## mappings.js

Runs as an IIFE. Exposes everything on `window.NCCMappings` since content scripts can't use ES module imports.

**Storage keys:**
- `ncc_mappings` — flat object `{ storageKeyName: buttonIndex }`, e.g. `{ enter: 0, escape: 1 }`
- `ncc_joystick_mode` — string: `'arrows'` | `'wasd'` | `'mouse'`

**Valid remappable key names** (13 total):
`enter`, `escape`, `space`, `f`, `backspace`, `w`, `a`, `s`, `d`, `arrowup`, `arrowdown`, `arrowleft`, `arrowright`

**Default mappings** (written on first install only, if storage is empty):
- `enter → 0` (A), `escape → 1` (B), `space → 2` (X), `f → 3` (Y)
- All other keys start unassigned
- Default joystick mode: `arrows`

**Uniqueness invariant:** A button index may appear on at most one key. `assignButton(key, index)` removes the index from any other key before writing.

**Exposed API on `window.NCCMappings`:**
```
VALID_KEYS             — ordered array of valid key name strings
VALID_JOYSTICK_MODES   — ['wasd', 'arrows', 'mouse']
loadMappings()         → Promise<object|null>
saveMappings(obj)      → Promise<void>
assignButton(key, buttonIndex) → Promise<updatedMappings>
clearButton(key)       → Promise<updatedMappings>
loadJoystickMode()     → Promise<string|null>
saveJoystickMode(mode) → Promise<void>
resetToDefaults()      → Promise<{ mappings, mode }>
```

`loadMappings()` returns `null` (not `{}`) when storage has never been written, so callers can distinguish first-run from an empty assignment set.

`resetToDefaults()` writes both storage keys atomically in a single `storage.set` call and returns the canonical default values so the caller never hardcodes them.

---

## content.js

### Frame awareness

`const IS_TOP_FRAME = window === window.top` is defined at the top of the script and used throughout to gate frame-specific behavior:

- **Polling loop, `fireKey`, `fireMouseMove`**: run in **all frames**. Each frame's instance dispatches events on its own `document`, which is the correct target for whichever frame hosts the game.
- **Overlay** (all DOM, state variables, show/hide/toggle functions, mode dropdown, reset button, footer): runs in the **top frame only**, wrapped in `if (IS_TOP_FRAME)`.
- **`chrome.runtime.onMessage` listener** (`ping` + `toggleOverlay`): top frame only.
- **Backtick keydown listener**: runs in **all frames**. In the top frame it calls `toggleOverlay()`; in child frames it posts `{ type: 'nccToggle' }` to `window.top`.
- **`window.message` listener**: top frame only. Receives `nccToggle` from child frames and calls `toggleOverlay()`.

### Xbox controller button index reference (W3C standard gamepad mapping)
```
0:A  1:B  2:X  3:Y  4:LB  5:RB  6:LT  7:RT
8:Back  9:Start  10:L3  11:R3
12:D-Up  13:D-Down  14:D-Left  15:D-Right  16:Home
```

### Button categories

**Remappable face buttons** — runtime lookup via `remappableButtonMap` (inverted from storage):
Default: A(0)→Enter, B(1)→Escape, X(2)→Space, Y(3)→F

**Fixed/non-remappable aliases** — hardcoded in `FIXED_BUTTON_MAP`, never user-configurable:
- LB(4) → ArrowLeft (rewind 10s)
- RB(5) → ArrowRight (fast forward 10s)
- Back(8) → Escape
- Start(9) → Space (play/pause)

**Directional inputs** — D-pad (12–15) and left analog stick both feed the same unified direction system. Output depends on `joystickMode`:
- `arrows`: fire ArrowUp / ArrowDown / ArrowLeft / ArrowRight
- `wasd`: fire w / a / s / d
- `mouse`: dispatch synthetic `mousemove` events

### Polling loop

Uses `requestAnimationFrame`. Starts once on `gamepadconnected` or on script load if a gamepad is already connected. Never stops (overhead is negligible when no gamepad is present).

Config (`remappableButtonMap`, `joystickMode`) is loaded from storage once at startup via `refreshConfig()` and refreshed each time the overlay closes.

**Edge detection:** `prevButtonState` map tracks `"${gpIndex}-${btnIndex}" → boolean`. Events fire only on press/release transitions, not every frame.

**Analog stick deadzone:** `0.2` — axis value must exceed this magnitude before the direction is treated as active.

**Analog stick auto-repeat:** on first deflection past deadzone, fires `keydown` immediately, waits `400ms`, then repeats every `150ms` while held.

**Mouse mode (stick):** fires `mousemove` every frame, scaled by `Math.abs(axisValue) * 10` pixels. Tracks `virtualMouseX/Y` so `clientX/Y` and `movementX/Y` stay consistent.

**Mouse mode (d-pad):** fires a single `mousemove` of `10px` on button-press edge only (no auto-repeat — d-pad is digital).

### Remapping capture (listening mode)

When the overlay is waiting for a button press (`listeningForKey !== null`):
- The button `forEach` loop intercepts at the top, skips all game input dispatch, and routes the first new press edge to `onButtonCaptured(btnIndex)`.
- The stick loop returns early.
- `onButtonCaptured` calls `assignButton`, updates `overlayMappings`, rebuilds the grid DOM, and calls `refreshConfig()` to sync the polling loop.

### Message listener (top frame only)

Handles two message types from `background.js`:
- `ping` — calls `sendResponse({ status: 'ready' })` immediately, then explicitly `return false` to close the message channel synchronously
- `toggleOverlay` — calls `toggleOverlay()`

### Overlay (top frame only)

Toggled by:
1. Backtick (`` ` ``) keydown — **only fires when `document.fullscreenElement !== null`**; works from any frame (child frames relay via `postMessage`)
2. Extension icon click → `background.js` ping/inject → `{ type: 'toggleOverlay' }` message

`showOverlay()` is async: loads mappings + joystick mode from storage before building DOM (no empty-state flash). `overlayBuilding` flag prevents double-build on rapid double-click.

**Grid:** two-column CSS grid (`grid-auto-flow: column`, 7 rows per column), distributing the 13 keys with the first 7 in the left column and the last 6 in the right. Each row shows the key label and a chip button. The chip displays the assigned button index using friendly labels: D-pad indices 12–15 show `D-Up` / `D-Down` / `D-Left` / `D-Right`; all other indices show `Button N`; unassigned shows `Unassigned`. The `buttonLabel(index)` helper is used consistently in both initial render (`buildRow`) and listening-cancel restore (`resetChip`). Clicking a chip enters listening mode for that key. Clicking a second chip cancels the first. Clicking the active chip cancels it.

**Joystick mode dropdown:** below the grid. Saves to storage immediately on change via `saveJoystickMode` + `refreshConfig`. The select element is stored in `overlayModeSelect` so the reset handler can update it without rebuilding the section.

**Reset to Default button:** below the joystick dropdown. Calls `resetToDefaults()` (defined in mappings.js — default values are not hardcoded in content.js), then updates `overlayMappings`, rebuilds the grid, and sets `overlayModeSelect.value` from the return value.

**Footer:** centered link — "Buy me a coffee ☕" → `https://buymeacoffee.com/localization`, opens in new tab. Font size `12px`, color `rgba(255,180,50,0.7)` (warm amber at mid opacity) at rest; lifts to `rgba(255,180,50,1)` on hover.

**On close:** cancels any in-progress listening, nulls `overlayModeSelect`, calls `refreshConfig()` to sync game input with any changes made in the session.

---

## Data flow summary

```
chrome.storage.local
       │
       ▼
  mappings.js (window.NCCMappings)
       │
       ├── on load: initDefaults(), exposes API
       │
       ▼                              icon click
  content.js  ◄────────────────────  background.js
       │                              (ping → inject if needed → toggleOverlay)
       │
       ├── startup: refreshConfig() → remappableButtonMap, joystickMode
       │
       ├── pollGamepads() [rAF loop]
       │     ├── listeningForKey set? → capture mode (suppress game input)
       │     ├── FIXED_BUTTON_MAP → fireKey()
       │     ├── remappableButtonMap → fireKey()
       │     ├── DPAD_DIR + joystickMode → fireKey() or fireMouseMove()
       │     └── STICK_AXES + joystickMode → fireKey() or fireMouseMove()
       │
       └── overlay
             ├── open: load storage → build grid + dropdown
             ├── row click → listening → onButtonCaptured → assignButton → rebuild grid
             ├── dropdown change → saveJoystickMode → refreshConfig
             ├── reset click → resetToDefaults → rebuild grid + sync dropdown
             └── close → refreshConfig
```

---

## Known gaps / not yet built

- No way to clear an assignment back to "Unassigned" from the UI (only reassigning is supported; `clearButton` exists in mappings.js but has no UI trigger)
- Triggers (LT/RT, buttons 6–7) are unhandled
- No visual feedback that a gamepad is/isn't connected
- Right stick (axes 2–3) unused
- Synthetic events are dispatched on `document` in each frame; shadow DOM listeners inside a frame won't be reached
