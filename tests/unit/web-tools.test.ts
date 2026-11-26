/**
 * web_search (SearXNG), get_weather / set_user_location (Open-Meteo) and the location in
 * data/settings.json — all with a stubbed fetch, no network.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasInterruptMarker, stripInterruptMarkers } from "../../src/harness/text";
import { loadLocation, saveLocation, type UserLocation } from "../../src/settings";
import { GATE_EXEMPT_TOOLS, SCHEMAS, Tools } from "../../src/tools";
import {
  forcedTool,
  geocode,
  getWeather,
  searchIntent,
  weatherIntent,
  weatherWords,
  webSearch,
} from "../../src/web-tools";

const HOME: UserLocation = {
  city: "Lisbon",
  country: "Portugal",
  timezone: "Europe/Lisbon",
  lat: 38.72,
  lon: -9.14,
};
const SEARX = "http://searx.example:8888";

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

const GEO = {
  results: [
    {
      name: "Valencia",
      country: "Venezuela",
      country_code: "VE",
      timezone: "America/Caracas",
      latitude: 10.16,
      longitude: -68.0,
    },
    {
      name: "Valencia",
      country: "Spain",
      country_code: "ES",
      admin1: "Valencia",
      timezone: "Europe/Madrid",
      latitude: 39.47,
      longitude: -0.38,
    },
  ],
};
const FORECAST = {
  current: {
    time: "2026-01-15T13:30",
    temperature_2m: 33.3,
    apparent_temperature: 36.9,
    weather_code: 3,
    relative_humidity_2m: 44,
    wind_speed_10m: 7.2,
  },
  daily: {
    temperature_2m_max: [34.1],
    temperature_2m_min: [25.2],
    precipitation_probability_max: [20],
    weather_code: [80],
  },
};

describe("web_search", () => {
  test("top results: title, url, snippet; duplicates dropped; at most 5", async () => {
    let asked = "";
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `T${i}`,
      url: `https://x/${i}`,
      content: `snippet ${i}`,
    }));
    results.splice(1, 0, { title: "dup", url: "https://x/0", content: "" });
    const out = await webSearch("lisbon news", SEARX, undefined, async (u) => {
      asked = u;
      return json({ results });
    });
    expect(asked).toContain("format=json");
    expect(asked).toContain("q=lisbon%20news");
    expect(asked.startsWith(`${SEARX}/search?`)).toBe(true);
    expect(out).toContain("1. T0 — https://x/0");
    expect(out).toContain("   snippet 0");
    expect(out).toContain("5. T4");
    expect(out).not.toContain("T5");
    expect(out).not.toContain("dup");
  });

  test("a dead SearXNG is a sentence, not a throw", async () => {
    const out = await webSearch("x", SEARX, undefined, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(out).toMatch(/not available/);
  });
});

describe("get_weather", () => {
  test("geocodes, picks the country from the hint, reports words for the WMO code", async () => {
    const urls: string[] = [];
    const out = await getWeather("Valencia, Spain", HOME, undefined, async (u) => {
      urls.push(u);
      return json(u.includes("geocoding") ? GEO : FORECAST);
    });
    expect(urls[1]).toContain("latitude=39.47");
    expect(out).toContain("Valencia, Spain");
    expect(out).toContain("33 °C");
    expect(out).toContain("overcast");
    expect(out).toContain("high 34 °C, low 25 °C");
    expect(out).toContain("light rain showers");
    expect(out).toContain("chance of rain 20%");
  });

  test("no location → the saved one, no geocoding call", async () => {
    const urls: string[] = [];
    await getWeather("", HOME, undefined, async (u) => {
      urls.push(u);
      return json(FORECAST);
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`latitude=${HOME.lat}`);
  });

  test("unknown place → says so", async () => {
    const out = await getWeather("Nowhereville", HOME, undefined, async () => json({}));
    expect(out).toMatch(/no place called/);
  });

  test("no place given and none saved → asks, no network call", async () => {
    let calls = 0;
    const out = await getWeather("", null, undefined, async () => {
      calls++;
      return json({});
    });
    expect(calls).toBe(0);
    expect(out).toMatch(/not known/);
  });

  test("WMO codes", () => {
    expect(weatherWords(0)).toBe("clear sky");
    expect(weatherWords(95)).toBe("thunderstorm");
    expect(weatherWords(42)).toBe("weather code 42");
  });

  test("geocode without hint takes the first match", async () => {
    const p = await geocode("Valencia", undefined, async () => json(GEO));
    expect(p?.country).toBe("Venezuela");
  });
});

describe("user location in data/settings.json", () => {
  test("none until saved; save keeps the drawer's keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonia-loc-"));
    const file = path.join(dir, "settings.json");
    expect(loadLocation(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ bargeIn: true }));
    saveLocation(file, HOME);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(raw.bargeIn).toBe(true);
    expect(loadLocation(file)?.city).toBe("Lisbon");
    fs.writeFileSync(
      file,
      JSON.stringify({ location: { city: "X", timezone: "Not/AZone", lat: 1, lon: 2 } }),
    );
    expect(loadLocation(file)).toBeNull(); // unusable → none
  });

  test("get_datetime answers in the user's time zone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonia-loc-"));
    saveLocation(path.join(dir, "settings.json"), HOME);
    const tools = new Tools({ dataDir: dir, announce: () => {}, locale: "en" });
    const out = await tools.call("get_datetime", "{}");
    expect(out).toContain("Lisbon, Europe/Lisbon");
  });
});

describe("registration", () => {
  const offered = (opts: { searxngUrl?: string; weatherTools?: boolean }) =>
    new Tools({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "sonia-reg-")),
      announce: () => {},
      ...opts,
    })
      .schemas()
      .map((s) => (s.function as { name: string }).name);

  test("web_search needs a SearXNG URL; the weather tools need WEATHER_TOOLS", () => {
    const none = offered({});
    for (const n of ["web_search", "get_weather", "set_user_location"])
      expect(none).not.toContain(n);
    const all = offered({ searxngUrl: SEARX, weatherTools: true });
    for (const n of ["web_search", "get_weather", "set_user_location"]) expect(all).toContain(n);
    expect(offered({ weatherTools: true })).not.toContain("web_search");
    expect(offered({ searxngUrl: SEARX })).not.toContain("get_weather");
  });

  test("a tool that is switched off is unknown if the model calls it anyway", async () => {
    const tools = new Tools({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "sonia-reg-")),
      announce: () => {},
    });
    const out = await tools.call("web_search", '{"query":"x"}');
    expect(out).not.toMatch(/Web results/);
  });

  test("the new tools are declared, and the read-only ones skip the gate", () => {
    const names = SCHEMAS.map((s) => (s.function as { name: string }).name);
    for (const n of ["web_search", "get_weather", "set_user_location"]) expect(names).toContain(n);
    expect(GATE_EXEMPT_TOOLS.has("web_search")).toBe(true);
    expect(GATE_EXEMPT_TOOLS.has("get_weather")).toBe(true);
    expect(GATE_EXEMPT_TOOLS.has("set_user_location")).toBe(false);
  });
});

describe("weatherIntent (the get_weather safety net)", () => {
  test("weather questions, with and without a place", () => {
    expect(weatherIntent("what's the weather like?")).toEqual({});
    expect(weatherIntent("Can you check for the weather in Lisbon?")).toEqual({
      location: "Lisbon",
    });
    expect(weatherIntent("how hot is it in Madrid today?")).toEqual({ location: "Madrid" });
    expect(weatherIntent("is it going to rain tomorrow")).toEqual({});
    expect(weatherIntent("che tempo fa a Roma?")).toEqual({ location: "Roma" });
  });
  test("not weather", () => {
    expect(weatherIntent("tell me a story about the rain")).toBeNull();
    expect(weatherIntent("search the web for Portuguese news")).toBeNull();
    expect(weatherIntent("what time is it?")).toBeNull();
  });
});

describe("searchIntent / forcedTool", () => {
  test("explicit search requests → the query", () => {
    expect(searchIntent("search the web for the latest news about the Lisbon metro")).toEqual({
      query: "the latest news about the Lisbon metro",
    });
    expect(searchIntent("Look up the opening hours of the national museum.")).toEqual({
      query: "the opening hours of the national museum",
    });
    expect(searchIntent("google Lisbon property prices")).toEqual({
      query: "Lisbon property prices",
    });
    expect(searchIntent("tell me a story")).toBeNull();
  });
  test("search wins over weather; weather alone → get_weather", () => {
    expect(forcedTool("search the web for weather records in Madrid")?.name).toBe("web_search");
    expect(forcedTool("what's the weather like?")).toEqual({ name: "get_weather", args: {} });
    expect(forcedTool("hello")).toBeNull();
  });
});

describe("interruption marker", () => {
  test("stripped in both locales, with the leading ellipsis", () => {
    expect(
      stripInterruptMarkers("I'll check the weather in Lisbon. … [interrupted by the user]"),
    ).toBe("I'll check the weather in Lisbon.");
    expect(stripInterruptMarkers("Ecco. … [interrotto dall'utente]")).toBe("Ecco.");
    expect(stripInterruptMarkers("[interrupted by the user before speaking]")).toBe("");
    expect(stripInterruptMarkers("A normal [bracketed] sentence.")).toBe(
      "A normal [bracketed] sentence.",
    );
    expect(hasInterruptMarker("fine")).toBe(false);
  });
});
