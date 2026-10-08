// Browser copy of the fixture normalization in seerver.js. No Node dependencies.
const AUTH_EXPIRY_SAFETY_SECONDS = 15;

// Stable UI identity only; this hash is not used for authentication.
function stableId(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(String(value))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function rawUrl(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && typeof value.url === "string") {
    return value.url.trim();
  }
  return "";
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1"
  ) {
    return true;
  }

  if (/^(127|10)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }

  const private172 = host.match(/^172\.(\d{1,3})\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) {
    return true;
  }

  if (/^(fc|fd|fe8|fe9|fea|feb)[0-9a-f:]*$/i.test(host)) return true;
  if (/^::ffff:(?:7f|0*7f00):/i.test(host)) return true;
  if (/^::ffff:(?:a|0*a00):/i.test(host)) return true;
  if (/^::ffff:(?:a9fe|c0a8|ac(?:1[0-9a-f]|2[0-9a-f]|3[01])):/i.test(host)) return true;
  return false;
}

function safePlaybackUrl(value) {
  const raw = rawUrl(value);
  if (!raw || raw.length > 4096) return null;

  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:"
    ) {
      return null;
    }
    if (parsed.username || parsed.password || isPrivateHostname(parsed.hostname)) return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function playbackUrlRejectionReason(value) {
  const raw = rawUrl(value);
  if (!raw) return "empty URL";
  if (raw.length > 4096) return "URL exceeds 4096 characters";
  if (/^https?:\/\/?$/i.test(raw)) return "malformed or truncated URL";

  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:"
    ) {
      return parsed.protocol === "http:"
        ? "insecure HTTP playback URL is disabled"
        : `unsupported URL protocol ${parsed.protocol}`;
    }
    if (parsed.username || parsed.password) return "URL credentials are not allowed";
    if (isPrivateHostname(parsed.hostname)) return "private or reserved hostname is not allowed";
    return null;
  } catch {
    return "malformed or truncated URL";
  }
}

