// Browser player adapted from buildUniversalEmbedHTML in seerver.js.
import config from "./config.js";
import { createCatalogLoader, parseSelector } from "./catalog.js";

let catalog = { sources: [], pollMs: config.pollMs };
let selector = null;
let loadCatalog = null;
const sourceSelect = document.getElementById("sourceSelect");
const playerSelect = document.getElementById("playerSelect");
const video = document.getElementById("video");
const engineHost = document.getElementById("engineHost");
const framePlayer = document.getElementById("framePlayer");
const statusBox = document.getElementById("status");
const statusText = document.getElementById("statusText");
const spinner = document.getElementById("spinner");
const retryButton = document.getElementById("retryButton");
const jwKey = config.jwplayerKey;
const startupTimeoutMs = config.startupTimeoutMs;

const libraries = new Map();
const retryCounts = new Map();
const engineAttempts = new Map();
let generation = 0;
let currentSession = null;
let activeSource = null;
let pollTimer = null;
let pollController = null;
let renderedSourceSignature = null;
let stopped = false;

const engineOptions = {
  hls: [["hlsjs", "HLS.js"], ["native", "Native video"], ["clappr", "Clappr"], ["jw", "JW Player"]],
  dash: [["shaka", "Shaka Player"], ["jw", "JW Player"]],
  flv: [["flvjs", "flv.js"], ["native", "Native video"]],
  native: [["native", "Native video"]],
  youtube: [["iframe", "YouTube embed"]],
  iframe: [["iframe", "Sandboxed embed"]]
};

if (!jwKey) {
  for (const type of ["hls", "dash"]) {
    engineOptions[type] = engineOptions[type].filter(([engine]) => engine !== "jw");
  }
}

function sourceById(id) {
  return (catalog.sources || []).find(function (source) { return source.id === id; }) || null;
}

function sourceExpired(source, safetyMs) {
  return Boolean(source && source.expiresAt && source.expiresAt <= Date.now() + (safetyMs || 0));
}

function showStatus(message, loading, retryable) {
  statusText.textContent = message;
  spinner.classList.toggle("hidden", !loading);
  retryButton.classList.toggle("hidden", !retryable);
  statusBox.classList.add("visible");
}

function hideStatus() {
  statusBox.classList.remove("visible");
}

function errorDetail(value) {
  if (!value) return {};
  const result = {};
  for (const key of ["name", "message", "code", "type", "details", "fatal", "reason", "sourceError"]) {
    const item = value[key];
    if (item === undefined || item === null) continue;
    if (["string", "number", "boolean"].includes(typeof item)) result[key] = item;
    else {
      try { result[key] = JSON.stringify(item).slice(0, 1000); }
      catch (error) { result[key] = String(item).slice(0, 1000); }
    }
  }
  return result;
}

function resourceTiming(url) {
  try {
    const entries = performance.getEntriesByName(url);
    const entry = entries[entries.length - 1];
    return entry ? Math.round(entry.duration) : null;
  } catch (error) {
    return null;
  }
}

function reportPlayerError(session, message, details) {
  details = details || {};
  const failedUrl = String(details.failedUrl || details.url || session?.source?.url || "");
  const payload = {
    sourceId: session?.source?.id || null,
    sourceLabel: session?.source?.label || null,
    engine: session?.engine || null,
    error: message || "unknown player error",
    errorCode: details.errorCode || details.code || null,
    failedUrl,
    httpStatus: Number.isInteger(details.httpStatus) ? details.httpStatus : null,
    responseTimeMs: Number.isFinite(details.responseTimeMs)
      ? details.responseTimeMs
      : resourceTiming(failedUrl),
    browserError: details.browserError || details.error || null,
    details: details.details || null
  };
  console.error("[StreamPlayerError]", payload);
}

