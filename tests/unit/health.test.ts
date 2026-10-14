/**
 * `src/health.ts` and the one state its liveness drives: a dead ASR/TTS/LLM server must
 * put the header orb on `offline` (it used to stay green forever — nothing ever called
 * `probe`/`probeAll`), while a dead Smart Turn only degrades turn-taking. The mic source
 * signals the same state out of band, through `Assistant.setMicDown()`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Config } from "../../src/config";
import type { StateName } from "../../src/events";
import { healthUrl, llmHealthUrl, probe, probeAll } from "../../src/health";
import { Assistant } from "../../src/harness/assistant";

/** One liveness round, normally scheduled by `startHealthPoll()` every 10 s. */
async function poll(a: Assistant): Promise<void> {
  await (a as unknown as { pollHealth: () => Promise<void> }).pollHealth();
}

/** A port nothing listens on: a connection there is refused, so the server is "down". */
async function deadPort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

/** `GET /health` → 200, anything else → 404 (both mean "the server is up"). */
function liveServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');
    } else res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

describe("probe / probeAll (audio.cpp liveness)", () => {
  let live: { url: string; close: () => Promise<void> };
  let dead: string;

  beforeAll(async () => {
    live = await liveServer();
    dead = `http://127.0.0.1:${await deadPort()}`;
  });
  afterAll(async () => {
    await live.close();
  });

  test("healthUrl points at /health, with or without a trailing slash", () => {
    expect(healthUrl("http://127.0.0.1:8091")).toBe("http://127.0.0.1:8091/health");
    expect(healthUrl("http://127.0.0.1:8091/")).toBe("http://127.0.0.1:8091/health");
  });

  test("llmHealthUrl strips the OpenAI `/v1` prefix: llama-server answers at the root", () => {
    expect(llmHealthUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/health");
    expect(llmHealthUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/health");
    expect(llmHealthUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/health");
  });

  test("any HTTP answer counts as up — even a 404", async () => {
    expect(await probe(`${live.url}/health`, 1000)).toBe(true);
    expect(await probe(`${live.url}/no-such-route`, 1000)).toBe(true);
  });

  test("a refused connection is down, not up", async () => {
    expect(await probe(`${dead}/health`, 1000)).toBe(false);
  });

  test("probeAll names only the servers that did not answer, in the order given", async () => {
    const targets = [
      { name: "asr", url: `${live.url}/health` },
      { name: "tts", url: `${dead}/health` },
      { name: "turn", url: `${dead}/health` },
    ];
    expect(await probeAll(targets, 1000)).toEqual(["tts", "turn"]);
    expect(await probeAll(targets.slice(0, 1), 1000)).toEqual([]);
  });
});

describe("a dead audio server flips the UI to offline", () => {
  let live: { url: string; close: () => Promise<void> };
  let up: string;
  let down: string;
  let cfg: Config;
  let a: Assistant;
  const states: StateName[] = [];
  const logs: string[] = [];
  /** Point the three servers at `up`/`down` URLs (each test says it out loud). */
  const setServers = (asr: string, tts: string, turn: string): void => {
    cfg.asrUrl = asr;
    cfg.ttsUrl = tts;
    cfg.turnUrl = turn;
  };

  beforeAll(async () => {
    live = await liveServer();
    up = live.url;
    down = `http://127.0.0.1:${await deadPort()}`;
    cfg = new Config();
    // the LLM leg is probed too (healthTargets): point it at the live server so it stays
    // out of the way of the audio assertions — the last test below takes it down on purpose
    cfg.llmBaseUrl = `${up}/v1`;
    a = new Assistant(cfg, null, "null");
    a.log = (m) => logs.push(m);
    a.emit = (ev) => {
      if (ev.type === "state") states.push(ev.state);
    };
  });
  afterAll(async () => {
    await live.close();
  });

  test("all three up → listening, and a round that changed nothing logs nothing", async () => {
    setServers(up, up, up);
    await poll(a);
    expect(a.state).toBe("listening");
    expect(states).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("ASR down → offline, and the log says which server died", async () => {
    setServers(down, up, up);
    await poll(a);
    expect(a.state).toBe("offline");
    expect(states).toEqual(["offline"]);
    expect(logs.at(-1)).toContain("audio server down: asr");
    expect(logs.at(-1)).toContain(down);
  });

  test("still down → no state event, no repeated log line", async () => {
    await poll(a);
    expect(a.state).toBe("offline");
    expect(states).toEqual(["offline"]);
    expect(logs).toHaveLength(1);
  });

  test("TTS down alone is offline too: the recovery and the new death are both logged", async () => {
    setServers(up, down, up);
    await poll(a);
    expect(a.state).toBe("offline"); // already offline → `setState` emits on a change only
    expect(states).toEqual(["offline"]);
    expect(logs).toHaveLength(3);
    expect(logs[1]).toContain("audio server back: asr");
    expect(logs.at(-1)).toContain("audio server down: tts");
  });

  test("everything back → listening, with the recovery line in the log", async () => {
    setServers(up, up, up);
    await poll(a);
    expect(a.state).toBe("listening");
    expect(states).toEqual(["offline", "listening"]);
    expect(logs.at(-1)).toContain("audio server back: tts");
  });

  test("Smart Turn down only degrades turn-taking: the state stays listening", async () => {
    setServers(up, up, down);
    await poll(a);
    expect(a.state).toBe("listening");
    expect(logs.at(-1)).toContain("audio server down: turn");
    setServers(up, up, up);
    await poll(a);
    expect(logs.at(-1)).toContain("audio server back: turn");
    expect(states).toEqual(["offline", "listening"]); // never moved
  });

  test("every other event in the pipeline calls refreshState(): offline sticks", async () => {
    setServers(down, up, up);
    await poll(a);
    expect(a.state).toBe("offline");
    a.refreshState();
    a.refreshState();
    expect(a.state).toBe("offline");
    expect(states).toEqual(["offline", "listening", "offline"]);
    setServers(up, up, up);
    await poll(a);
    expect(a.state).toBe("listening");
    expect(states).toEqual(["offline", "listening", "offline", "listening"]);
  });

  test("the LLM leg down is offline too — the orb used to stay green with a dead llama-server", async () => {
    cfg.llmBaseUrl = `${down}/v1`;
    await poll(a);
    expect(a.state).toBe("offline");
    expect(logs.at(-1)).toContain("LLM down:");
    expect(logs.at(-1)).toContain(llmHealthUrl(cfg.llmBaseUrl));
    cfg.llmBaseUrl = `${up}/v1`;
    await poll(a);
    expect(a.state).toBe("listening");
    expect(logs.at(-1)).toContain("LLM back:");
  });

  test("the mic source has its own signal: down → offline, back → listening", () => {
    a.setMicDown(true);
    expect(a.state).toBe("offline");
    expect(logs.at(-1)).toContain("mic source down");
    a.setMicDown(true); // no repeat: the state and the log only move on a change
    expect(logs.filter((l) => l.includes("mic source down"))).toHaveLength(1);
    a.setMicDown(false);
    expect(a.state).toBe("listening");
    expect(logs.at(-1)).toContain("mic source back");
  });
});
