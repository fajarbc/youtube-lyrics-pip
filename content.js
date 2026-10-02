(() => {
  if (window.__youtubeLyricsPipLoaded) return;
  window.__youtubeLyricsPipLoaded = true;

  const NOISE_PATTERNS = [
    /\s*[\[(](?:official\s*)?(?:music\s*)?video[^\])]*[\])]/gi,
    /\s*[\[(](?:official\s*)?audio[^\])]*[\])]/gi,
    /\s*[\[(]lyrics?(?:\s*video)?[^\])]*[\])]/gi,
    /\s*[\[(]visuali[sz]er[^\])]*[\])]/gi,
    /\s*[\[(](?:hq|hd|4k|8k)[^\])]*[\])]/gi,
    /\s*[\[(](?:explicit|clean)(?:\s*version)?[^\])]*[\])]/gi,
    /\s*[\[(](?:live|remaster(?:ed)?|original)[^\])]*[\])]/gi,
    /\s*[-–—|]\s*(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?).*$/gi
  ];

  const FAB_SETTINGS_DEFAULTS = { fabCollapsed: false };

  let video = null;
  let lastUrl = location.href;
  let lastMetadataKey = "";
  let sendTimer = null;
  let urlTimer = null;
  let fullscreenRecheckTimer = null;
  let mediaMetadataListenersBound = false;
  let activePipBridge = null;
  let extensionInvalidated = false;
  let fabCollapsed = FAB_SETTINGS_DEFAULTS.fabCollapsed;

  function isContextInvalidatedError(error) {
    return /context invalidated/i.test(error?.message || "");
  }

  function handleExtensionInvalidated() {
    if (extensionInvalidated) return;
    extensionInvalidated = true;

    console.warn(
      "[YouTube Lyrics PiP] The extension was reloaded. Reload this page to re-enable it."
    );

    clearTimeout(sendTimer);
    clearTimeout(fullscreenRecheckTimer);
    clearInterval(urlTimer);
    observer?.disconnect();
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    pipTriggerButton?.remove();
    pipTriggerButton = null;
  }

  function cleanText(value = "") {
    let text = String(value)
      .replace(/\s+/g, " ")
      .replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, "")
      .trim();

    for (const pattern of NOISE_PATTERNS) text = text.replace(pattern, "");
    return text.replace(/\s+/g, " ").trim();
  }

  function cleanArtist(value = "") {
    return cleanText(value)
      .replace(/\s*[-–—|]\s*topic$/i, "")
      .replace(/\s+vevo$/i, "")
      .replace(/\s+official$/i, "")
      .trim();
  }

  function splitTitle(rawTitle, rawArtist) {
    const title = cleanText(rawTitle);
    let artist = cleanArtist(rawArtist);

    if (!artist) {
      const match = title.match(/^(.+?)\s[-–—]\s(.+)$/);
      if (match) {
        artist = cleanArtist(match[1]);
        return { title: cleanText(match[2]), artist };
      }
    }

    return { title, artist };
  }

  function textFrom(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.textContent?.trim();
      if (value) return value;
    }
    return "";
  }

  function getDomMetadata() {
    const isMusic = location.hostname === "music.youtube.com";

    const rawTitle = isMusic
      ? textFrom([
          "ytmusic-player-bar .title.ytmusic-player-bar",
          "ytmusic-player-bar .title",
          "yt-formatted-string.title"
        ])
      : textFrom([
          "h1.ytd-watch-metadata yt-formatted-string",
          "#title h1 yt-formatted-string",
          "h1.title"
        ]);

    const rawArtist = isMusic
      ? textFrom([
          "ytmusic-player-bar .byline.ytmusic-player-bar a",
          "ytmusic-player-bar .byline a",
          "ytmusic-player-bar .byline"
        ])
      : textFrom([
          "#owner #channel-name a",
          "ytd-video-owner-renderer #channel-name a",
          "#upload-info #channel-name a"
        ]);

    return splitTitle(rawTitle || document.title.replace(/\s*-\s*YouTube.*$/i, ""), rawArtist);
  }

  function getMetadata() {
    const media = navigator.mediaSession?.metadata;
    if (media?.title) {
      const normalized = splitTitle(media.title, media.artist);
      if (normalized.title) return normalized;
    }
    return getDomMetadata();
  }

  function getArtwork() {
    const mediaArtwork = navigator.mediaSession?.metadata?.artwork;
    if (Array.isArray(mediaArtwork) && mediaArtwork.length) {
      return mediaArtwork[mediaArtwork.length - 1]?.src || "";
    }

    const videoId = new URL(location.href).searchParams.get("v");
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
  }

  function getState() {
    const currentVideo = video || document.querySelector("video");
    const metadata = getMetadata();
    const finiteDuration = Number.isFinite(currentVideo?.duration)
      ? currentVideo.duration
      : 0;

    return {
      title: metadata.title || "Unknown title",
      artist: metadata.artist || "Unknown artist",
      artwork: getArtwork(),
      currentTime: Number.isFinite(currentVideo?.currentTime)
        ? currentVideo.currentTime
        : 0,
      duration: finiteDuration,
      paused: currentVideo ? currentVideo.paused : true,
      url: location.href
    };
  }

  function sendState(immediate = false) {
    clearTimeout(sendTimer);

    const dispatch = () => {
      if (extensionInvalidated) return;
      const state = getState();
      lastMetadataKey = `${state.title}|${state.artist}|${state.duration}|${state.url}`;
      try {
        chrome.runtime.sendMessage({ type: "YT_STATE", payload: state }).catch((error) => {
          if (isContextInvalidatedError(error)) handleExtensionInvalidated();
        });
      } catch (error) {
        if (isContextInvalidatedError(error)) handleExtensionInvalidated();
      }
    };

    if (immediate) dispatch();
    else sendTimer = setTimeout(dispatch, 100);
  }

  function onVideoEvent(event) {
    sendState(event.type !== "timeupdate");
  }

  function bindVideo(nextVideo) {
    if (!nextVideo || nextVideo === video) return;

    if (video) {
      ["timeupdate", "play", "pause", "durationchange", "loadedmetadata", "ended"].forEach(
        (eventName) => video.removeEventListener(eventName, onVideoEvent)
      );
    }

    video = nextVideo;
    ["timeupdate", "play", "pause", "durationchange", "loadedmetadata", "ended"].forEach(
      (eventName) => video.addEventListener(eventName, onVideoEvent, { passive: true })
    );

    sendState(true);
  }

  function discoverVideo() {
    bindVideo(document.querySelector("video"));
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      } catch (error) {
        if (isContextInvalidatedError(error)) handleExtensionInvalidated();
        reject(error);
      }
    });
  }

  let pipTriggerButton = null;

  // True while YouTube / YouTube Music is showing a video in fullscreen.
  // The browser Fullscreen API is the primary signal; the player class is a
  // fallback for cases where YouTube toggles its own fullscreen UI state.
  function isFullscreen() {
    return Boolean(
      document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.querySelector(".html5-video-player.ytp-fullscreen")
    );
  }

  function updatePipTriggerVisibility() {
    if (!pipTriggerButton) return;
    pipTriggerButton.style.display = isFullscreen() ? "none" : "inline-flex";
  }

  function onFullscreenChange() {
    updatePipTriggerVisibility();
    // YouTube updates its player classes slightly after the fullscreen event,
    // so re-check once more after the transition settles.
    clearTimeout(fullscreenRecheckTimer);
    fullscreenRecheckTimer = setTimeout(updatePipTriggerVisibility, 300);
  }

  function applyPipTriggerAppearance() {
    if (!pipTriggerButton) return;

    const label = pipTriggerButton.querySelector(".yt-lyrics-pip-label");
    const logo = pipTriggerButton.querySelector(".yt-lyrics-pip-logo");
    const iconSize = fabCollapsed ? 22 : 16;

    pipTriggerButton.dataset.collapsed = String(fabCollapsed);
    pipTriggerButton.title = fabCollapsed ? "Open Lyrics PiP" : "";
    pipTriggerButton.style.gap = fabCollapsed ? "0" : "8px";
    pipTriggerButton.style.padding = fabCollapsed ? "10px" : "10px 18px";
    pipTriggerButton.style.justifyContent = "center";
    if (label) label.style.display = fabCollapsed ? "none" : "";
    if (logo) {
      logo.style.width = `${iconSize}px`;
      logo.style.height = `${iconSize}px`;
      logo.style.fontSize = `${iconSize - 4}px`;
    }

    updatePipTriggerVisibility();
  }

  function createPipTriggerButton() {
    const button = document.createElement("button");
    button.id = "yt-lyrics-pip-trigger";
    button.type = "button";
    button.setAttribute("aria-label", "Open Lyrics PiP");
    button.style.cssText = [
      "position: fixed",
      "z-index: 2147483647",
      "right: 24px",
      "bottom: 24px",
      "display: inline-flex",
      "align-items: center",
      "gap: 8px",
      "padding: 10px 18px",
      "border: 0",
      "border-radius: 999px",
      "background: #1ed760",
      "color: #071109",
      'font: 750 13px/1 Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
      "cursor: pointer",
      "box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35)",
      "transition: transform 120ms ease"
    ].join(";");

    const logo = document.createElement("img");
    logo.className = "yt-lyrics-pip-logo";
    logo.src = chrome.runtime.getURL("logo.png");
    logo.alt = "";
    logo.style.cssText = "width: 16px; height: 16px; border-radius: 4px; object-fit: cover; flex: 0 0 auto;";
    logo.addEventListener(
      "error",
      () => {
        // Keep an icon visible (important when the button is collapsed).
        const fallback = document.createElement("span");
        fallback.className = "yt-lyrics-pip-logo";
        fallback.textContent = "🎵";
        fallback.setAttribute("aria-hidden", "true");
        fallback.style.cssText =
          "display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; line-height: 1; flex: 0 0 auto;";
        logo.replaceWith(fallback);
        applyPipTriggerAppearance();
      },
      { once: true }
    );
    button.appendChild(logo);

    const label = document.createElement("span");
    label.className = "yt-lyrics-pip-label";
    label.textContent = "Lyrics PiP";
    button.appendChild(label);

    button.addEventListener("mouseenter", () => {
      button.style.transform = "scale(1.04)";
    });
    button.addEventListener("mouseleave", () => {
      button.style.transform = "scale(1)";
    });
    button.addEventListener("click", openFloatingPlayer);
    return button;
  }

  function ensurePipTriggerButton() {
    if (!document.body) return;
    if (pipTriggerButton && document.body.contains(pipTriggerButton)) return;
    pipTriggerButton = createPipTriggerButton();
    document.body.appendChild(pipTriggerButton);
    applyPipTriggerAppearance();
  }

  function setFabCollapsed(nextValue) {
    fabCollapsed = Boolean(nextValue);
    applyPipTriggerAppearance();
  }

  function loadFabSettings() {
    try {
      chrome.storage?.sync?.get(FAB_SETTINGS_DEFAULTS, (settings) => {
        if (chrome.runtime.lastError) return;
        setFabCollapsed(settings?.fabCollapsed);
      });

      chrome.storage?.onChanged?.addListener((changes, areaName) => {
        if (areaName === "sync" && changes.fabCollapsed) {
          setFabCollapsed(changes.fabCollapsed.newValue);
        }
      });
    } catch (error) {
      if (isContextInvalidatedError(error)) handleExtensionInvalidated();
    }
  }

  function highlightPipTriggerButton() {
    ensurePipTriggerButton();
    if (!pipTriggerButton) return false;

    pipTriggerButton.scrollIntoView({ behavior: "smooth", block: "center" });
    pipTriggerButton.animate(
      [
        { boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)" },
        { boxShadow: "0 0 0 10px rgba(30, 215, 96, 0.35)" },
        { boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)" }
      ],
      { duration: 900, iterations: 2 }
    );
    return true;
  }

  function createPipBridge(pipWindow, targetTabId) {
    const channel = new MessageChannel();
    const port = channel.port1;

    port.onmessage = (event) => {
      const message = event.data;
      if (!message) return;

      if (message.type === "RUNTIME_MESSAGE") {
        try {
          chrome.runtime.sendMessage(message.payload, (response) => {
            const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
            port.postMessage({
              type: "RUNTIME_RESPONSE",
              requestId: message.requestId,
              response,
              error
            });
          });
        } catch (error) {
          if (isContextInvalidatedError(error)) handleExtensionInvalidated();
          port.postMessage({
            type: "RUNTIME_RESPONSE",
            requestId: message.requestId,
            response: null,
            error: error.message
          });
        }
      }
    };

    port.start();

    return {
      sendInit() {
        pipWindow.postMessage({ type: "PIP_INIT", targetTabId }, "*", [channel.port2]);
      },
      forwardBroadcast(message) {
        port.postMessage({ type: "BROADCAST", payload: message });
      },
      dispose() {
        port.close();
      }
    };
  }

  async function openFloatingPlayer() {
    if (!pipTriggerButton) return;

    const labelElement = pipTriggerButton.querySelector(".yt-lyrics-pip-label");
    const originalLabel = labelElement ? labelElement.textContent : "";
    pipTriggerButton.disabled = true;
    if (labelElement) labelElement.textContent = "Opening…";
    let pipWindow = null;

    try {
      if (!("documentPictureInPicture" in window)) {
        throw new Error("This Chrome version does not support the Document Picture-in-Picture API.");
      }

      if (window.documentPictureInPicture.window) {
        window.documentPictureInPicture.window.close();
      }

      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 380,
        height: 500
      });

      discoverVideo();
      sendState(true);

      const target = await sendRuntimeMessage({ type: "GET_TARGET_TAB" });
      if (!target?.ok) {
        throw new Error("Play a song in this tab first.");
      }

      const response = await fetch(chrome.runtime.getURL("pip.html"));
      if (!response.ok) throw new Error("Failed to load the floating player view.");

      let html = await response.text();
      html = html
        .replace('href="pip.css"', `href="${chrome.runtime.getURL("pip.css")}"`)
        .replace('src="logo.png"', `src="${chrome.runtime.getURL("logo.png")}"`);

      pipWindow.document.open();
      pipWindow.document.write(html);
      pipWindow.document.close();

      const bootstrap = () => {
        const script = pipWindow.document.createElement("script");
        script.src = chrome.runtime.getURL("pip.js");
        script.dataset.extensionScript = "true";
        script.addEventListener(
          "load",
          () => {
            activePipBridge?.dispose();
            activePipBridge = createPipBridge(pipWindow, target.tabId);
            activePipBridge.sendInit();
          },
          { once: true }
        );
        pipWindow.document.body.appendChild(script);
      };

      if (pipWindow.document.readyState === "loading") {
        pipWindow.document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
      } else {
        bootstrap();
      }

      pipWindow.addEventListener(
        "pagehide",
        () => {
          if (pipTriggerButton) pipTriggerButton.disabled = false;
          activePipBridge?.dispose();
          activePipBridge = null;
        },
        { once: true }
      );
    } catch (error) {
      pipWindow?.close();
      window.alert(error.message);
    } finally {
      if (pipTriggerButton) {
        pipTriggerButton.disabled = false;
        const currentLabel = pipTriggerButton.querySelector(".yt-lyrics-pip-label");
        if (currentLabel) currentLabel.textContent = originalLabel;
      }
    }
  }

  async function executeCommand(command, value) {
    discoverVideo();
    if (!video) throw new Error("Could not find the YouTube video element.");

    switch (command) {
      case "TOGGLE":
        if (video.paused) await video.play();
        else video.pause();
        break;
      case "PLAY":
        await video.play();
        break;
      case "PAUSE":
        video.pause();
        break;
      case "SEEK": {
        const nextTime = Number(value);
        if (Number.isFinite(nextTime)) {
          video.currentTime = Math.max(0, Math.min(nextTime, video.duration || nextTime));
        }
        break;
      }
      case "JUMP": {
        const offset = Number(value);
        if (Number.isFinite(offset)) {
          video.currentTime = Math.max(
            0,
            Math.min(video.currentTime + offset, video.duration || Infinity)
          );
        }
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }

    sendState(true);
    return getState();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_STATE") {
      discoverVideo();
      sendResponse({ ok: true, state: getState() });
      return;
    }

    if (message?.type === "PLAYER_COMMAND") {
      executeCommand(message.command, message.value)
        .then((state) => sendResponse({ ok: true, state }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "HIGHLIGHT_PIP_BUTTON") {
      sendResponse({ ok: highlightPipTriggerButton() });
      return;
    }

    if (message?.type === "PLAYER_STATE") {
      activePipBridge?.forwardBroadcast(message);
      return;
    }
  });

  const observer = new MutationObserver(() => {
    discoverVideo();
    const state = getState();
    const key = `${state.title}|${state.artist}|${state.duration}|${state.url}`;
    if (key !== lastMetadataKey) sendState();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  if (!mediaMetadataListenersBound && navigator.mediaSession) {
    mediaMetadataListenersBound = true;
    document.addEventListener("visibilitychange", () => sendState(true));
  }

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  urlTimer = setInterval(() => {
    discoverVideo();
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastMetadataKey = "";
      setTimeout(() => sendState(true), 500);
    }
  }, 750);

  window.addEventListener("pagehide", () => clearInterval(urlTimer), { once: true });
  discoverVideo();
  sendState(true);
  ensurePipTriggerButton();
  loadFabSettings();
})();