function loadScript(id, url, globalName) {
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  if (libraries.has(url)) return libraries.get(url);

  const promise = new Promise(function (resolve, reject) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const script = document.createElement("script");
    const timeout = setTimeout(function () {
      script.remove();
      const error = new Error("Player library download timed out");
      error.failedUrl = url;
      error.errorCode = "library_timeout";
      reject(error);
    }, 12000);
    script.id = id;
    script.src = url;
    script.async = true;
    script.onload = function () {
      clearTimeout(timeout);
      resolve(globalName ? window[globalName] : true);
    };
    script.onerror = function () {
      clearTimeout(timeout);
      script.remove();
      const error = new Error("Player library download failed");
      error.failedUrl = url;
      error.errorCode = "library_download_failed";
      reject(error);
    };
    document.head.appendChild(script);
  }).catch(function (error) {
    libraries.delete(url);
    throw error;
  });
  libraries.set(url, promise);
  return promise;
}

function listen(session, target, event, handler, options) {
  target.addEventListener(event, handler, options);
  session.cleanups.push(function () { target.removeEventListener(event, handler, options); });
}

function sessionTimer(session, callback, delay) {
  const timer = setTimeout(function () {
    session.timers.delete(timer);
    callback();
  }, delay);
  session.timers.add(timer);
  return timer;
}

function sessionIsActive(session) {
  return currentSession === session && session.id === generation && !session.controller.signal.aborted;
}

function sessionIsCurrent(session) {
  return sessionIsActive(session) && !session.failed;
}

async function releasePlayerResources(session) {
  if (!session) return;
  if (session.releasePromise) return session.releasePromise;
  session.releasePromise = (async function () {
    while (session.cleanups.length) {
      try { session.cleanups.pop()(); } catch (error) {}
    }

    if (session.hls) {
      try { session.hls.destroy(); } catch (error) {}
      session.hls = null;
    }
    if (session.clappr) {
      try { session.clappr.stop(); } catch (error) {}
      try { session.clappr.destroy(); } catch (error) {}
      session.clappr = null;
    }
    if (session.flv) {
      try { session.flv.pause(); } catch (error) {}
      try { session.flv.unload(); } catch (error) {}
      try { session.flv.detachMediaElement(); } catch (error) {}
      try { session.flv.destroy(); } catch (error) {}
      session.flv = null;
    }
    if (session.jw) {
      try { session.jw.remove(); } catch (error) {}
      session.jw = null;
    }
    if (session.shaka) {
      try { await session.shaka.destroy(); } catch (error) {}
      session.shaka = null;
    }

    try {
      framePlayer.src = "about:blank";
      framePlayer.removeAttribute("src");
      video.pause();
      video.removeAttribute("src");
      video.srcObject = null;
      video.load();
    } catch (error) {}
    engineHost.innerHTML = "";
    engineHost.style.display = "none";
    framePlayer.style.display = "none";
    video.style.display = "block";
  })();
  return session.releasePromise;
}

async function destroySession(session) {
  if (!session) return;
  session.controller.abort();
  for (const timer of session.timers) clearTimeout(timer);
  session.timers.clear();
  await releasePlayerResources(session);
}

function markPlaying(session) {
  if (!sessionIsCurrent(session) || session.failed) return;
  // Idempotent per session: engines that bind repeated progress events (Clappr
  // onTimeUpdate, JW "time") call this many times a second, but the startup-timer
  // teardown and counter resets should run exactly once when playback first starts.
  if (session.playing) return;
  session.playing = true;
  if (session.startupTimer) {
    clearTimeout(session.startupTimer);
    session.timers.delete(session.startupTimer);
    session.startupTimer = null;
  }
  session.failed = false;
  retryCounts.delete(session.source.id);
  engineAttempts.delete(session.source.id);
  hideStatus();
}

function playVideo(session) {
  const promise = video.play();
  if (promise && promise.catch) {
    promise.catch(function (error) {
      if (error && error.name === "NotAllowedError") {
        if (sessionIsCurrent(session)) {
          if (session.startupTimer) {
            clearTimeout(session.startupTimer);
            session.timers.delete(session.startupTimer);
            session.startupTimer = null;
          }
          hideStatus();
        }
        return;
      }
      failSession(session, "Playback could not start.", {
        errorCode: error?.name || "video_play_failed",
        browserError: error?.message || String(error),
        failedUrl: video.currentSrc || session.source.url,
        details: errorDetail(error)
      });
    });
  }
}

