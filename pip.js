(() => {
  let targetTabId = null;
  let port = null;
  let requestCounter = 0;
  const pendingRequests = new Map();

  const elements = {
    artwork: document.getElementById("artwork"),
    title: document.getElementById("title"),
    artist: document.getElementById("artist"),
    toggle: document.getElementById("toggle"),
    backward: document.getElementById("backward"),
    forward: document.getElementById("forward"),
    progress: document.getElementById("progress"),
    currentTime: document.getElementById("currentTime"),
    duration: document.getElementById("duration"),
    lyrics: document.getElementById("lyrics"),
    brandLogo: document.getElementById("brandLogo")
  };

  elements.brandLogo?.addEventListener("error", () => elements.brandLogo.remove(), { once: true });

  let state = {
    title: "Waiting for a song…",
    artist: "Open YouTube or YouTube Music",
    artwork: "",
    currentTime: 0,
    duration: 0,
    paused: true
  };

  let syncedLyrics = [];
  let activeLyricIndex = -1;
  let loadedTrackKey = "";
  let lyricsRequestId = 0;
  let seeking = false;

  function handlePortMessage(event) {
    const message = event.data;
    if (!message) return;

    if (message.type === "RUNTIME_RESPONSE") {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;
      pendingRequests.delete(message.requestId);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.response);
      return;
    }

    if (message.type === "BROADCAST") {
      onRuntimeMessage(message.payload);
    }
  }

  function waitForPort() {
    return new Promise((resolve) => {
      window.addEventListener("message", function handler(event) {
        const message = event.data;
        if (message?.type !== "PIP_INIT") return;

        window.removeEventListener("message", handler);
        targetTabId = message.targetTabId ?? null;
        port = event.ports[0];
        port.onmessage = handlePortMessage;
        resolve(port);
      });
    });
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (!port) {
        reject(new Error("Extension runtime not available."));
        return;
      }

      const requestId = ++requestCounter;
      pendingRequests.set(requestId, { resolve, reject });
      port.postMessage({ type: "RUNTIME_MESSAGE", requestId, payload: message });
    });
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    const remaining = whole % 60;
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
  }

  function trackKey(nextState) {
    return `${nextState.title || ""}|${nextState.artist || ""}|${Math.round(nextState.duration || 0)}`;
  }

  function setLyricsStatus(text, isError = false) {
    elements.lyrics.replaceChildren();
    const status = document.createElement("div");
    status.className = `lyrics-status${isError ? " error" : ""}`;
    status.textContent = text;
    elements.lyrics.appendChild(status);
  }

  function renderPlainLyrics(text) {
    elements.lyrics.replaceChildren();
    const block = document.createElement("div");
    block.className = "plain-lyrics";
    block.textContent = text.trim();
    elements.lyrics.appendChild(block);
    elements.lyrics.scrollTop = 0;
  }

  function parseLrc(source = "") {
    const lines = [];
    const timestampPattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?]/g;

    for (const rawLine of source.split(/\r?\n/)) {
      const text = rawLine.replace(timestampPattern, "").trim();
      const timestamps = [...rawLine.matchAll(timestampPattern)];
      if (!timestamps.length || !text) continue;

      for (const match of timestamps) {
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);
        const fractionText = match[3] || "0";
        const fraction = Number(fractionText) / 10 ** fractionText.length;
        lines.push({ time: minutes * 60 + seconds + fraction, text });
      }
    }

    return lines.sort((a, b) => a.time - b.time);
  }

  function renderSyncedLyrics(lines) {
    elements.lyrics.replaceChildren();
    const fragment = document.createDocumentFragment();

    lines.forEach((line, index) => {
      const paragraph = document.createElement("p");
      paragraph.className = "lyric-line";
      paragraph.dataset.index = String(index);
      paragraph.textContent = line.text;
      fragment.appendChild(paragraph);
    });

    elements.lyrics.appendChild(fragment);
    elements.lyrics.scrollTop = 0;
    activeLyricIndex = -1;
    syncLyrics(state.currentTime);
  }

  function syncLyrics(currentTime) {
    if (!syncedLyrics.length) return;

    let low = 0;
    let high = syncedLyrics.length - 1;
    let found = -1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (syncedLyrics[middle].time <= currentTime + 0.12) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (found === activeLyricIndex) return;

    const previous = elements.lyrics.querySelector(".lyric-line.active");
    previous?.classList.remove("active");
    activeLyricIndex = found;

    if (found >= 0) {
      const active = elements.lyrics.querySelector(`[data-index="${found}"]`);
      active?.classList.add("active");
      active?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  const LRCLIB_CLIENT_ID = "YouTube Lyrics PiP/1.0.0 (https://github.com/fajarbc/youtube-lyrics-pip)";

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchLrclib(url, { retries = 2, retryDelayMs = 800 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          // Browsers forbid scripts from overriding the real User-Agent header,
          // so identify this client via LRCLIB's documented alternatives instead.
          "Lrclib-Client": LRCLIB_CLIENT_ID,
          "X-User-Agent": LRCLIB_CLIENT_ID
        }
      });

      const isRetryableStatus = response.status >= 500 || response.status === 429;
      if (!isRetryableStatus || attempt >= retries) return response;

      const retryAfterHeader = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : retryDelayMs * (attempt + 1);
      await wait(delay);
    }
  }

  async function loadLyrics(nextState) {
    const requestId = ++lyricsRequestId;
    syncedLyrics = [];
    activeLyricIndex = -1;

    if (!nextState.title || nextState.title === "Unknown title") {
      setLyricsStatus("Waiting for song metadata…");
      return;
    }

    setLyricsStatus("Searching for lyrics on LRCLIB…");

    const params = new URLSearchParams({
      artist_name:
        nextState.artist && nextState.artist !== "Unknown artist"
          ? nextState.artist
          : "",
      track_name: nextState.title,
      duration: String(Math.max(0, Math.round(nextState.duration || 0)))
    });

    try {
      const response = await fetchLrclib(`https://lrclib.net/api/get?${params.toString()}`);

      if (requestId !== lyricsRequestId) return;

      if (response.status === 404) {
        setLyricsStatus("Lyrics not found.");
        return;
      }
      if (response.status === 429) {
        throw new Error("LRCLIB rate limit exceeded. Please try again shortly.");
      }
      if (response.status >= 500) {
        throw new Error("LRCLIB is temporarily unavailable. Please try again shortly.");
      }
      if (!response.ok) throw new Error(`LRCLIB responded with ${response.status}`);

      const data = await response.json();
      if (requestId !== lyricsRequestId) return;

      const parsed = parseLrc(data.syncedLyrics || "");
      if (parsed.length) {
        syncedLyrics = parsed;
        renderSyncedLyrics(parsed);
      } else if (data.plainLyrics?.trim()) {
        renderPlainLyrics(data.plainLyrics);
      } else {
        setLyricsStatus("Lyrics not found.");
      }
    } catch (error) {
      if (requestId === lyricsRequestId) {
        setLyricsStatus(`Failed to fetch lyrics: ${error.message}`, true);
      }
    }
  }

  function render(nextState) {
    state = { ...state, ...nextState };

    elements.title.textContent = state.title || "Unknown title";
    elements.artist.textContent = state.artist || "Unknown artist";

    if (state.artwork) {
      elements.artwork.src = state.artwork;
      elements.artwork.style.visibility = "visible";
    } else {
      elements.artwork.removeAttribute("src");
      elements.artwork.style.visibility = "hidden";
    }

    elements.toggle.classList.toggle("is-playing", !state.paused);
    elements.toggle.setAttribute("aria-label", state.paused ? "Play" : "Pause");

    const duration = Number(state.duration) || 0;
    const currentTime = Math.max(0, Math.min(Number(state.currentTime) || 0, duration || Infinity));

    if (!seeking) {
      elements.progress.max = String(duration || 100);
      elements.progress.value = String(currentTime);
    }

    const percentage = duration ? Math.min(100, (currentTime / duration) * 100) : 0;
    elements.progress.style.setProperty("--progress", `${percentage}%`);
    elements.currentTime.textContent = formatTime(currentTime);
    elements.duration.textContent = formatTime(duration);
    syncLyrics(currentTime);

    const nextKey = trackKey(state);
    if (nextKey !== loadedTrackKey && state.title && duration > 0) {
      loadedTrackKey = nextKey;
      loadLyrics(state);
    }
  }

  async function command(commandName, value) {
    try {
      const response = await runtimeMessage({
        type: "PIP_COMMAND",
        tabId: targetTabId,
        command: commandName,
        value
      });

      if (!response?.ok) throw new Error(response?.error || "Command failed.");
      if (response.tabId != null) targetTabId = response.tabId;
      if (response.response?.state) render(response.response.state);
    } catch (error) {
      setLyricsStatus(error.message, true);
    }
  }

  function onRuntimeMessage(message) {
    if (message?.type !== "PLAYER_STATE") return;
    if (targetTabId != null && message.payload?.tabId !== targetTabId) return;
    if (message.payload?.tabId != null) targetTabId = message.payload.tabId;
    render(message.payload);
  }

  elements.toggle.addEventListener("click", () => command("TOGGLE"));
  elements.backward.addEventListener("click", () => command("JUMP", -10));
  elements.forward.addEventListener("click", () => command("JUMP", 10));

  function setupCollapsiblePanel(toggleId, bodyId) {
    const toggleButton = document.getElementById(toggleId);
    const body = document.getElementById(bodyId);
    if (!toggleButton || !body) return;

    toggleButton.addEventListener("click", () => {
      const collapsed = body.classList.toggle("collapsed");
      toggleButton.setAttribute("aria-expanded", String(!collapsed));
    });
  }

  setupCollapsiblePanel("toggleTrack", "trackBody");
  setupCollapsiblePanel("toggleTransport", "transportBody");

  elements.progress.addEventListener("input", () => {
    seeking = true;
    const value = Number(elements.progress.value);
    const maximum = Number(elements.progress.max) || 0;
    const percentage = maximum ? (value / maximum) * 100 : 0;
    elements.progress.style.setProperty("--progress", `${percentage}%`);
    elements.currentTime.textContent = formatTime(value);
    syncLyrics(value);
  });

  elements.progress.addEventListener("change", () => {
    const value = Number(elements.progress.value);
    seeking = false;
    command("SEEK", value);
  });

  async function initialize() {
    setLyricsStatus("Connecting to YouTube…");

    try {
      await waitForPort();

      const response = await runtimeMessage({
        type: "PIP_READY",
        tabId: targetTabId
      });

      if (!response?.ok) throw new Error(response?.error || "Could not connect to YouTube.");
      targetTabId = response.tabId;
      if (response.state) render(response.state);
      else setLyricsStatus("Waiting for playback status from YouTube…");
    } catch (error) {
      setLyricsStatus(error.message, true);
    }
  }

  initialize();
})();
