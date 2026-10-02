const openButton = document.getElementById("openPip");
const statusElement = document.getElementById("status");
const logoElement = document.getElementById("logo");
const collapseFabToggle = document.getElementById("collapseFab");

const FAB_SETTINGS_DEFAULTS = { fabCollapsed: false };

logoElement?.addEventListener("error", () => logoElement.remove(), { once: true });

chrome.storage.sync.get(FAB_SETTINGS_DEFAULTS, (settings) => {
  if (chrome.runtime.lastError) return;
  collapseFabToggle.checked = Boolean(settings.fabCollapsed);
});

collapseFabToggle.addEventListener("change", () => {
  statusElement.textContent = "";
  chrome.storage.sync.set({ fabCollapsed: collapseFabToggle.checked }, () => {
    if (chrome.runtime.lastError) {
      statusElement.textContent = chrome.runtime.lastError.message;
    }
  });
});

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

openButton.addEventListener("click", async () => {
  openButton.disabled = true;
  statusElement.textContent = "";

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = activeTab?.url || "";
    const isYouTube = /^https?:\/\/([^.]+\.)?youtube\.com\//i.test(url);

    if (!isYouTube) {
      throw new Error("Open a YouTube or YouTube Music tab first.");
    }

    const response = await sendTabMessage(activeTab.id, { type: "HIGHLIGHT_PIP_BUTTON" });
    if (response?.reason === "no-media") {
      throw new Error("Open a video or start a song first. The button only shows where something can play.");
    }
    if (!response?.ok) {
      throw new Error("Reload the YouTube page, then try again.");
    }

    window.close();
  } catch (error) {
    statusElement.textContent = error.message;
  } finally {
    openButton.disabled = false;
  }
});
