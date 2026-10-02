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
    previous: document.getElementById("previous"),
    next: document.getElementById("next"),
    backward: document.getElementById("backward"),
    forward: document.getElementById("forward"),
    progress: document.getElementById("progress"),
    currentTime: document.getElementById("currentTime"),
    duration: document.getElementById("duration"),
    lyrics: document.getElementById("lyrics"),
    brandLogo: document.getElementById("brandLogo"),
    searchLyrics: document.getElementById("searchLyrics"),
    searchPanel: document.getElementById("searchPanel"),
    searchForm: document.getElementById("searchForm"),
    searchInput: document.getElementById("searchInput"),
    searchResults: document.getElementById("searchResults"),
    offsetEarlier: document.getElementById("offsetEarlier"),
    offsetLater: document.getElementById("offsetLater"),
    offsetValue: document.getElementById("offsetValue"),
    textSmaller: document.getElementById("textSmaller"),
    textLarger: document.getElementById("textLarger"),
    toast: document.getElementById("toast")
  };

  elements.brandLogo?.addEventListener("error", () => elements.brandLogo.remove(), { once: true });

  const SYNC_LEAD_SECONDS = 0.12;
  const OFFSET_STEP_SECONDS = 0.5;
  const OFFSET_LIMIT_SECONDS = 10;
  const LYRICS_SCALE = { min: 0.8, max: 1.6, step: 0.1, fallback: 1 };
  const AUTOSCROLL_PAUSE_MS = 4000;
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const CACHE_LIMIT = 300;
  const STORAGE_TIMEOUT_MS = 1500;

  let state = {
    title: "Waiting for a song…",
    artist: "Open YouTube or YouTube Music",
    artwork: "",
    currentTime: 0,
    duration: 0,
    paused: true,
    videoId: ""
  };

  let syncedLyrics = [];
  let activeLyricIndex = -1;
  let loadedTrackKey = "";
  let lyricsRequestId = 0;
  let searchRequestId = 0;
  let seeking = false;
  let lyricsOffset = 0;
  let offsetStorageKey = "";
  let lyricsScale = LYRICS_SCALE.fallback;
  let autoscrollPausedUntil = 0;
  let autoscrollResumeTimer = null;
  let toastTimer = null;
  let extensionVersion = "1.0.0";

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
        if (message.extensionVersion) extensionVersion = message.extensionVersion;
        port = event.ports[0];
        port.onmessage = handlePortMessage;
        resolve(port);
      });
    });
  }

  function portRequest(type, payload) {
    return new Promise((resolve, reject) => {
      if (!port) {
        reject(new Error("Extension runtime not available."));
        return;
      }

      const requestId = ++requestCounter;
      pendingRequests.set(requestId, { resolve, reject });
      port.postMessage({ type, requestId, payload });
    });
  }

  function runtimeMessage(message) {
    return portRequest("RUNTIME_MESSAGE", message);
  }

  // Storage goes through content.js (the PiP window has no extension APIs).
  // Failures are non-fatal: lyrics still load, they just aren't remembered.
  // The timeout keeps a lost reply from ever blocking lyrics from loading.
  function storageRequest(payload) {
    return Promise.race([
      portRequest("STORAGE_REQUEST", payload),
      wait(STORAGE_TIMEOUT_MS).then(() => {
        throw new Error("Storage request timed out.");
      })
    ]);
  }

  async function storageGet(keys) {
    try {
      return (await storageRequest({ action: "get", keys })) || {};
    } catch {
      return {};
    }
  }

  async function storageSet(items) {
    try {
      await storageRequest({ action: "set", items });
    } catch {
      // Ignore persistence failures.
    }
  }

  async function storageRemove(keys) {
    try {
      await storageRequest({ action: "remove", keys });
    } catch {
      // Ignore persistence failures.
    }
  }

  function showToast(text) {
    if (!elements.toast) return;
    elements.toast.textContent = text;
    elements.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      elements.toast.hidden = true;
    }, 2600);
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

  // Per-video identity for things the user tuned by hand (offset, manual pick).
  function mediaKey(nextState) {
    return nextState.videoId ? `v:${nextState.videoId}` : `t:${trackKey(nextState)}`;
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
    elements.lyrics.classList.add("is-synced");
    elements.lyrics.scrollTop = 0;
    activeLyricIndex = -1;
    syncLyrics(state.currentTime);
  }

  function isAutoscrollPaused() {
    return Date.now() < autoscrollPausedUntil;
  }

  function scrollActiveLineIntoView() {
    if (activeLyricIndex < 0) return;
    const active = elements.lyrics.querySelector(`[data-index="${activeLyricIndex}"]`);
    active?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // Called when the user scrolls the lyrics themselves: stop snapping back
  // to the current line for a few seconds, then resume and re-center.
  function pauseAutoscroll() {
    if (!syncedLyrics.length) return;
    autoscrollPausedUntil = Date.now() + AUTOSCROLL_PAUSE_MS;
    clearTimeout(autoscrollResumeTimer);
    autoscrollResumeTimer = setTimeout(() => {
      autoscrollPausedUntil = 0;
      scrollActiveLineIntoView();
    }, AUTOSCROLL_PAUSE_MS);
  }

  function resumeAutoscroll() {
    autoscrollPausedUntil = 0;
    clearTimeout(autoscrollResumeTimer);
  }

  function syncLyrics(currentTime, { forceScroll = false } = {}) {
    if (!syncedLyrics.length) return;

    const effectiveTime = currentTime + SYNC_LEAD_SECONDS + lyricsOffset;
    let low = 0;
    let high = syncedLyrics.length - 1;
    let found = -1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (syncedLyrics[middle].time <= effectiveTime) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (found === activeLyricIndex) {
      if (forceScroll && !isAutoscrollPaused()) scrollActiveLineIntoView();
      return;
    }

    const previous = elements.lyrics.querySelector(".lyric-line.active");
    previous?.classList.remove("active");
    activeLyricIndex = found;

    if (found >= 0) {
      const active = elements.lyrics.querySelector(`[data-index="${found}"]`);
      active?.classList.add("active");
      if (!isAutoscrollPaused()) active?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function lrclibClientId() {
    return `YouTube Lyrics PiP/${extensionVersion} (https://github.com/fajarbc/youtube-lyrics-pip)`;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchLrclib(url, { retries = 2, retryDelayMs = 800 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const clientId = lrclibClientId();
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          // Browsers forbid scripts from overriding the real User-Agent header,
          // so identify this client via LRCLIB's documented alternatives instead.
          "Lrclib-Client": clientId,
          "X-User-Agent": clientId
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

  function formatCandidateDuration(seconds) {
    return Number.isFinite(Number(seconds)) && Number(seconds) > 0
      ? formatTime(Number(seconds))
      : "Unknown duration";
  }

  function candidateHasLyrics(candidate) {
    return Boolean(candidate?.syncedLyrics?.trim() || candidate?.plainLyrics?.trim());
  }

  function normalizeMatch(value = "") {
    return String(value)
      .toLowerCase()
      .replace(/[()[\]{}'"!?,.:;|/_-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function candidateScore(candidate, title, artist, duration) {
    const candidateTitle = normalizeMatch(candidate.trackName);
    const candidateArtist = normalizeMatch(candidate.artistName);
    const wantedTitle = normalizeMatch(title);
    const wantedArtist = normalizeMatch(artist);
    let score = 0;

    if (candidateTitle === wantedTitle) score += 100;
    else if (candidateTitle.includes(wantedTitle) || wantedTitle.includes(candidateTitle)) score += 45;
    if (wantedArtist && candidateArtist === wantedArtist) score += 75;
    else if (wantedArtist && (candidateArtist.includes(wantedArtist) || wantedArtist.includes(candidateArtist))) score += 30;
    if (candidateHasLyrics(candidate)) score += 20;
    if (candidate.syncedLyrics?.trim()) score += 15;

    const wantedDuration = Number(duration);
    const resultDuration = Number(candidate.duration);
    if (wantedDuration > 0 && resultDuration > 0) {
      score += Math.max(0, 15 - Math.min(15, Math.abs(wantedDuration - resultDuration)));
    }

    return score;
  }

  function pickBestCandidate(candidates, nextState) {
    return [...candidates]
      .sort((first, second) => candidateScore(second, nextState.title, nextState.artist, nextState.duration)
        - candidateScore(first, nextState.title, nextState.artist, nextState.duration))[0] || null;
  }

  async function searchLrclib(query) {
    const params = new URLSearchParams({ q: query.trim() });
    const response = await fetchLrclib(`https://lrclib.net/api/search?${params.toString()}`);

    if (response.status === 429) throw new Error("LRCLIB rate limit exceeded. Please try again shortly.");
    if (response.status >= 500) throw new Error("LRCLIB is temporarily unavailable. Please try again shortly.");
    if (!response.ok) throw new Error(`LRCLIB responded with ${response.status}`);

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  function renderLyricsData(data) {
    elements.lyrics.classList.remove("is-synced");
    const parsed = parseLrc(data?.syncedLyrics || "");
    if (parsed.length) {
      syncedLyrics = parsed;
      renderSyncedLyrics(parsed);
      return true;
    }
    if (data?.plainLyrics?.trim()) {
      renderPlainLyrics(data.plainLyrics);
      return true;
    }
    return false;
  }

  // Only keep what's needed to re-render; LRCLIB results carry extra fields.
  function lyricsRecord(data, source) {
    return {
      source,
      id: data?.id ?? null,
      trackName: data?.trackName || "",
      artistName: data?.artistName || "",
      syncedLyrics: data?.syncedLyrics || "",
      plainLyrics: data?.plainLyrics || "",
      savedAt: Date.now()
    };
  }

  async function saveCachedLyrics(cacheKey, record) {
    if (!record.syncedLyrics.trim() && !record.plainLyrics.trim()) return;

    const { cacheIndex } = await storageGet(["cacheIndex"]);
    const index = (Array.isArray(cacheIndex) ? cacheIndex : []).filter((key) => key !== cacheKey);
    index.push(cacheKey);
    const evicted = index.length > CACHE_LIMIT ? index.splice(0, index.length - CACHE_LIMIT) : [];

    await storageSet({ [cacheKey]: record, cacheIndex: index });
    if (evicted.length) await storageRemove(evicted);
  }

  async function fetchLyricsOvh(title, artist) {
    if (!artist || artist === "Unknown artist") return "";
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (response.status === 404) return "";
    if (!response.ok) throw new Error(`lyrics.ovh responded with ${response.status}`);
    const data = await response.json();
    return typeof data.lyrics === "string" ? data.lyrics.trim() : "";
  }

  function showSearchResults(candidates, requestId) {
    if (requestId !== searchRequestId) return;
    elements.searchResults.replaceChildren();

    if (!candidates.length) {
      const empty = document.createElement("div");
      empty.className = "lyrics-status";
      empty.textContent = "No LRCLIB matches found.";
      elements.searchResults.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    candidates.slice(0, 12).forEach((candidate) => {
      const button = document.createElement("button");
      button.className = "search-result";
      button.type = "button";

      const title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = candidate.trackName || "Unknown title";
      const meta = document.createElement("span");
      meta.className = "search-result-meta";
      meta.textContent = `${candidate.artistName || "Unknown artist"} · ${candidate.albumName || "Unknown album"} · ${formatCandidateDuration(candidate.duration)}`;
      const badge = document.createElement("span");
      badge.className = "search-result-badge";
      badge.textContent = candidate.syncedLyrics?.trim() ? "Synced" : candidate.plainLyrics?.trim() ? "Plain only" : "No lyrics";

      button.append(title, meta, badge);
      button.addEventListener("click", () => {
        lyricsRequestId += 1;
        syncedLyrics = [];
        activeLyricIndex = -1;
        resumeAutoscroll();
        if (renderLyricsData(candidate)) {
          // Remember this choice for the video so it sticks next time.
          storageSet({ [`pick:${mediaKey(state)}`]: lyricsRecord(candidate, "manual") });
          showToast("Saved as the lyrics for this video");
        } else {
          setLyricsStatus("This result has no lyrics.", true);
        }
        closeSearchPanel();
      });
      fragment.appendChild(button);
    });
    elements.searchResults.appendChild(fragment);
  }

  async function runManualSearch() {
    const query = elements.searchInput.value.trim();
    const requestId = ++searchRequestId;
    if (!query) {
      elements.searchResults.replaceChildren();
      return;
    }

    const status = document.createElement("div");
    status.className = "lyrics-status";
    status.textContent = "Searching LRCLIB…";
    elements.searchResults.replaceChildren(status);

    try {
      const candidates = await searchLrclib(query);
      showSearchResults(candidates, requestId);
    } catch (error) {
      if (requestId !== searchRequestId) return;
      const failure = document.createElement("div");
      failure.className = "lyrics-status error";
      failure.textContent = error.message;
      elements.searchResults.replaceChildren(failure);
    }
  }

  async function loadFallbackLyrics(nextState, requestId, cacheKey) {
    const candidates = await searchLrclib(
      [nextState.title, nextState.artist]
        .filter((value) => value && !value.startsWith("Unknown "))
        .join(" ")
    );
    if (requestId !== lyricsRequestId) return true;

    const candidate = pickBestCandidate(candidates, nextState);
    if (candidate) {
      if (renderLyricsData(candidate)) {
        saveCachedLyrics(cacheKey, lyricsRecord(candidate, "lrclib-search"));
        return true;
      }
      setLyricsStatus("LRCLIB found this track, but it has no lyrics.");
      return true;
    }

    const lyrics = await fetchLyricsOvh(nextState.title, nextState.artist);
    if (requestId !== lyricsRequestId) return true;
    if (lyrics) {
      renderPlainLyrics(lyrics);
      saveCachedLyrics(cacheKey, lyricsRecord({ plainLyrics: lyrics }, "lyrics.ovh"));
    } else {
      setLyricsStatus("Lyrics not found.");
    }
    return true;
  }

  function clearSearchResults() {
    // Bumping the id also drops any search that's still in flight.
    searchRequestId += 1;
    elements.searchResults.replaceChildren();
  }

  function closeSearchPanel() {
    if (elements.searchPanel.hidden) return;
    elements.searchPanel.hidden = true;
    elements.searchLyrics.setAttribute("aria-expanded", "false");
    clearSearchResults();
  }

  function toggleSearchPanel() {
    const isOpen = !elements.searchPanel.hidden;
    elements.searchPanel.hidden = isOpen;
    elements.searchLyrics.setAttribute("aria-expanded", String(!isOpen));
    if (!isOpen) {
      elements.searchInput.value = [state.title, state.artist].filter(Boolean).join(" ");
      elements.searchInput.focus();
    }
  }

  function formatOffset(seconds) {
    if (!seconds) return "0.0s";
    return `${seconds > 0 ? "+" : "−"}${Math.abs(seconds).toFixed(1)}s`;
  }

  function renderOffset() {
    if (elements.offsetValue) {
      elements.offsetValue.textContent = formatOffset(lyricsOffset);
      elements.offsetValue.classList.toggle("is-adjusted", lyricsOffset !== 0);
    }
  }

  async function loadOffset(key) {
    offsetStorageKey = `offset:${key}`;
    const stored = await storageGet([offsetStorageKey]);
    const value = Number(stored[offsetStorageKey]);
    lyricsOffset = Number.isFinite(value) ? value : 0;
    renderOffset();
  }

  // Positive offset = lyrics show earlier, negative = later.
  function changeOffset(delta) {
    const next = Math.round((lyricsOffset + delta) * 10) / 10;
    lyricsOffset = Math.max(-OFFSET_LIMIT_SECONDS, Math.min(OFFSET_LIMIT_SECONDS, next));
    renderOffset();
    syncLyrics(state.currentTime, { forceScroll: true });

    if (!offsetStorageKey) return;
    if (lyricsOffset === 0) storageRemove([offsetStorageKey]);
    else storageSet({ [offsetStorageKey]: lyricsOffset });
  }

  function resetOffset() {
    if (lyricsOffset !== 0) changeOffset(-lyricsOffset);
  }

  function applyLyricsScale() {
    elements.lyrics.style.setProperty("--lyrics-scale", String(lyricsScale));
    if (elements.textSmaller) elements.textSmaller.disabled = lyricsScale <= LYRICS_SCALE.min + 0.001;
    if (elements.textLarger) elements.textLarger.disabled = lyricsScale >= LYRICS_SCALE.max - 0.001;
  }

  function changeLyricsScale(direction) {
    const next = Math.round((lyricsScale + direction * LYRICS_SCALE.step) * 10) / 10;
    lyricsScale = Math.max(LYRICS_SCALE.min, Math.min(LYRICS_SCALE.max, next));
    applyLyricsScale();
    storageSet({ lyricsScale });
    syncLyrics(state.currentTime, { forceScroll: true });
  }

  async function loadLyricsScale() {
    const { lyricsScale: stored } = await storageGet(["lyricsScale"]);
    const value = Number(stored);
    if (Number.isFinite(value) && value >= LYRICS_SCALE.min && value <= LYRICS_SCALE.max) {
      lyricsScale = value;
    }
    applyLyricsScale();
  }

  async function loadLyrics(nextState) {
    const requestId = ++lyricsRequestId;
    syncedLyrics = [];
    activeLyricIndex = -1;
    resumeAutoscroll();
    elements.lyrics.classList.remove("is-synced");

    if (!nextState.title || nextState.title === "Unknown title") {
      setLyricsStatus("Waiting for song metadata…");
      return;
    }

    const key = mediaKey(nextState);
    const cacheKey = `cache:${trackKey(nextState)}`;
    const pickKey = `pick:${key}`;

    const [stored] = await Promise.all([storageGet([pickKey, cacheKey]), loadOffset(key)]);
    if (requestId !== lyricsRequestId) return;

    // 1) A result the user picked by hand for this video.
    if (stored[pickKey] && renderLyricsData(stored[pickKey])) return;

    // 2) A recent cached lookup for this exact track.
    const cached = stored[cacheKey];
    if (cached && Date.now() - (Number(cached.savedAt) || 0) < CACHE_TTL_MS && renderLyricsData(cached)) {
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
        await loadFallbackLyrics(nextState, requestId, cacheKey);
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

      if (renderLyricsData(data)) saveCachedLyrics(cacheKey, lyricsRecord(data, "lrclib"));
      else await loadFallbackLyrics(nextState, requestId, cacheKey);
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
      if (response.response && response.response.ok === false) {
        throw new Error(response.response.error || "Command failed.");
      }
      if (response.response?.state) render(response.response.state);
    } catch (error) {
      // Don't wipe the lyrics for a failed button press.
      showToast(error.message);
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
  elements.previous?.addEventListener("click", () => command("PREV"));
  elements.next?.addEventListener("click", () => command("NEXT"));
  elements.searchLyrics.addEventListener("click", toggleSearchPanel);
  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runManualSearch();
  });

  // Emptying the box (typing it away or the native clear "x") clears results.
  elements.searchInput.addEventListener("input", () => {
    if (!elements.searchInput.value.trim()) clearSearchResults();
  });

  // Escape closes the search panel from anywhere inside it.
  elements.searchPanel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeSearchPanel();
    elements.searchLyrics.focus();
  });

  // Clicking anywhere outside the panel (lyrics, controls) closes it too.
  document.addEventListener("pointerdown", (event) => {
    if (elements.searchPanel.hidden) return;
    if (elements.searchPanel.contains(event.target) || elements.searchLyrics.contains(event.target)) return;
    closeSearchPanel();
  });

  elements.offsetEarlier?.addEventListener("click", () => changeOffset(OFFSET_STEP_SECONDS));
  elements.offsetLater?.addEventListener("click", () => changeOffset(-OFFSET_STEP_SECONDS));
  elements.offsetValue?.addEventListener("click", resetOffset);
  elements.textSmaller?.addEventListener("click", () => changeLyricsScale(-1));
  elements.textLarger?.addEventListener("click", () => changeLyricsScale(1));

  // Click a synced line to jump the video there.
  elements.lyrics.addEventListener("click", (event) => {
    const line = event.target.closest?.(".lyric-line");
    if (!line || !syncedLyrics.length) return;
    if (window.getSelection()?.toString()) return;

    const entry = syncedLyrics[Number(line.dataset.index)];
    if (!entry) return;

    resumeAutoscroll();
    command("SEEK", Math.max(0, entry.time - lyricsOffset));
  });

  // Manual scrolling pauses auto-scroll. Programmatic scrollIntoView doesn't
  // fire these input events, so they reliably mean "the user is scrolling".
  elements.lyrics.addEventListener("wheel", pauseAutoscroll, { passive: true });
  elements.lyrics.addEventListener("touchmove", pauseAutoscroll, { passive: true });
  elements.lyrics.addEventListener("pointerdown", (event) => {
    // Grabbing the scrollbar targets the container itself, not a line.
    if (event.target === elements.lyrics) pauseAutoscroll();
  });
  elements.lyrics.addEventListener("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      pauseAutoscroll();
    }
  });

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
    renderOffset();
    applyLyricsScale();

    try {
      await waitForPort();
      loadLyricsScale();

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