function youtubeVideoId(value) {
  const safeUrl = safePlaybackUrl(value);
  if (!safeUrl) return null;

  try {
    const parsed = new URL(safeUrl);
    const host = parsed.hostname.toLowerCase();
    let id = null;

    if (host === "youtu.be") {
      id = parsed.pathname.split("/").filter(Boolean)[0];
    } else if (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtube-nocookie.com" ||
      host === "www.youtube-nocookie.com"
    ) {
      id = parsed.searchParams.get("v");
      if (!id && /^\/(embed|live|shorts)\//.test(parsed.pathname)) {
        id = parsed.pathname.split("/").filter(Boolean)[1];
      }
    }

    return id && /^[a-zA-Z0-9_-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function youtubeEmbedUrl(value) {
  const id = youtubeVideoId(value);
  return id
    ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&playsinline=1`
    : null;
}

function epochMilliseconds(value) {
  const raw = String(value || "").trim();
  if (!/^\d{10,13}$/.test(raw)) return null;

  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric)) return null;
  const milliseconds = raw.length === 13 ? numeric : numeric * 1000;
  const earliest = Date.UTC(2020, 0, 1);
  const latest = Date.UTC(2100, 0, 1);
  return milliseconds >= earliest && milliseconds <= latest ? milliseconds : null;
}

function authExpiryMs(value) {
  const safeUrl = safePlaybackUrl(value);
  if (!safeUrl) return null;

  try {
    const parsed = new URL(safeUrl);
    const candidates = [];

    for (const [name, parameterValue] of parsed.searchParams) {
      const lowerName = name.toLowerCase();
      if (/^(exp|expires|expiry|expiration|token_exp)$/.test(lowerName)) {
        const expiry = epochMilliseconds(parameterValue);
        if (expiry) candidates.push(expiry);
      }

      if (/auth|token|hdnts|signature/.test(lowerName)) {
        const matches = String(parameterValue).match(/\d{10,13}/g) || [];
        for (const match of matches) {
          const expiry = epochMilliseconds(match);
          if (expiry) candidates.push(expiry);
        }
      }
    }

    return candidates.length ? Math.min(...candidates) : null;
  } catch {
    return null;
  }
}

function urlIsFresh(value, safetySeconds = AUTH_EXPIRY_SAFETY_SECONDS) {
  const expiry = authExpiryMs(value);
  return expiry === null || expiry > Date.now() + safetySeconds * 1000;
}

function canonicalStreamUrl(value) {
  const safeUrl = safePlaybackUrl(value);
  if (!safeUrl) return null;

  const parsed = new URL(safeUrl);
  const volatileName = /^(auth_key|auth|token|sig|signature|expires|expiry|exp|hdnts)$/i;
  for (const name of [...parsed.searchParams.keys()]) {
    if (volatileName.test(name)) parsed.searchParams.delete(name);
  }
  parsed.searchParams.sort();
  return parsed.href;
}

function detectStreamType(value, fallback = null) {
  const safeUrl = safePlaybackUrl(value);
  if (!safeUrl) return null;
  if (youtubeVideoId(safeUrl)) return "youtube";

  const pathname = new URL(safeUrl).pathname.toLowerCase();
  if (/\.m3u8(?:$|\/)/.test(pathname)) return "hls";
  if (/\.mpd(?:$|\/)/.test(pathname)) return "dash";
  if (/\.flv(?:$|\/)/.test(pathname)) return "flv";
  if (/\.(mp4|webm|ogv|ogg)(?:$|\/)/.test(pathname)) return "native";
  return ["hls", "dash", "flv", "native", "iframe", "youtube"].includes(fallback)
    ? fallback
    : null;
}

function normalizeMatchName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(vs?|versus)\b/g, " ")
    .replace(/\butd\b/g, " united ")
    .replace(/\b(fc|cf|sc|afc|football club)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalMatchName(value) {
  const normalized = normalizeMatchName(value);
  return normalized ? [...new Set(normalized.split(" "))].sort().join(" ") : "";
}

function fixtureNames(fixture) {
  if (!fixture || typeof fixture !== "object") return [];

  const values = [
    fixture.fixture_key,
    fixture.fixture_en,
    fixture.fixture_original,
    fixture.fixture,
    fixture.title,
    fixture.name,
  ];
  const home =
    fixture.home_team || fixture.homeTeam || fixture.team_home || fixture.home;
  const away =
    fixture.away_team || fixture.awayTeam || fixture.team_away || fixture.away;
  const homeName = typeof home === "object" ? home?.name : home;
  const awayName = typeof away === "object" ? away?.name : away;
  if (homeName && awayName) values.push(`${homeName} ${awayName}`);

  return [...new Set(values.map(normalizeMatchName).filter(Boolean))];
}

function nameSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const a = new Set(left.split(" "));
  const b = new Set(right.split(" "));
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function findMatchingFixtures(fixtures, selector, primaryFixture) {
  const exactKeys = new Set(
    [selector.fixtureKey, primaryFixture?.fixture_key]
      .map(canonicalMatchName)
      .filter(Boolean)
  );
  const wantedNames = new Set([
    ...exactKeys,
    canonicalMatchName(selector.fixtureQuery),
    ...fixtureNames(primaryFixture).map(canonicalMatchName),
  ]);
  wantedNames.delete("");

  const idMatches = fixtures.filter(
    (fixture) =>
      selector.idQuery &&
      [fixture?.id, fixture?.room_id].some(
        (value) =>
          String(value || "").toLowerCase() === selector.idQuery.toLowerCase()
      )
  );
  if (idMatches.length) {
    return { fixtures: idMatches, method: "id", score: 1, wantedNames: [...wantedNames] };
  }

  const exactMatches = fixtures.filter((fixture) => {
    const key = canonicalMatchName(fixture?.fixture_key);
    if (key && exactKeys.has(key)) return true;
    return fixtureNames(fixture)
      .map(canonicalMatchName)
      .some((name) => wantedNames.has(name));
  });
  if (exactMatches.length) {
    return {
      fixtures: exactMatches,
      method: "normalized-name",
      score: 1,
      wantedNames: [...wantedNames],
    };
  }

  const scored = [];
  let bestScore = 0;
  for (const fixture of fixtures) {
    let fixtureScore = 0;
    for (const wanted of wantedNames) {
      for (const candidate of fixtureNames(fixture)) {
        const score = nameSimilarity(wanted, candidate);
        fixtureScore = Math.max(fixtureScore, score);
      }
    }
    if (fixtureScore > 0) scored.push({ fixture, score: fixtureScore });
    bestScore = Math.max(bestScore, fixtureScore);
  }

  return {
    fixtures:
      bestScore >= 0.8
        ? scored.filter(({ score }) => score === bestScore).map(({ fixture }) => fixture)
        : [],
    method: bestScore >= 0.8 ? "similarity" : "none",
    score: bestScore,
    wantedNames: [...wantedNames],
  };
}

function normalizedClearKey(value) {
  if (!value) return null;

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      const pairs = value.match(/[a-fA-F0-9]{32}/g) || [];
      if (pairs.length >= 2) return { keyId: pairs[0], key: pairs[1] };
      return null;
    }
  }

  const clearKeys = parsed?.clearKeys || parsed?.drmConfig?.clearKeys || parsed;
  if (!clearKeys || typeof clearKeys !== "object") return null;

  const explicitKeyId = clearKeys.keyId || clearKeys.key_id || clearKeys.kid;
  const explicitKey = clearKeys.key || clearKeys.content_key;
  if (
    /^[a-fA-F0-9]{32}$/.test(String(explicitKeyId || "")) &&
    /^[a-fA-F0-9]{32}$/.test(String(explicitKey || ""))
  ) {
    return { keyId: String(explicitKeyId), key: String(explicitKey) };
  }

  for (const [keyId, key] of Object.entries(clearKeys)) {
    if (/^[a-fA-F0-9]{32}$/.test(keyId) && /^[a-fA-F0-9]{32}$/.test(String(key))) {
      return { keyId, key: String(key) };
    }
  }

  return null;
}

function providerName(value, fallback) {
  const cleaned = String(value || fallback || "Primary")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 28);
  return (cleaned || fallback || "Primary").toUpperCase();
}

function sourcesFromFixture(fixture, providerFallback = null, diagnostics = []) {
  if (!fixture || typeof fixture !== "object") return [];

  const provider = providerName(
    fixture.source || fixture.anchor || providerFallback,
    providerFallback || "Primary"
  );
  const clearKey = normalizedClearKey(
    fixture.clearkey || fixture.clearKey || fixture.clear_key || fixture.drmConfig || fixture.drm
  );
  const sources = [];

  const add = (value, quality, fallbackType, field) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => add(entry, quality, fallbackType, `${field}[${index}]`));
      return;
    }
    if (value === undefined || value === null || value === "") return;

    const url = safePlaybackUrl(value);
    if (!url) {
      diagnostics.push({ fixtureKey: fixture.fixture_key || null, field, reason: playbackUrlRejectionReason(value) });
      return;
    }
    if (!urlIsFresh(url)) {
      diagnostics.push({ fixtureKey: fixture.fixture_key || null, field, reason: "signed URL is expired or inside the refresh safety window" });
      return;
    }

    const type = detectStreamType(url, fallbackType);
    if (!type) {
      diagnostics.push({ fixtureKey: fixture.fixture_key || null, field, reason: "unsupported or undetectable stream type" });
      return;
    }

    const playableUrl = type === "youtube" ? youtubeEmbedUrl(url) : url;
    if (!playableUrl) {
      diagnostics.push({ fixtureKey: fixture.fixture_key || null, field, reason: "invalid YouTube URL" });
      return;
    }

    const canonical = canonicalStreamUrl(playableUrl);
    const typeLabel =
      type === "dash"
        ? "MPD"
        : type === "youtube"
          ? "YOUTUBE"
          : type === "iframe"
            ? "EMBED"
            : type.toUpperCase();
    const qualityLabel = quality ? ` ${quality.toUpperCase()}` : "";
    const source = {
      id: stableId(`${provider}|${type}|${quality || "auto"}|${canonical}`),
      provider,
      label: `${provider} ${typeLabel}${qualityLabel}`,
      type,
      quality: quality || "auto",
      url: playableUrl,
      expiresAt: authExpiryMs(url),
    };
    if (type === "dash" && clearKey) source.drm = clearKey;
    sources.push(source);
  };

  add(fixture.m3u8_hd, "hd", "hls", "m3u8_hd");
  add(fixture.m3u8_sd, "sd", "hls", "m3u8_sd");
  add(fixture.m3u8, null, "hls", "m3u8");
  add(fixture.hls_url || fixture.hls, null, "hls", fixture.hls_url ? "hls_url" : "hls");
  add(fixture.flv_hd, "hd", "flv", "flv_hd");
  add(fixture.flv_sd, "sd", "flv", "flv_sd");
  add(fixture.flv_url || fixture.flv, null, "flv", fixture.flv_url ? "flv_url" : "flv");
  add(fixture.mpd, null, "dash", "mpd");
  add(fixture.manifestUri, null, "dash", "manifestUri");
  add(fixture.manifest_uri, null, "dash", "manifest_uri");
  add(fixture.mpd_url || fixture.dash_url, null, "dash", fixture.mpd_url ? "mpd_url" : "dash_url");
  add(fixture.youtube, null, "youtube", "youtube");
  add(fixture.iframe, null, "iframe", "iframe");
  add(fixture.iframe_url, null, "iframe", "iframe_url");
  add(fixture.embed_url || fixture.embed, null, "iframe", fixture.embed_url ? "embed_url" : "embed");
  add(fixture.stream_url || fixture.url, null, "iframe", fixture.stream_url ? "stream_url" : "url");

  return sources;
}

function deduplicateSources(sources, diagnostics = null) {
  const unique = new Map();

  for (const source of sources) {
    if (!source?.url || !urlIsFresh(source.url)) {
      diagnostics?.push({
        fixtureKey: null,
        field: source?.label || "unknown",
        reason: "source was removed during final freshness validation",
      });
      continue;
    }
    const identity = `${source.type}|${canonicalStreamUrl(source.url)}`;
    const existing = unique.get(identity);
    if (!existing || (source.expiresAt || Infinity) > (existing.expiresAt || Infinity)) {
      if (existing) {
        diagnostics?.push({
          fixtureKey: null,
          field: existing.label,
          reason: `duplicate stream replaced by fresher ${source.label}`,
        });
      }
      unique.set(identity, source);
    } else {
      diagnostics?.push({
        fixtureKey: null,
        field: source.label,
        reason: `duplicate stream already supplied by ${existing.label}`,
      });
    }
  }

  return [...unique.values()];
}


export { safePlaybackUrl, detectStreamType, sourcesFromFixture, deduplicateSources, findMatchingFixtures };
