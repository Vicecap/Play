import {
  safePlaybackUrl,
  detectStreamType,
  sourcesFromFixture,
  deduplicateSources,
  findMatchingFixtures,
} from "./sources.js";

const MAX_FIXTURES = 5000;
const MAX_PAGES = 20;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TYPES = ["hls", "dash", "flv", "native", "youtube", "iframe"];

export function parseSelector(params, pathname = "/") {
  const names = ["fixture", "fixture_key", "id", "stream", "url", "type"];
  for (const name of names) {
    if (params.getAll(name).length > 1) {
      throw new Error("Query parameters must contain one value.");
    }
  }
  const fixtureQuery = (params.get("fixture") || "").trim();
  const fixtureKey = (params.get("fixture_key") || "").trim();
  const idQuery = (params.get("id") || "").trim();
  const directUrl = (params.get("url") || "").trim();
  const directType = (params.get("type") || "").trim();
  if ([fixtureQuery, fixtureKey, idQuery].some((value) => value.length > 200)) {
    throw new Error("Fixture name, fixture key, or match ID is too long.");
  }
  const streamNumber = params.has("stream") ? Number(params.get("stream")) : 1;
  if (!Number.isSafeInteger(streamNumber) || streamNumber < 1 || streamNumber > 100) {
    throw new Error("Stream number must be an integer from 1 to 100.");
  }
  if (directUrl && !safePlaybackUrl(directUrl)) {
    throw new Error("Use a public HTTPS stream URL without embedded credentials.");
  }
  if (directType && !TYPES.includes(directType)) {
    throw new Error("Unsupported stream type. Use hls, dash, flv, native, youtube, or iframe.");
  }
  if (!fixtureQuery && !fixtureKey && !idQuery && !directUrl) return null;
  const mode = /\/embed-dash(?:\/|\/index\.html)?$/.test(pathname)
    ? "dash"
    : /\/embed-legacy(?:\/|\/index\.html)?$/.test(pathname) ? "hls" : null;
  return { fixtureQuery, fixtureKey, idQuery, streamNumber, directUrl, directType, mode };
}