function preferredEngine(type) {
  const available = engineOptions[type] || [];
  let saved = null;
  try { saved = localStorage.getItem("streams-api-player-" + type); } catch (error) {}
  // Native is the default engine on Safari/iOS. Never auto-restore Clappr or JW: both rely on
  // their own library "play" event to cancel the startup timer and routinely
  // stall out (Clappr core has no HLS.js plugin; JW needs a valid domain key),
  // so a stale saved pref for either would silently strand viewers on a timeout.
  // They stay selectable in the dropdown as an explicit per-session opt-in.
  if (saved === "clappr" || saved === "jw") saved = null;
  if (saved && available.some(function (entry) { return entry[0] === saved; })) return saved;
  if (type === "hls") {
    return video.canPlayType("application/vnd.apple.mpegurl") ? "native" : "hlsjs";
  }
  return available[0] && available[0][0];
}

// Returns the next playback engine to try for this source's type that has not
// already failed, in the engineOptions order (native -> hlsjs -> clappr -> jw for
// HLS). Used to auto-switch engines on the same source, e.g. when native HLS is
// unsupported on desktop Chrome so playback falls through to HLS.js.
function nextEngineFor(source, tried) {
  const available = engineOptions[source.type] || [];
  for (const entry of available) {
    if (!tried.has(entry[0])) return entry[0];
  }
  return null;
}

function engineLabel(type, engine) {
  const entry = (engineOptions[type] || []).find(function (item) { return item[0] === engine; });
  return (entry && entry[1]) || engine;
}

function renderPlayerOptions(type, preferred) {
  const available = engineOptions[type] || [];
  playerSelect.replaceChildren();
  for (const entry of available) {
    const option = document.createElement("option");
    option.value = entry[0];
    option.textContent = entry[1];
    playerSelect.appendChild(option);
  }
  playerSelect.value = available.some(function (entry) { return entry[0] === preferred; })
    ? preferred
    : preferredEngine(type);
  playerSelect.disabled = available.length < 2;
}

// A fingerprint of the source dropdown that ignores rotating tokens/expiry, so we
// only re-render the list when streams are actually added, removed, or relabelled.
function sourceListSignature(sources) {
  return (sources || [])
    .map(function (source) { return source.id + "|" + source.label + "|" + source.type; })
    .join("~");
}

function renderSources(selectedId) {
  const sources = (catalog.sources || []).slice();
  if (activeSource && !sources.some(function (source) { return source.id === activeSource.id; }) && !sourceExpired(activeSource, 0)) {
    sources.push({ ...activeSource, label: activeSource.label + " (playing)" });
  }

  sourceSelect.replaceChildren();
  for (const source of sources) {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.label;
    sourceSelect.appendChild(option);
  }
  sourceSelect.disabled = sources.length < 2;
  if (sources.some(function (source) { return source.id === selectedId; })) {
    sourceSelect.value = selectedId;
  } else if (sources[0]) {
    sourceSelect.value = sources[0].id;
  }
}

async function loadNative(session) {
  if (session.source.type === "hls" && !video.canPlayType("application/vnd.apple.mpegurl")) {
    throw new Error("Native HLS is not supported by this browser");
  }
  listen(session, video, "playing", function () { markPlaying(session); });
  listen(session, video, "error", function () {
    const mediaError = video.error;
    failSession(session, "Native playback failed.", {
      errorCode: mediaError ? "MEDIA_ERR_" + mediaError.code : "native_media_error",
      browserError: mediaError?.message || "HTMLMediaElement error",
      failedUrl: video.currentSrc || session.source.url,
      details: errorDetail(mediaError)
    });
  });
  video.src = session.source.url;
  video.load();
  playVideo(session);
}

