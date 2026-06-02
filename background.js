chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    // Content script already running — just toggle the overlay
    chrome.tabs.sendMessage(tab.id, { type: 'toggleOverlay' });
  } catch {
    // Content script not yet injected — inject in dependency order, then toggle
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['mappings.js'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    chrome.tabs.sendMessage(tab.id, { type: 'toggleOverlay' });
  }
});