function publicEndpoint(value, name) {
  const url = safePlaybackUrl(value);
  if (!url) throw new Error(name + " in config.js must be a public HTTPS URL.");
  return url;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function fixtureList(data) {
  if (!Array.isArray(data?.fixtures)) throw new Error("The provider returned an invalid fixture list.");
  return data.fixtures.filter((fixture) => fixture && typeof fixture === "object").slice(0, MAX_FIXTURES);
}

// Fetches happen in the visitor's browser, with normal CORS enforcement.
// A separate loader instance owns its fetch dependency, which also permits offline tests.
export function createCatalogLoader(config, fetchImpl = globalThis.fetch) {
  const upstream = publicEndpoint(config.upstreamBase, "upstreamBase").replace(/\/$/, "");
  const secondary = config.fixturesUrl ? publicEndpoint(config.fixturesUrl, "fixturesUrl") : "";
  const timeoutMs = positiveInteger(config.requestTimeoutMs, 8000);
  const pollMs = Math.max(5000, positiveInteger(config.pollMs, 10000));

  async function fetchJson(url, parentSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal?.aborted) abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Provider request failed (HTTP " + response.status + ").");
      if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
        throw new Error("The provider response is too large.");
      }
      const body = await response.text();
      if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
        throw new Error("The provider response is too large.");
      }
      try { return JSON.parse(body); }
      catch { throw new Error("The provider returned invalid JSON."); }
    } catch (error) {
      if (parentSignal?.aborted) throw new DOMException("Request cancelled", "AbortError");
      if (controller.signal.aborted) throw new Error("The stream provider took too long to respond. Try again.");
      if (error instanceof TypeError) {
        throw new Error("Cannot reach the stream provider. Check your connection; the provider must allow this site's origin through CORS.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  }

  async function primaryFixture(selector, signal) {
    const url = new URL(upstream + "/fixtures");
    if (selector.idQuery) url.searchParams.set("id", selector.idQuery);
    else url.searchParams.set("fixture", selector.fixtureQuery || selector.fixtureKey);
    url.searchParams.set("stream", String(selector.streamNumber));
    const fixtures = fixtureList(await fetchJson(url.href, signal));
    return fixtures.find((fixture) => Number(fixture.stream_number) === selector.streamNumber) || fixtures[0] || null;
  }

  async function secondaryFixtures(signal) {
    if (!secondary) return [];
    const url = new URL(secondary);
    url.searchParams.set("page", "1");
    url.searchParams.set("limit", "500");
    const first = await fetchJson(url.href, signal);
    const fixtures = fixtureList(first);
    const pages = Math.min(
      positiveInteger(first.pages, 1), MAX_PAGES,
      Math.ceil(MAX_FIXTURES / positiveInteger(first.limit, 500)),
    );
    // Small batches avoid a burst of requests per visitor on every refresh.
    for (let page = 2; page <= pages && fixtures.length < MAX_FIXTURES; page += 4) {
      const batch = await Promise.all(Array.from({ length: Math.min(4, pages - page + 1) }, (_, index) => {
        const nextUrl = new URL(url);
        nextUrl.searchParams.set("page", String(page + index));
        return fetchJson(nextUrl.href, signal).then(fixtureList);
      }));
      fixtures.push(...batch.flat());
    }
    return fixtures.slice(0, MAX_FIXTURES);
  }

  async function dashChannel(selector, signal) {
    if (!selector.idQuery) return null;
    const channels = await fetchJson(upstream + "/dash-channels", signal);
    if (!Array.isArray(channels)) throw new Error("The provider returned an invalid DASH channel list.");
    return channels.find((channel) => String(channel?.id || "").trim().toLowerCase() === selector.idQuery.toLowerCase()) || null;
  }

  function catalogFor(selector, sources, title, diagnostics = {}) {
    return {
      match: { title: title || selector.fixtureQuery || selector.fixtureKey || selector.idQuery || "Live stream" },
      sources: deduplicateSources(sources).filter((source) => !selector.mode || source.type === selector.mode),
      pollMs,
      refreshedAt: Date.now(),
      diagnostics,
    };
  }

  return async function loadCatalog(selector, signal) {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    if (selector.directUrl) {
      const type = detectStreamType(selector.directUrl, selector.directType || "hls");
      const field = { hls: "m3u8", dash: "mpd", flv: "flv", youtube: "youtube", iframe: "iframe", native: "url" }[type];
      const sources = sourcesFromFixture({ [field]: selector.directUrl }, "Direct").map((source) => ({
        ...source,
        type,
        label: "DIRECT " + type.toUpperCase(),
      }));
      return catalogFor(selector, sources, "Live stream");
    }

    const results = await Promise.allSettled([
      primaryFixture(selector, signal),
      secondaryFixtures(signal),
      selector.mode === "dash" ? dashChannel(selector, signal) : Promise.resolve(null),
    ]);
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    const value = (index, fallback) => results[index].status === "fulfilled" ? results[index].value : fallback;
    const primary = value(0, null);
    const matching = findMatchingFixtures(value(1, []), selector, primary);
    const channel = value(2, null);
    const exclusions = [];
    let sources = [
      ...sourcesFromFixture(channel, "DASH", exclusions),
      ...sourcesFromFixture(primary, null, exclusions),
      ...matching.fixtures.flatMap((fixture) => sourcesFromFixture(fixture, "VNRES", exclusions)),
    ];

    // Match /embed-dash?id=... and also allow a channel ID in the universal player.
    if (!sources.length && selector.idQuery && selector.mode !== "dash") {
      try { sources = sourcesFromFixture(await dashChannel(selector, signal), "DASH", exclusions); }
      catch (error) { results.push({ status: "rejected", reason: error }); }
    }
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason.message);
    const firstMatch = primary || matching.fixtures[0] || channel;
    const catalog = catalogFor(selector, sources,
      firstMatch?.fixture_en || firstMatch?.fixture_original || firstMatch?.channelName,
      { matching, exclusions, errors },
    );
    if (!catalog.sources.length && errors.length) throw new Error(errors[0]);
    return catalog;
  };
}