async function loadClappr(session) {
  await loadScript("clappr-script", "https://cdn.jsdelivr.net/npm/@clappr/player@0.11.16/dist/clappr.min.js", "Clappr");
  if (!sessionIsCurrent(session)) return;
  video.style.display = "none";
  engineHost.style.display = "block";
  session.clappr = new window.Clappr.Player({
    source: session.source.url,
    parent: engineHost,
    width: "100%",
    height: "100%",
    autoPlay: true,
    mute: true,
    mimeType: "application/vnd.apple.mpegurl",
    playback: { hlsjsConfig: { enableWorker: true, backBufferLength: 30, maxBufferLength: 30 } },
    events: {
      onPlay: function () { markPlaying(session); },
      // onTimeUpdate only fires once the media is actually decoding/advancing, so it
      // is a reliable confirmation that playback started even if onPlay is missed --
      // without it, a Clappr session that plays fine can still hit the startup timer.
      onTimeUpdate: function () { markPlaying(session); },
      onError: function (error) {
        const details = errorDetail(error);
        failSession(session, "Clappr playback failed.", {
          errorCode: details.code || details.type || "clappr_error",
          browserError: details.message || details.reason || "Clappr error event",
          failedUrl: error?.url || error?.response?.url || session.source.url,
          httpStatus: error?.response?.code || error?.response?.status || null,
          details
        });
      }
    }
  });
}

async function loadHlsJs(session) {
  await loadScript("hls-script", "https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js", "Hls");
  if (!sessionIsCurrent(session)) return;
  if (!window.Hls || !window.Hls.isSupported()) return loadNative(session);

  session.hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30, maxBufferLength: 30, maxMaxBufferLength: 60 });
  session.hls.on(window.Hls.Events.MANIFEST_PARSED, function () { playVideo(session); });
  session.hls.on(window.Hls.Events.ERROR, function (_event, data) {
    if (!data.fatal) return;
    if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && session.mediaRecoveries++ < 2) {
      session.hls.recoverMediaError();
      return;
    }
    failSession(session, "HLS playback failed.", {
      errorCode: data?.details || data?.type || "hls_error",
      browserError: data?.reason || data?.error?.message || "HLS.js fatal error",
      failedUrl: data?.url || data?.frag?.url || data?.response?.url || session.source.url,
      httpStatus: data?.response?.code || null,
      details: errorDetail(data)
    });
  });
  listen(session, video, "playing", function () { markPlaying(session); });
  session.hls.loadSource(session.source.url);
  session.hls.attachMedia(video);
}

async function loadShaka(session) {
  await loadScript("shaka-script", "https://cdn.jsdelivr.net/npm/shaka-player@5.2.1/dist/shaka-player.dash.js", "shaka");
  if (!sessionIsCurrent(session)) return;
  window.shaka.polyfill.installAll();
  if (!window.shaka.Player.isBrowserSupported()) throw new Error("DASH is not supported by this browser");

  session.shaka = new window.shaka.Player();
  await session.shaka.attach(video);
  if (!sessionIsCurrent(session)) return;
  listen(session, session.shaka, "error", function (event) {
    if (!event.detail || event.detail.severity === window.shaka.util.Error.Severity.CRITICAL) {
      const detail = event.detail || {};
      const data = Array.isArray(detail.data) ? detail.data : [];
      failSession(session, "DASH playback failed.", {
        errorCode: [detail.category, detail.code].filter(Boolean).join(":") || "shaka_error",
        browserError: detail.message || "Shaka critical error",
        failedUrl: data.find(function (item) { return typeof item === "string" && /^https?:/i.test(item); }) || session.source.url,
        httpStatus: data.find(function (item) { return Number.isInteger(item) && item >= 100 && item <= 599; }) || null,
        details: errorDetail(detail)
      });
    }
  });
  listen(session, session.shaka, "downloadfailed", function (event) {
    const request = event.request || {};
    const shakaError = event.error || null;
    const failedUrl = Array.isArray(request.uris) ? request.uris[0] : session.source.url;
    reportPlayerError(session, "Shaka network request failed.", {
      errorCode: shakaError?.code || "shaka_download_failed",
      browserError: shakaError?.message || "Shaka downloadfailed event",
      failedUrl,
      httpStatus: event.httpResponseCode || null,
      details: errorDetail(shakaError)
    });
  });
  const configuration = {
    streaming: {
      bufferingGoal: 30,
      rebufferingGoal: 3,
      bufferBehind: 30,
      retryParameters: { maxAttempts: 5, baseDelay: 500, backoffFactor: 2, fuzzFactor: 0.5, timeout: 15000 }
    },
    manifest: { retryParameters: { maxAttempts: 4, baseDelay: 500, backoffFactor: 2, fuzzFactor: 0.5, timeout: 15000 } }
  };
  if (session.source.drm) {
    configuration.drm = { clearKeys: { [session.source.drm.keyId]: session.source.drm.key } };
  }
  session.shaka.configure(configuration);
  listen(session, video, "playing", function () { markPlaying(session); });
  await session.shaka.load(session.source.url);
  if (sessionIsCurrent(session)) playVideo(session);
}

