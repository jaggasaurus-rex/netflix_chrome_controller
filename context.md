# Netflix Controller — Project Context

## What this is

A Chrome extension (Manifest V3) that loads on Netflix pages and maps Xbox gamepad input to keyboard events, enabling controller navigation of the Netflix UI and player. Includes an in-page settings overlay for remapping buttons and choosing a joystick mode.

---

## File structure

```
manifest.json    — MV3 extension manifest
background.js    — Service worker: forwards icon clicks to content script
mappings.js      — Storage layer: button mappings + joystick mode (loads before content.js)
content.js       — All runtime logic: polling loop, input dispatch, overlay UI
```

---

## manifest.json

- Permissions: `activeTab`, `storage`
- Background service worker: `background.js`
- `"action": {}` with no `default_popup` — required for `chrome.action.onClicked` to fire
- Content scripts match `*://*.netflix.com/*`, load order: `["mappings.js", "content.js"]`

---

## background.js

Single responsibility: listens for `chrome.action.onClicked` (extension icon click) and sends `{ type: 'toggleOverlay' }` to the active tab's content script.

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
VALID_KEYS           — ordered array of valid key name strings
VALID_JOYSTICK_MODES — ['wasd', 'arrows', 'mouse']
loadMappings()       → Promise<object|null>
saveMappings(obj)    → Promise<void>
assignButton(key, buttonIndex) → Promise<updatedMappings>
clearButton(key)     → Promise<updatedMappings>
loadJoystickMode()   → Promise<string|null>
saveJoystickMode(mode) → Promise<void>
```

`loadMappings()` returns `null` (not `{}`) when storage has never been written, so callers can distinguish first-run from an empty assignment set.

---

## content.js

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

Uses `requestAnimationFrame`. Starts once on `gamepadconnected` or on load if a gamepad is already connected. Never stops (overhead is negligible when no gamepad is present).

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

### Overlay

Toggled by:
1. Backtick (`` ` ``) keydown on `document`
2. Extension icon click → `background.js` → `chrome.runtime.onMessage` → `toggleOverlay()`

`showOverlay()` is async: loads mappings + joystick mode from storage before building DOM (no empty-state flash). `overlayBuilding` flag prevents double-build on rapid double-click.

**Grid:** one row per key in `VALID_KEYS` order. Each row shows the key label and a chip button displaying the assigned button index or "Unassigned". Clicking a chip enters listening mode for that key. Clicking a second chip cancels the first. Clicking the active chip cancels it.

**Joystick mode dropdown:** below the grid. Saves to storage immediately on change via `saveJoystickMode` + `refreshConfig`.

**On close:** cancels any in-progress listening, calls `refreshConfig()` to sync game input with any changes made in the session.

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
       ▼
  content.js
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
             └── close → refreshConfig
```

---

## Known gaps / not yet built

- No way to clear an assignment back to "Unassigned" from the UI (only reassigning is supported; `clearButton` exists in mappings.js but has no UI trigger)
- Triggers (LT/RT, buttons 6–7) are unhandled
- No visual feedback that a gamepad is/isn't connected
- Right stick (axes 2–3) unused
- All synthetic events are dispatched on `document`; if Netflix attaches listeners on a shadow DOM or iframe, they won't be reached
