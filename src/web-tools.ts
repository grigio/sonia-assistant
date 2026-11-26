/**
 * Read-only internet tools.
 *
 *   web_search        → a SearXNG instance's JSON API (`SEARXNG_URL`; the tool is off
 *                       while it is empty). SearXNG itself queries public search engines.
 *   get_weather       → Open-Meteo geocoding + forecast (public, no key).
 *   set_user_location → Open-Meteo geocoding, saved into data/settings.json.
 *
 * Every call has its own timeout and a plain-text result the model can read aloud; a
 * failure is a sentence, never a thrown turn.
 */

import type { UserLocation } from "./settings";

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 12_000;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function withTimeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function getJson(url: string, signal: AbortSignal | undefined, f: FetchFn): Promise<unknown> {
  const r = await f(url, { signal: withTimeout(signal), headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

// ── web_search ──

export type SearchHit = { title: string; url: string; snippet: string };

export async function webSearch(
  query: string,
  baseUrl: string,
  signal?: AbortSignal,
  f: FetchFn = fetch,
  n = 5,
): Promise<string> {
  const q = query.trim();
  if (!q) return "web_search: no query given.";
  let data: { results?: unknown[]; answers?: unknown[]; infoboxes?: unknown[] };
  try {
    data = (await getJson(
      `${baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0`,
      signal,
      f,
    )) as typeof data;
  } catch (e) {
    if (signal?.aborted) throw e;
    return `web_search failed: the search service did not answer (${e instanceof Error ? e.message : e}). Tell the user the search is not available right now.`;
  }
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const raw of data.results ?? []) {
    const r = raw as Record<string, unknown>;
    const url = String(r.url ?? "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    hits.push({
      title: clip(String(r.title ?? ""), 140),
      url,
      snippet: clip(String(r.content ?? ""), 300),
    });
    if (hits.length >= n) break;
  }
  const answers = (data.answers ?? [])
    .map((a) => (typeof a === "string" ? a : String((a as Record<string, unknown>).answer ?? "")))
    .filter(Boolean)
    .slice(0, 2);
  if (!hits.length && !answers.length) return `web_search: no results for «${q}».`;
  const lines = [`Web results for «${q}» (answer from these, name the source briefly):`];
  for (const a of answers) lines.push(`Answer: ${clip(a, 300)}`);
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.title} — ${h.url}`);
    if (h.snippet) lines.push(`   ${h.snippet}`);
  });
  return lines.join("\n");
}

// ── geocoding ──

export type Place = UserLocation & { admin?: string };

/**
 * "Valencia, Spain" / "Lisbon" → the best Open-Meteo match. The API matches names
 * only, so a ", country" (or ", region") suffix is used to pick among the candidates.
 */
export async function geocode(
  query: string,
  signal?: AbortSignal,
  f: FetchFn = fetch,
): Promise<Place | null> {
  const [name, ...rest] = query.split(",").map((s) => s.trim());
  if (!name) return null;
  const hint = rest.join(" ").toLowerCase();
  const data = (await getJson(
    `${GEO_URL}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`,
    signal,
    f,
  )) as { results?: Record<string, unknown>[] };
  const res = data.results ?? [];
  if (!res.length) return null;
  const pick =
    (hint &&
      res.find((r) =>
        [r.country, r.country_code, r.admin1].some(
          (v) => typeof v === "string" && v.toLowerCase().includes(hint),
        ),
      )) ||
    res[0]!;
  return {
    city: String(pick.name ?? name),
    country: String(pick.country ?? ""),
    timezone: String(pick.timezone ?? "UTC"),
    lat: Number(pick.latitude),
    lon: Number(pick.longitude),
    admin: typeof pick.admin1 === "string" ? pick.admin1 : undefined,
  };
}

// ── get_weather ──

/** WMO weather interpretation codes (Open-Meteo docs) → words. */
export const WMO: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "light freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light rain showers",
  81: "rain showers",
  82: "violent rain showers",
  85: "light snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with light hail",
  99: "thunderstorm with heavy hail",
};

export const weatherWords = (code: unknown): string =>
  WMO[Number(code)] ?? `weather code ${String(code)}`;

const r0 = (v: unknown) => (typeof v === "number" ? Math.round(v) : "?");

export async function getWeather(
  where: string,
  fallback: UserLocation | null,
  signal?: AbortSignal,
  f: FetchFn = fetch,
): Promise<string> {
  let place: UserLocation | null = fallback;
  if (!where.trim() && !place) {
    return "get_weather: the user's location is not known. Ask which city they mean (or where they are, then call set_user_location).";
  }
  try {
    if (where.trim()) place = await geocode(where, signal, f);
  } catch (e) {
    if (signal?.aborted) throw e;
    return `get_weather failed: the place lookup did not answer (${e instanceof Error ? e.message : e}).`;
  }
  if (!place)
    return `get_weather: no place called «${where}» was found. Ask the user to repeat the place name.`;
  const url =
    `${FORECAST_URL}?latitude=${place.lat}&longitude=${place.lon}` +
    "&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
    "&timezone=auto&forecast_days=1";
  let d: Record<string, Record<string, unknown>>;
  try {
    d = (await getJson(url, signal, f)) as typeof d;
  } catch (e) {
    if (signal?.aborted) throw e;
    return `get_weather failed: the weather service did not answer (${e instanceof Error ? e.message : e}).`;
  }
  const c = d.current ?? {};
  const day = d.daily ?? {};
  const first = (k: string) => (Array.isArray(day[k]) ? (day[k] as unknown[])[0] : undefined);
  const localTime = String(c.time ?? "").split("T")[1] ?? "";
  const name = [place.city, place.country].filter(Boolean).join(", ");
  const rain = first("precipitation_probability_max");
  return (
    `Weather in ${name}${localTime ? ` (local time ${localTime})` : ""}: ` +
    `${r0(c.temperature_2m)} °C, feels like ${r0(c.apparent_temperature)} °C, ` +
    `${weatherWords(c.weather_code)}, humidity ${r0(c.relative_humidity_2m)}%, ` +
    `wind ${r0(c.wind_speed_10m)} km/h. ` +
    `Today: high ${r0(first("temperature_2m_max"))} °C, low ${r0(first("temperature_2m_min"))} °C, ` +
    `${weatherWords(first("weather_code"))}, chance of rain ${rain === undefined || rain === null ? "unknown" : `${r0(rain)}%`}. ` +
    "(Source: Open-Meteo.)"
  );
}

// ── weather intent (the safety net in Assistant.runResponse) ──

const WEATHER = new RegExp(
  "\\b(?:weather|forecast|meteo|che tempo fa|previsioni del tempo|" +
    "how (?:hot|cold|warm) is it|is it (?:hot|cold|raining|sunny|going to rain)|" +
    "will it (?:rain|snow)|going to rain|chance of rain|temperature (?:outside|today|now|in)|" +
    "piover[àa]|sta piovendo|fa (?:caldo|freddo))(?![\\p{L}\\d])",
  "iu",
);
const PLACE = /\b(?:in|at|for|a|ad)\s+(\p{Lu}[\p{L}'’-]*(?:[ ,]+\p{Lu}[\p{L}'’-]*)*)/u;

/**
 * A plain weather question ("what's the weather like?", "how hot is it in Madrid?") →
 * the get_weather arguments it implies; `null` for anything else. Measured on a 30B
 * model: with the user's city in the prompt it still invents the weather in a share of
 * samples, so a weather question that ends its first round without the tool gets the
 * call made for it.
 */
export function weatherIntent(text: string): { location?: string } | null {
  if (!WEATHER.test(text)) return null;
  const m = PLACE.exec(text);
  const place = m?.[1]?.trim();
  return place ? { location: place } : {};
}

const SEARCH =
  /\b(?:search(?: the web| online| the internet| google)?(?: for)?|look up|google|find (?:me )?(?:online|on the web)|cerca(?: su internet| online| in rete| sul web)?)\s+(.{3,})$/iu;

/**
 * An explicit search request ("search the web for X", "look up X", "google X") → the
 * web_search query; `null` otherwise. With a long history the model sometimes answers
 * "I'll search for … right away" and calls nothing.
 */
export function searchIntent(text: string): { query: string } | null {
  const m = SEARCH.exec(text.trim());
  if (!m) return null;
  const query = m[1]!
    .replace(/^(?:about|for|on|per|su)\s+/i, "")
    .replace(/[?.!]+$/, "")
    .trim();
  return query.length >= 3 ? { query } : null;
}

/** The tool a request plainly asks for (the harness' safety net), if any. */
export function forcedTool(text: string): { name: string; args: Record<string, string> } | null {
  const s = searchIntent(text);
  if (s) return { name: "web_search", args: s };
  const w = weatherIntent(text);
  if (w) return { name: "get_weather", args: w as Record<string, string> };
  return null;
}