async function loadFlv(session) {
  await loadScript("flv-script", "https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js", "flvjs");
  if (!sessionIsCurrent(session)) return;
  const features = window.flvjs && window.flvjs.getFeatureList ? window.flvjs.getFeatureList() : {};
  if (!window.flvjs || !window.flvjs.isSupported() || features.mseLiveFlvPlayback === false) {
    throw new Error("Live FLV is not supported by this browser");
  }

  session.flv = window.flvjs.createPlayer(
    { type: "flv", url: session.source.url, isLive: true, hasAudio: true, hasVideo: true },
    { enableWorker: false, enableStashBuffer: true, autoCleanupSourceBuffer: true, lazyLoad: false }
  );
  const onFlvError = function (type, detail, info) {
    failSession(session, "FLV playback failed.", {
      errorCode: [type, detail].filter(Boolean).join(":") || "flv_error",
      browserError: info?.msg || info?.reason || "flv.js error event",
      failedUrl: info?.url || session.source.url,
      httpStatus: info?.code || null,
      details: errorDetail(info)
    });
  };
  session.flv.on(window.flvjs.Events.ERROR, onFlvError);
  session.cleanups.push(function () {
    try { session.flv && session.flv.off(window.flvjs.Events.ERROR, onFlvError); } catch (error) {}
  });
  listen(session, video, "playing", function () { markPlaying(session); });
  session.flv.attachMediaElement(video);
  session.flv.load();
  playVideo(session);
}

async function loadJw(session) {
  await loadScript("jw-script", "https://ssl.p.jwpcdn.com/player/v/8.26.0/jwplayer.js", "jwplayer");
  if (!sessionIsCurrent(session)) return;
  window.jwplayer.key = jwKey;
  video.style.display = "none";
  engineHost.style.display = "block";
  const source = { file: session.source.url };
  if (session.source.type === "dash") {
    source.type = "dash";
    if (session.source.drm) source.drm = { clearkey: session.source.drm };
  }
  session.jw = window.jwplayer("engineHost").setup({
    playlist: [{ sources: [source] }], width: "100%", height: "100%", autostart: true, mute: true, stretching: "uniform"
  });
  const onJwPlay = function () { markPlaying(session); };
  const onJwError = function (error) {
    const sourceError = error?.sourceError || {};
    failSession(session, "JW Player playback failed.", {
      errorCode: error?.code || "jw_error",
      browserError: error?.message || error?.reason || "JW Player error event",
      failedUrl: error?.source?.file || error?.url || sourceError.url || sourceError.responseURL || session.source.url,
      httpStatus: sourceError?.response?.status || sourceError.status || error?.response?.status || null,
      details: errorDetail(error)
    });
  };
  session.jw.on("play", onJwPlay);
  // "firstFrame" fires when the first frame actually renders and "time" fires as
  // playback advances -- either is a stronger "really playing" signal than "play"
  // and guards against the startup timer firing on a session that did start.
  session.jw.on("firstFrame", onJwPlay);
  session.jw.on("time", onJwPlay);
  session.jw.on("error", onJwError);
  session.jw.on("setupError", onJwError);
  session.jw.on("playAttemptFailed", onJwError);
  session.cleanups.push(function () {
    try { session.jw && session.jw.off("play", onJwPlay); } catch (error) {}
    try { session.jw && session.jw.off("firstFrame", onJwPlay); } catch (error) {}
    try { session.jw && session.jw.off("time", onJwPlay); } catch (error) {}
    try { session.jw && session.jw.off("error", onJwError); } catch (error) {}
    try { session.jw && session.jw.off("setupError", onJwError); } catch (error) {}
    try { session.jw && session.jw.off("playAttemptFailed", onJwError); } catch (error) {}
  });
}

