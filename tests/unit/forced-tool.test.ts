/**
 * A plain weather question must reach get_weather even when the model answers it from
 * memory ("it is sunny", "I'll check right away") without calling the tool: the first
 * round's text is dropped unspoken and the call is made for it. A model that did call the
 * tool is left alone.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, StreamItem } from "../../src/clients/llm";
import { Config } from "../../src/config";
import { Assistant } from "../../src/harness/assistant";
import { Tools } from "../../src/tools";

type Plan = { calls?: { name: string; args: string }[]; text?: string };

const dirs: string[] = [];
const realFetch = globalThis.fetch;
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const FORECAST = {
  current: {
    time: "2026-01-01T12:00",
    temperature_2m: 20,
    apparent_temperature: 19,
    weather_code: 0,
    relative_humidity_2m: 50,
    wind_speed_10m: 5,
  },
  daily: {
    temperature_2m_max: [22],
    temperature_2m_min: [14],
    precipitation_probability_max: [10],
    weather_code: [0],
  },
};
const GEO = {
  results: [
    {
      name: "Lisbon",
      country: "Portugal",
      timezone: "Europe/Lisbon",
      latitude: 38.7,
      longitude: -9.1,
    },
  ],
};

function scripted(plans: Plan[]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-forced-"));
  dirs.push(tmp);
  const cfg = Config.fromEnv();
  cfg.llmEnableTools = true;
  cfg.llmViaPi = false;
  cfg.toolGate = false;
  cfg.locale = "en";
  const a = new Assistant(cfg, null, "null");
  a.log = () => {};
  a.tools = new Tools({
    dataDir: path.join(tmp, "data"),
    announce: () => {},
    cmdMode: "off",
    weatherTools: true,
    history: () => a.history,
  });
  const spoken: string[] = [];
  const requests: ChatMessage[][] = [];
  a.emit = () => {};
  const stub = a as unknown as { llm: unknown; tts: unknown; player: unknown };
  stub.llm = {
    stream: async function* (messages: ChatMessage[]): AsyncGenerator<StreamItem> {
      requests.push(structuredClone(messages));
      const plan = plans.shift();
      if (plan?.calls?.length) {
        yield {
          kind: "tool_calls",
          calls: plan.calls.map((c, i) => ({
            id: `c${requests.length}-${i}`,
            type: "function",
            function: { name: c.name, arguments: c.args },
          })),
        };
      }
      if (plan?.text) yield { kind: "text", text: plan.text };
    },
    resetSession: () => {},
  };
  stub.tts = { stream: async function* (): AsyncGenerator<Uint8Array> {} };
  stub.player = {
    busy: false,
    paused: false,
    audible: false,
    flush: () => {},
    beginSegment: (s: string) => spoken.push(s),
    endSegment: () => {},
    enqueue: () => {},
  };
  return { a, spoken, requests };
}

async function turn(a: Assistant, text: string): Promise<void> {
  a.startResponse(text, Date.now());
  await a.resp?.task;
}

function stubOpenMeteo(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (u: string | URL | Request) => {
    const url = String(u);
    urls.push(url);
    return new Response(JSON.stringify(url.includes("geocoding") ? GEO : FORECAST), {
      status: 200,
    });
  }) as typeof fetch;
  return urls;
}

describe("forced tool call", () => {
  test("a weather question answered without the tool: the invented text is dropped, the tool runs", async () => {
    const urls = stubOpenMeteo();
    const { a, spoken, requests } = scripted([
      { text: "It is sunny and 30 degrees, no need to worry." },
      { text: "It is 20 degrees and clear in Lisbon." },
    ]);
    await turn(a, "what's the weather like in Lisbon?");
    expect(urls.some((u) => u.includes("api.open-meteo.com/v1/forecast"))).toBe(true);
    expect(spoken.join(" ")).not.toContain("30 degrees");
    expect(spoken.join(" ")).toContain("20 degrees");
    const toolMsg = requests[1]?.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("Weather in Lisbon, Portugal");
  });

  test("a model that called the tool itself is left alone (one call, no extra)", async () => {
    const urls = stubOpenMeteo();
    const { a, spoken } = scripted([
      { calls: [{ name: "get_weather", args: '{"location":"Lisbon"}' }] },
      { text: "Clear and 20 degrees." },
    ]);
    await turn(a, "what's the weather like in Lisbon?");
    expect(urls.filter((u) => u.includes("/v1/forecast"))).toHaveLength(1);
    expect(spoken.join(" ")).toContain("20 degrees");
  });

  test("not a weather question → plain text is spoken as is", async () => {
    const urls = stubOpenMeteo();
    const { a, spoken } = scripted([{ text: "Once upon a time." }]);
    await turn(a, "tell me a story");
    expect(urls).toHaveLength(0);
    expect(spoken.join(" ")).toContain("Once upon a time");
  });
});
