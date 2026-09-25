const youtubeTabs = new Map();
let targetTabId = null;
let pipHostTabId = null;

function isYouTubeUrl(url = "") {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "youtube.com" || hostname.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function chooseTargetTab() {
  const entries = [...youtubeTabs.entries()];
  const playing = entries
    .filter(([, state]) => state && !state.paused)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));

  if (playing.length) return playing[0][0];

  const recent = entries.sort(
    (a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)
  );
  return recent[0]?.[0] ?? null;
}

async function resolveTargetTab(preferredTabId) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (isYouTubeUrl(tab.url)) return preferredTabId;
    } catch {
      // Tab already closed.
    }
  }

  if (Number.isInteger(targetTabId)) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      if (isYouTubeUrl(tab.url)) return targetTabId;
    } catch {
      // Look for another target.
    }
  }

  const selected = chooseTargetTab();
  if (selected !== null) return selected;

  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (activeTab && isYouTubeUrl(activeTab.url)) return activeTab.id;

  const tabs = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
  return tabs[0]?.id ?? null;
}

async function askContent(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "YT_STATE" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    const state = {
      ...message.payload,
      tabId,
      updatedAt: Date.now()
    };

    youtubeTabs.set(tabId, state);
    if (!state.paused || targetTabId === null) targetTabId = tabId;

    chrome.runtime
      .sendMessage({ type: "PLAYER_STATE", payload: state })
      .catch(() => {});

    if (pipHostTabId != null && tabId === targetTabId) {
      chrome.tabs
        .sendMessage(pipHostTabId, { type: "PLAYER_STATE", payload: state })
        .catch(() => {});
    }

    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "PIP_READY") {
    (async () => {
      const tabId = await resolveTargetTab(message.tabId);
      if (tabId === null) {
        sendResponse({
          ok: false,
          error: "Open YouTube or YouTube Music and play a video first."
        });
        return;
      }

      targetTabId = tabId;
      if (sender.tab?.id != null) pipHostTabId = sender.tab.id;
      let state = youtubeTabs.get(tabId);

      try {
        const response = await askContent(tabId, { type: "GET_STATE" });
        if (response?.state) {
          state = { ...response.state, tabId, updatedAt: Date.now() };
          youtubeTabs.set(tabId, state);
        }
      } catch {
        // Cached state can still be used if available.
      }

      sendResponse({ ok: true, tabId, state: state || null });
    })().catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "PIP_COMMAND") {
    if (sender.tab?.id != null) pipHostTabId = sender.tab.id;
    (async () => {
      const tabId = await resolveTargetTab(message.tabId);
      if (tabId === null) throw new Error("YouTube tab not found.");

      targetTabId = tabId;
      const response = await askContent(tabId, {
        type: "PLAYER_COMMAND",
        command: message.command,
        value: message.value
      });

      sendResponse({ ok: true, tabId, response });
    })().catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message?.type === "GET_TARGET_TAB") {
    if (sender.tab?.id != null) pipHostTabId = sender.tab.id;
    resolveTargetTab(message.tabId)
      .then((tabId) => sendResponse({ ok: tabId !== null, tabId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  youtubeTabs.delete(tabId);
  if (targetTabId === tabId) targetTabId = chooseTargetTab();
  if (pipHostTabId === tabId) pipHostTabId = null;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !isYouTubeUrl(changeInfo.url || tab.url)) {
    youtubeTabs.delete(tabId);
    if (targetTabId === tabId) targetTabId = chooseTargetTab();
  }
});