async function loadFrame(session) {
  video.style.display = "none";
  framePlayer.style.display = "block";
  const youtube = session.source.type === "youtube";
  framePlayer.setAttribute("sandbox", youtube
    ? "allow-scripts allow-same-origin allow-presentation"
    : "allow-scripts allow-presentation");
  framePlayer.setAttribute("allow", youtube
    ? "autoplay; encrypted-media; picture-in-picture; fullscreen"
    : "autoplay; fullscreen");
  framePlayer.referrerPolicy = youtube ? "strict-origin-when-cross-origin" : "no-referrer";
  let sourceUrl = session.source.url;
  if (youtube) {
    const parsed = new URL(sourceUrl);
    parsed.searchParams.set("origin", location.origin);
    sourceUrl = parsed.href;
  }
  listen(session, framePlayer, "load", function () { markPlaying(session); }, { once: true });
  framePlayer.src = sourceUrl;
}

async function runEngine(session) {
  if (session.engine === "clappr") return loadClappr(session);
  if (session.engine === "hlsjs") return loadHlsJs(session);
  if (session.engine === "shaka") return loadShaka(session);
  if (session.engine === "flvjs") return loadFlv(session);
  if (session.engine === "jw") return loadJw(session);
  if (session.engine === "iframe") return loadFrame(session);
  return loadNative(session);
}

async function startPlayback(source, engine) {
  if (!source || sourceExpired(source, 1500)) {
    showStatus("This stream link has expired. Refreshing sources...", true, false);
    await pollCatalog(true);
    source = sourceById(source && source.id) || (catalog.sources || [])[0];
    if (!source) return showStatus("No healthy stream is currently available.", false, true);
  }

  const nextGeneration = ++generation;
  const previous = currentSession;
  currentSession = null;
  await destroySession(previous);
  if (nextGeneration !== generation || stopped) return;

  const session = {
    id: nextGeneration,
    source,
    engine: engine || preferredEngine(source.type),
    controller: new AbortController(),
    timers: new Set(),
    cleanups: [],
    mediaRecoveries: 0,
    failed: false,
    startupTimer: null
  };
  currentSession = session;
  activeSource = { ...source };
  renderSources(source.id);
  renderPlayerOptions(source.type, session.engine);
  showStatus("Loading " + source.label + "...", true, false);
  session.startupTimer = sessionTimer(session, function () {
    failSession(session, "Playback startup timed out.", {
      errorCode: "startup_timeout",
      failedUrl: session.source.url,
      responseTimeMs: startupTimeoutMs,
      browserError: "No playing event was received before the startup deadline"
    });
  }, startupTimeoutMs);

  try {
    await runEngine(session);
  } catch (error) {
    failSession(session, error.message || "Player startup failed.", {
      errorCode: error.errorCode || error.code || "player_startup_failed",
      failedUrl: error.failedUrl || source.url,
      browserError: error.message || String(error),
      details: errorDetail(error)
    });
  }
}

