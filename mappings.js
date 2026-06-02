// Manages controller button mappings and joystick mode via chrome.storage.local.
// Attached to window.NCCMappings so content.js can call these without ES modules.

(() => {
  const VALID_KEYS = [
    'enter', 'escape', 'space', 'f', 'backspace',
    'w', 'a', 's', 'd',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  ];

  const VALID_JOYSTICK_MODES = ['wasd', 'arrows', 'mouse'];

  const DEFAULT_MAPPINGS = {
    enter:  0,
    escape: 1,
    space:  2,
    f:      3,
  };

  const DEFAULT_JOYSTICK_MODE = 'arrows';

  const STORAGE_KEY_MAPPINGS = 'ncc_mappings';
  const STORAGE_KEY_JOYSTICK = 'ncc_joystick_mode';

  // --- Mappings ---

  function loadMappings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY_MAPPINGS, (result) => {
        resolve(result[STORAGE_KEY_MAPPINGS] ?? null);
      });
    });
  }

  function saveMappings(mappings) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY_MAPPINGS]: mappings }, resolve);
    });
  }

  async function assignButton(key, buttonIndex) {
    if (!VALID_KEYS.includes(key)) {
      throw new Error(`Invalid key: "${key}"`);
    }
    const mappings = (await loadMappings()) ?? {};
    // Remove this button index from any key that already has it
    for (const k of Object.keys(mappings)) {
      if (mappings[k] === buttonIndex) {
        delete mappings[k];
      }
    }
    mappings[key] = buttonIndex;
    await saveMappings(mappings);
    return mappings;
  }

  async function clearButton(key) {
    if (!VALID_KEYS.includes(key)) {
      throw new Error(`Invalid key: "${key}"`);
    }
    const mappings = (await loadMappings()) ?? {};
    delete mappings[key];
    await saveMappings(mappings);
    return mappings;
  }

  // --- Joystick mode ---

  function loadJoystickMode() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY_JOYSTICK, (result) => {
        resolve(result[STORAGE_KEY_JOYSTICK] ?? null);
      });
    });
  }

  function saveJoystickMode(mode) {
    if (!VALID_JOYSTICK_MODES.includes(mode)) {
      throw new Error(`Invalid joystick mode: "${mode}"`);
    }
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY_JOYSTICK]: mode }, resolve);
    });
  }

  // --- First-install defaults ---
  // Write defaults only if storage has no mappings/mode yet.

  async function initDefaults() {
    const [existingMappings, existingMode] = await Promise.all([
      loadMappings(),
      loadJoystickMode(),
    ]);
    const writes = {};
    if (existingMappings === null) {
      writes[STORAGE_KEY_MAPPINGS] = { ...DEFAULT_MAPPINGS };
    }
    if (existingMode === null) {
      writes[STORAGE_KEY_JOYSTICK] = DEFAULT_JOYSTICK_MODE;
    }
    if (Object.keys(writes).length > 0) {
      await new Promise((resolve) => chrome.storage.local.set(writes, resolve));
    }
  }

  initDefaults();

  window.NCCMappings = {
    VALID_KEYS,
    VALID_JOYSTICK_MODES,
    loadMappings,
    saveMappings,
    assignButton,
    clearButton,
    loadJoystickMode,
    saveJoystickMode,
  };
})();