async function fallbackFrom(session, reason) {
  if (!sessionIsActive(session)) return;
  await releasePlayerResources(session);
  if (!sessionIsActive(session)) return;
  const sources = catalog.sources || [];
  const startIndex = sources.findIndex(function (source) { return source.id === session.source.id; });

  for (let offset = 1; offset <= sources.length; offset++) {
    const candidate = startIndex >= 0
      ? sources[(startIndex + offset) % sources.length]
      : sources[offset - 1];
    if (!candidate || candidate.id === session.source.id || sourceExpired(candidate, 0)) continue;
    showStatus("Switching to " + candidate.label + "...", true, false);
    sourceSelect.value = candidate.id;
    renderPlayerOptions(candidate.type, preferredEngine(candidate.type));
    await startPlayback(candidate, playerSelect.value);
    return;
  }

  showStatus(reason + " No fallback stream is available.", false, true);
}

function failSession(session, message, details) {
  if (!sessionIsCurrent(session) || session.failed) return;
  session.failed = true;
  if (session.startupTimer) {
    clearTimeout(session.startupTimer);
    session.timers.delete(session.startupTimer);
    session.startupTimer = null;
  }
  reportPlayerError(session, message, details);
  void releasePlayerResources(session);
  const attempts = retryCounts.get(session.source.id) || 0;
  if (attempts < 2 && !sourceExpired(session.source, 0)) {
    retryCounts.set(session.source.id, attempts + 1);
    const delay = 750 * Math.pow(2, attempts);
    showStatus(message + " Retrying...", true, false);
    sessionTimer(session, function () {
      if (sessionIsActive(session)) startPlayback(sourceById(session.source.id) || session.source, session.engine);
    }, delay);
    return;
  }

  // The current engine has exhausted its retries. Before abandoning this (healthy)
  // source, fall through to the next playback engine for its type -- e.g. native
  // HLS is unsupported on desktop Chrome, so switch to HLS.js on the same stream
  // rather than jumping straight to another source.
  const tried = engineAttempts.get(session.source.id) || new Set();
  tried.add(session.engine);
  engineAttempts.set(session.source.id, tried);
  const nextEngine = nextEngineFor(session.source, tried);
  if (nextEngine && !sourceExpired(session.source, 0)) {
    retryCounts.delete(session.source.id);
    showStatus(message + " Trying " + engineLabel(session.source.type, nextEngine) + "...", true, false);
    sessionTimer(session, function () {
      if (sessionIsActive(session)) startPlayback(sourceById(session.source.id) || session.source, nextEngine);
    }, 400);
    return;
  }

  void fallbackFrom(session, message);
}

function applyCatalog(nextCatalog) {
  if (!nextCatalog || !Array.isArray(nextCatalog.sources)) return;
  catalog = nextCatalog;

  // Only rebuild the source dropdown when the actual set of streams changes (id /
  // label / type), NOT when a token rotates. The catalog "version" churns on every
  // poll because it includes the auth_key, and we do not want that to touch the UI.
  const signature = sourceListSignature(catalog.sources);
  if (signature !== renderedSourceSignature) {
    renderedSourceSignature = signature;
    renderSources(activeSource && activeSource.id);
  }

  // Once a stream is playing we PIN its URL for the whole session and never swap it
  // for a rotated token. The auth token stays valid until the match ends (same as
  // the FLV feeds), so re-checking or refreshing it only tears the player down and
  // makes the stream reload -- which is exactly what users complained about. Polling
  // continues solely to keep the dropdown catalog fresh; the active stream is left
  // untouched. Genuine playback failures are still caught by the per-engine error
  // handlers (loadHlsJs / loadNative / ...), which fall back on their own.
}

function schedulePoll() {
  if (stopped || !selector || !loadCatalog) return;
  const baseDelay = document.hidden ? Math.max(catalog.pollMs || 10000, 30000) : catalog.pollMs || 10000;
  const jitter = Math.floor(Math.random() * 2000) - 1000;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(function () { void pollCatalog(false); }, Math.max(5000, baseDelay + jitter));
}

async function pollCatalog(immediate) {
  if (stopped || !selector || !loadCatalog) return;
  if (pollController) pollController.abort();
  const controller = new AbortController();
  pollController = controller;
  try {
    const nextCatalog = await loadCatalog(selector, controller.signal);
    if (pollController !== controller || stopped) return;
    applyCatalog(nextCatalog);
    document.title = catalog.match?.title || "Live stream";
    if (!currentSession) {
      const source = sourceById(sourceSelect.value) || catalog.sources[0];
      if (source) void startPlayback(source, preferredEngine(source.type));
      else showStatus("No playable stream is currently available. Checking again shortly...", false, true);
    }
  } catch (error) {
    if (!error || error.name !== "AbortError") {
      if (immediate || !currentSession) showStatus(error.message || "Unable to refresh stream links.", false, true);
    }
  } finally {
    if (pollController === controller) {
      pollController = null;
      schedulePoll();
    }
  }
}

sourceSelect.addEventListener("change", function () {
  const source = sourceById(sourceSelect.value);
  if (!source) return;
  retryCounts.delete(source.id);
  engineAttempts.delete(source.id);
  renderPlayerOptions(source.type, preferredEngine(source.type));
  void startPlayback(source, playerSelect.value);
});

playerSelect.addEventListener("change", function () {
  const source = sourceById(sourceSelect.value) || activeSource;
  if (!source) return;
  try { localStorage.setItem("streams-api-player-" + source.type, playerSelect.value); } catch (error) {}
  retryCounts.delete(source.id);
  engineAttempts.delete(source.id);
  void startPlayback(source, playerSelect.value);
});

retryButton.addEventListener("click", function () {
  const source = sourceById(sourceSelect.value) || activeSource || (catalog.sources || [])[0];
  if (!source) return void pollCatalog(true);
  retryCounts.delete(source.id);
  engineAttempts.delete(source.id);
  void startPlayback(source, playerSelect.value || preferredEngine(source.type));
});

document.addEventListener("visibilitychange", schedulePoll);
window.addEventListener("error", function (event) {
  const session = currentSession;
  if (!session || !sessionIsCurrent(session)) return;
  reportPlayerError(session, "Browser runtime error.", {
    errorCode: "window_error",
    failedUrl: event.filename || session.source.url,
    browserError: event.message || event.error?.message || "window error",
    details: errorDetail(event.error)
  });
});
window.addEventListener("unhandledrejection", function (event) {
  const session = currentSession;
  if (!session || !sessionIsCurrent(session)) return;
  reportPlayerError(session, "Unhandled player promise rejection.", {
    errorCode: "unhandled_rejection",
    failedUrl: session.source.url,
    browserError: event.reason?.message || String(event.reason || "promise rejection"),
    details: errorDetail(event.reason)
  });
});
window.addEventListener("pagehide", function () {
  stopped = true;
  generation++;
  clearTimeout(pollTimer);
  if (pollController) pollController.abort();
  const session = currentSession;
  currentSession = null;
  void destroySession(session);
});

// Restore a usable player when the browser returns to a cached page.
window.addEventListener("pageshow", function (event) {
  if (event.persisted) {
    stopped = false;
    void pollCatalog(true);
  }
});

const setupPanel = document.getElementById("setupPanel");
const setupForm = document.getElementById("setupForm");
const lookupKind = document.getElementById("lookupKind");
const lookupValue = document.getElementById("lookupValue");
const streamInput = document.getElementById("streamInput");

setupForm.addEventListener("submit", function (event) {
  event.preventDefault();
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set(lookupKind.value, lookupValue.value.trim());
  if (lookupKind.value !== "url") url.searchParams.set("stream", streamInput.value || "1");
  location.assign(url.href);
});

sourceSelect.disabled = true;
playerSelect.disabled = true;
try {
  selector = parseSelector(new URLSearchParams(location.search), location.pathname);
  if (selector) {
    loadCatalog = createCatalogLoader(config);
    setupPanel.hidden = true;
    showStatus("Loading stream sources...", true, false);
    void pollCatalog(true);
  } else {
    setupPanel.hidden = false;
    showStatus("Enter a fixture name, match ID, or stream URL to begin.", false, false);
  }
} catch (error) {
  setupPanel.hidden = false;
  showStatus(error.message, false, false);
}
