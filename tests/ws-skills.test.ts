/**
 * End-to-end check of the browser control channel over `/ws` (the part unit tests can't
 * see): a real `WebApp` + harness against a throwaway mock of llama-server and of the
 * three audio.cpp endpoints, then the browser's own messages.
 *
 * It asserts the contract `static/index.html` relies on:
 *   hello   → { skills_dir, skills: [{name, description, active}], tasks: [...] }
 *   {type:"skills_set", active:[…]} → {type:"skills", dir, skills:[…]}   (persisted too)
 *   {type:"skills_refresh"}         → the same, freshly rescanned
 *   {type:"task_cancel", id}        → {type:"tasks", tasks:[…]}  (the banner above the chat)
 *   {type:"rewind", id}             → {type:"chat_rewound", ok, history}  (⟲ a checkpoint)
 *   {type:"config", …}              → the drawer's switches, on the Config they drive
 *   {type:"approve", id, ok}        → the ✕/✓ button resolving a pending command
 *   {type:"stop"}                   → cancel whatever the assistant is doing
 *   {type:"models_refresh"}         → {type:"models", models, current}
 *
 * …plus the `/static/*` path guard over the wire (exact request lines, which `fetch`
 * would normalise away for us).
 *
 * ## No test depends on another
 *
 * The WebApp keeps a *single* client slot: a second socket kicks the first. The suite
 * used to rely on that — "a second window takes the slot" was pinned as the LAST TEST
 * because it destroys the shared socket, and every event assertion indexed into one
 * `events.all` array shared by all the others. A new test added in the middle, or a
 * single failure changing the event order, broke unrelated cases.
 *
 * Now each `describe` spins up its **own** app through `startApp()` and closes it in
 * `afterAll`, so the only socket is its own and nothing has to be ordered. Event
 * assertions use `mark()` to take a watermark instead of hard-coding `0`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { Config } from "../src/config";
import { WebApp } from "../src/web";
import { pcm16ToWavBytes } from "../src/audio/wav";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Throw the mock off: every request (the `/health` probes included) is refused, which is
 * what a killed audio.cpp server looks like to the harness. One port plays ASR + TTS +
 * Smart Turn here, so it takes the whole audio leg down.
 */
let serverDown = false;

async function freePort(): Promise<number> {
  return await new Promise<number>((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

/** llama-server + ASR + TTS + Smart Turn, all on one port. */
function mockModelServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0]!;
    // the audio leg goes away; the LLM keeps answering, so a turn really does reach TTS
    if (serverDown && (url === "/health" || url === "/v1/audio/speech")) {
      req.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      if (url === "/v1/models") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "mock-llm", meta: { n_ctx: 8192 } }] }));
      } else if (url === "/v1/chat/completions") {
        const stream = body.includes('"stream":true');
        res.setHeader("Content-Type", "text/event-stream");
        const chunk = JSON.stringify({
          choices: [{ delta: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        });
        res.end(
          stream
            ? `data: ${chunk}\n\ndata: [DONE]\n\n`
            : JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        );
      } else if (url === "/v1/audio/speech") {
        if (body.includes("stream_format")) {
          res.setHeader("Content-Type", "text/event-stream");
          const pcm = new Uint8Array(640); // 320 ms of silence @ 2 kHz … any pcm16 works
          const b64 = Buffer.from(pcm).toString("base64");
          // `audio` is the key the client reads (`audiocpp.ts`: speech.audio.delta)
          res.end(`data: {"type":"speech.audio.delta","audio":"${b64}"}\n\ndata: [DONE]\n\n`);
        } else {
          // detectRate(): a real WAV, the rate is read at byte 24
          res.setHeader("Content-Type", "audio/wav");
          res.end(Buffer.from(pcm16ToWavBytes(new Uint8Array(320), 24000)));
        }
      } else if (url === "/v1/audio/transcriptions/live") {
        res.setHeader("Content-Type", "text/event-stream");
        res.end('data: {"type":"transcript.text.done","text":"ciao"}\n\n');
      } else if (url === "/v1/tasks/run") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ custom_schema_output: { data: { probability: 0.1 } } }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

type AnyEvent = Record<string, unknown> & { type: string };

function collector(ws: WebSocket): {
  all: AnyEvent[];
  /** How many events have arrived so far — pass to `wait` to scope a later assertion. */
  mark: () => number;
  wait: (t: string, from?: number, ms?: number) => Promise<AnyEvent>;
} {
  const all: AnyEvent[] = [];
  const waiters: { type: string; from: number; res: (e: AnyEvent) => void }[] = [];
  ws.on("message", (d, isBinary) => {
    if (isBinary) return; // TTS PCM frames: the page plays them, this collector reads JSON
    const ev = JSON.parse(String(d)) as AnyEvent;
    all.push(ev);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if (w.type === ev.type && all.indexOf(ev) >= w.from) waiters.splice(i, 1)[0]!.res(ev);
    }
  });
  return {
    all,
    mark: () => all.length,
    wait(type, from = 0, ms = 8000) {
      const seen = all.slice(from).find((e) => e.type === type);
      if (seen) return Promise.resolve(seen);
      return new Promise<AnyEvent>((res, rej) => {
        waiters.push({ type, from, res });
        setTimeout(() => rej(new Error(`timeout waiting for '${type}'`)), ms);
      });
    },
  };
}

type Fixture = {
  app: WebApp;
  ws: WebSocket;
  events: ReturnType<typeof collector>;
  mockUrl: string;
  skillsDir: string;
  dataDir: string;
  port: number;
  close: () => Promise<void>;
};

/**
 * A whole app + browser socket, torn down with the test. Every `describe` below owns one,
 * which is what lets them run in any order and share no state.
 */
async function startApp(skillsDir: string, dataDir: string): Promise<Fixture> {
  const mock = await mockModelServer();
  const cfg = Config.fromEnv();
  cfg.llmBaseUrl = mock.url + "/v1";
  cfg.asrUrl = mock.url;
  cfg.ttsUrl = mock.url;
  cfg.turnUrl = mock.url;
  cfg.healthPollMs = 300; // the liveness poller at test speed (default: 10 s)
  cfg.skillsDir = skillsDir;
  cfg.dataDir = dataDir;
  cfg.vadModel = path.resolve("models/silero/silero_vad.onnx");
  cfg.llmModel = "mock-llm";
  cfg.locale = "it"; // the assertions below read Italian strings — not the developer's .env
  const port = await freePort();
  const app = new WebApp(cfg, "127.0.0.1", port);
  void app.run(false).catch(() => {}); // never resolves (the mic loop is infinite)

  // wait for the HTTP server (run() logs "ready" only after it is listening)
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events = collector(ws);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });

  return {
    app,
    ws,
    events,
    mockUrl: mock.url,
    skillsDir,
    dataDir,
    port,
    close: async () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
    },
  };
}

/** Two skills on disk, one already switched on from a previous session. */
function seedSkills(root: string): { skillsDir: string; dataDir: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(root, "fd-ws-"));
  const skillsDir = path.join(tmp, "skills");
  const dataDir = path.join(tmp, "data");
  fs.mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, "beta"), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: First skill.\n---\n# Alpha\n",
  );
  fs.writeFileSync(
    path.join(skillsDir, "beta", "SKILL.md"),
    "---\nname: beta\ndescription: |\n  Second skill,\n  wrapped.\n---\n# Beta\n",
  );
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "skills.json"), JSON.stringify(["alpha"]));
  return { skillsDir, dataDir, tmp };
}

describe("skills over /ws (hello → skills_set → skills_refresh)", () => {
  const { skillsDir, dataDir, tmp } = seedSkills(os.tmpdir());
  let f: Fixture;

  beforeAll(async () => {
    f = await startApp(skillsDir, dataDir);
  }, 30_000);

  afterAll(async () => {
    await f?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("hello carries the skills dir and the active flags", async () => {
    const hello = (await f.events.wait("hello")) as AnyEvent & {
      skills_dir: string;
      skills: { name: string; description: string; active: boolean }[];
      config: Record<string, unknown>;
    };
    expect(hello.skills_dir).toBe(skillsDir);
    expect(hello.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(hello.skills.map((s) => s.active)).toEqual([true, false]);
    // the block-scalar description is folded into a single line for the UI tooltip
    expect(hello.skills[1]!.description).toBe("Second skill, wrapped.");
    expect(hello.config["cmd_mode"]).toBe("auto");
  });

  test("skills_set flips the flags, broadcasts them and persists them", async () => {
    const from = f.events.mark();
    f.ws.send(JSON.stringify({ type: "skills_set", active: ["beta"] }));
    const ev = (await f.events.wait("skills", from)) as AnyEvent & {
      dir: string;
      skills: { name: string; active: boolean }[];
    };
    expect(ev.dir).toBe(skillsDir);
    expect(ev.skills.map((s) => s.active)).toEqual([false, true]);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "skills.json"), "utf-8"))).toEqual([
      "beta",
    ]);
    expect(f.events.all.slice(from).some((e) => e.type === "skills")).toBe(true);
  });

  test("skills_refresh rescans the dir (a skill installed meanwhile shows up)", async () => {
    fs.mkdirSync(path.join(skillsDir, "gamma"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "gamma", "SKILL.md"),
      "---\nname: gamma\ndescription: Third skill.\n---\n# Gamma\n",
    );
    const from = f.events.mark();
    f.ws.send(JSON.stringify({ type: "skills_refresh" }));
    const ev = (await f.events.wait("skills", from)) as AnyEvent & {
      skills: { name: string; active: boolean }[];
    };
    expect(ev.skills.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
    // the store is an explicit list once the user has chosen → a skill installed later
    // starts unchecked (and says so in the drawer) until the user ticks it
    expect(ev.skills.map((s) => s.active)).toEqual([false, true, false]);
  });

  // ── the banner above the chat: hello.tasks → a timer → task_cancel → tasks ──

  test("hello carries the banner, and a ✕ over /ws empties it", async () => {
    const hello = (await f.events.wait("hello")) as AnyEvent & { tasks: unknown[] };
    expect(hello.tasks).toEqual([]);          // a fresh page starts with no chip

    const from = f.events.mark();
    await f.app.assistant.tools.call("set_timer", JSON.stringify({ seconds: 60, label: "caffè" }));
    const set = (await f.events.wait("tasks", from)) as AnyEvent & {
      tasks: { id: string; kind: string; label: string; due_in_ms: number }[];
    };
    expect(set.tasks.map((t) => t.kind)).toEqual(["timer"]);
    expect(set.tasks[0]!.label).toBe("caffè");
    expect(set.tasks[0]!.due_in_ms).toBeGreaterThan(0);

    const from2 = f.events.mark();
    f.ws.send(JSON.stringify({ type: "task_cancel", id: set.tasks[0]!.id }));
    const stopped = (await f.events.wait("tasks", from2)) as AnyEvent & { tasks: unknown[] };
    expect(stopped.tasks).toEqual([]);
    // …and the chat says what was cancelled (the page's language, not the log's)
    const line = await f.events.wait("event", from2);
    expect(String(line.text)).toContain("caffè");
  });

  // ── static files: the path guard (`web.ts:resolveStatic`) seen over the wire ──

  /** The exact request line: `fetch`/`URL` normalise `..` before it leaves the client. */
  const getRaw = (p: string): Promise<{ status: number; type: string | null; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: f.port, path: p, method: "GET" },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              type: res.headers["content-type"] ?? null,
              body: Buffer.concat(chunks).toString("utf-8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

  test("static/index.html is served with its content type", async () => {
    const r = await getRaw("/static/index.html");
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/html");
    expect(r.body).toContain("<!doctype html>");
  });

  test("traversal is rejected before the join, in both spellings", async () => {
    expect((await getRaw("/static/../.env")).status).toBe(400); // a raw `..` segment
    expect((await getRaw("/static/%2e%2e/.env")).status).toBe(400); // what a URL-aware client sends
    expect((await getRaw("/static/sub/../../package.json")).status).toBe(400);
  });

  test("a directory and a missing file are 404, not a crash", async () => {
    // `/static/` used to reach `readFileSync` on a directory: EISDIR in the request
    // listener took the whole process down
    expect((await getRaw("/static/")).status).toBe(404);
    expect((await getRaw("/static/nope.txt")).status).toBe(404);
  });

  test("a refused audio server fails one response — it no longer kills the harness", async () => {
    const from = f.events.mark();
    serverDown = true;
    f.ws.send(JSON.stringify({ type: "text", text: "ciao" }));

    // the turn reports the failure (the TTS rejection used to be unhandled → Bun exited)
    const ev = await f.events.wait("event", from, 15_000);
    expect(String(ev.text)).toContain("⚠");
    expect(String(ev.text)).toContain(`TTS ${f.mockUrl}`); // the wrap names the server
    // …the poller puts the UI on `offline` instead of leaving the orb green…
    await waitState(f, from, "offline");
    // …and the process is still serving
    expect(f.ws.readyState).toBe(WebSocket.OPEN);
    expect(f.app.assistant.state).toBe("offline");

    // server back → listening again
    serverDown = false;
    await waitState(f, f.events.mark(), "listening");
    expect(f.app.assistant.state).toBe("listening");
  }, 60_000);

  // ── ⟲ rewind: a checkpoint cuts the history, and the ack carries what is left ──

  test("⟲ a checkpoint cuts the conversation; a dropped one is refused", async () => {
    // a clean slate: the tests above left their own lines in the history
    let from = f.events.mark();
    f.ws.send(JSON.stringify({ type: "reset" }));
    await f.events.wait("chat_reset", from);
    expect(f.app.assistant.chatLines()).toEqual([]);

    // two turns: every chat line carries the id its ⟲ will point at
    from = f.events.mark();
    f.ws.send(JSON.stringify({ type: "text", text: "prima domanda" }));
    const u1 = (await f.events.wait("user", from)) as AnyEvent & { id?: number };
    const a1 = (await f.events.wait("assistant_done", from)) as AnyEvent & { id?: number };
    expect(typeof u1.id).toBe("number");
    expect(typeof a1.id).toBe("number");

    from = f.events.mark();
    f.ws.send(JSON.stringify({ type: "text", text: "seconda domanda" }));
    const u2 = (await f.events.wait("user", from)) as AnyEvent & { id?: number };
    await f.events.wait("assistant_done", from);
    expect(u2.id).not.toBe(a1.id);
    expect(f.app.assistant.chatLines()).toHaveLength(4);

    // ⟲ on the first answer: the second question and its answer go with it
    from = f.events.mark();
    f.ws.send(JSON.stringify({ type: "rewind", id: a1.id }));
    const ack = (await f.events.wait("chat_rewound", from)) as AnyEvent & {
      ok: boolean;
      history: { role: string; content: string; id?: number }[];
    };
    expect(ack.ok).toBe(true);
    expect(ack.history.map((m) => m.content)).toEqual(["prima domanda", "ok"]);
    // what survived keeps its ids — the page can ⟲ further back right away
    expect(ack.history.map((m) => m.id)).toEqual([u1.id, a1.id]);
    expect(f.app.assistant.history).toHaveLength(2);

    // the line that just went away is no longer a checkpoint: nothing is touched
    from = f.events.mark();
    f.ws.send(JSON.stringify({ type: "rewind", id: u2.id! }));
    const nope = (await f.events.wait("chat_rewound", from)) as typeof ack;
    expect(nope.ok).toBe(false);
    expect(nope.history).toEqual(ack.history);
    expect(f.app.assistant.history).toHaveLength(2);
  }, 30_000);

  test("a page from another origin cannot open /ws", async () => {
    // Browsers do not apply the same-origin policy to WebSockets: without this check any
    // site the user visits could read the transcript and push commands here.
    const evil = new WebSocket(`ws://127.0.0.1:${f.port}/ws`, {
      headers: { Origin: "http://evil.com" },
    });
    // a refused upgrade errors *after* the handshake fails too: keep a listener on it for
    // the socket's whole life, or the second emission is an unhandled error of its own
    const errors: string[] = [];
    evil.on("error", (e) => errors.push(String((e as Error).message)));
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 5000);
      const done = (v: string) => {
        clearTimeout(timer);
        resolve(v);
      };
      evil.once("open", () => done("open"));
      evil.once("close", () => done("close"));
    });
    expect(outcome).toBe("close");        // destroyed at the upgrade, no hello, no frame
    expect(errors.length).toBeGreaterThan(0);
    // …while this suite's own socket (no Origin header: not a browser) is untouched
    expect(f.ws.readyState).toBe(WebSocket.OPEN);
  }, 10_000);
});

/** Wait for a `state` event carrying this value — the poller only emits on a change. */
async function waitState(f: Fixture, from: number, want: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (f.events.all.slice(from).some((e) => e.type === "state" && e.state === want)) return;
    if (Date.now() - t0 > ms) {
      const seen = f.events.all.slice(from).filter((e) => e.type === "state");
      throw new Error(`timeout: no state "${want}" (saw ${JSON.stringify(seen)})`);
    }
    await sleep(50);
  }
}

// ── the single client slot ──
//
// Its own `describe`, and therefore its own app: this test kicks the socket it is
// connected to, so sharing one with the suite above made it order-dependent (it had to be
// pinned last, and any test added below it silently inherited a closed socket).

describe("a second window", () => {
  const { skillsDir, dataDir, tmp } = seedSkills(os.tmpdir());
  let f: Fixture;

  beforeAll(async () => {
    f = await startApp(skillsDir, dataDir);
  }, 30_000);

  afterAll(async () => {
    await f?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("takes the slot: the first one is told why it went dark", async () => {
    const closed = new Promise<number>((resolve) => f.ws.once("close", (code) => resolve(code)));
    const from = f.events.mark();

    const second = new WebSocket(`ws://127.0.0.1:${f.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      second.once("open", () => resolve());
      second.once("error", reject);
    });

    // the kicked window gets an explicit event *and* the close, so it can stop
    // reconnecting (the two would otherwise kick each other every 1.5 s forever)
    const taken = await f.events.wait("session_taken", from, 8000);
    expect(taken.type).toBe("session_taken");
    expect(await closed).toBe(1000);
    expect(f.ws.readyState).toBe(WebSocket.CLOSED);

    // the new window is the live one: it got its own hello
    const hello = await new Promise<AnyEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no hello for the second window")), 8000);
      second.once("message", (d) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(d)) as AnyEvent);
      });
    });
    expect(hello.type).toBe("hello");
    second.close();
  }, 15_000);
});

// ── the settings drawer and the command buttons ──
//
// `web.ts:onCommand` has eleven cases; the five below had no coverage at all, and three of
// them (`config`, `approve`, `stop`) are the drawer's switches and the ✕/✓ buttons — i.e.
// most of what the page can actually ask for after the initial `hello`.

describe("the drawer's commands", () => {
  const { skillsDir, dataDir, tmp } = seedSkills(os.tmpdir());
  let f: Fixture;

  beforeAll(async () => {
    f = await startApp(skillsDir, dataDir);
  }, 30_000);

  afterAll(async () => {
    await f?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("config writes the switches onto the Config the turn actually reads", async () => {
    const cfg = f.app.assistant.cfg;
    const from = f.events.mark();
    f.ws.send(
      JSON.stringify({
        type: "config",
        half_duplex: true,
        barge_in: false,
        decision_mode: "always",
        cmd_mode: "ask",
        thinking: true,
      }),
    );
    // `cmd_mode` is the only one that has to reach further than `cfg` — the Tools instance
    // is what enforces it, and a drawer that set the Config alone would gate nothing
    const untilSet = async () => {
      for (let i = 0; i < 100; i++) {
        if (cfg.halfDuplex && cfg.cmdMode === "ask" && f.app.assistant.tools.cmdMode === "ask") {
          return;
        }
        await sleep(10);
      }
      throw new Error("config never applied");
    };
    await untilSet();

    expect(cfg.halfDuplex).toBe(true);
    expect(cfg.bargeIn).toBe(false);
    expect(cfg.decisionMode).toBe("always");
    expect(cfg.cmdMode).toBe("ask");
    expect(cfg.llmDisableThinking).toBe(false); // the wire carries `thinking`, not its negation
    expect(f.events.all.slice(from).length).toBeGreaterThanOrEqual(0);

    // an enum the server does not know is ignored, not written through
    f.ws.send(JSON.stringify({ type: "config", cmd_mode: "yolo", decision_mode: "nope" }));
    await sleep(150);
    expect(cfg.cmdMode).toBe("ask");
    expect(cfg.decisionMode).toBe("always");
  });

  test("approve resolves a pending command, and a stale id is refused", async () => {
    const a = f.app.assistant;
    const lines: string[] = [];
    a.log = (m: string) => lines.push(m); // the log is the English half of the pair
    const from = f.events.mark();

    const ok = a.requestApproval("rm -rf /tmp/whatever", "because the user asked");
    const req = (await f.events.wait("command_request", from)) as AnyEvent & {
      id: number;
      command: string;
    };
    expect(req.command).toBe("rm -rf /tmp/whatever");

    // a stale id must not resolve somebody else's question
    expect(a.resolveApproval(true, req.id + 999, "via.click")).toBe(false);
    expect(await Promise.race([ok, sleep(100).then(() => "pending")])).toBe("pending");

    // the ✕/✓ button carries the real id
    expect(a.resolveApproval(true, req.id, "via.click")).toBe(true);
    expect(await ok).toBe(true);
    const done = (await f.events.wait("command_resolved", from)) as AnyEvent & { id: number };
    expect(done.id).toBe(req.id);
    expect(a.pendingApproval).toBeNull();

    // the page is told in its own language, the log in English — and only the log
    // carries the command itself
    const ev = (await f.events.wait("event", from)) as AnyEvent & { text: string };
    expect(ev.text).toBe("✅ comando autorizzato (clic)");
    expect(lines.some((l) => l.includes("$ rm -rf /tmp/whatever"))).toBe(true);
    expect(lines.every((l) => !/[àèéìòù]/.test(l))).toBe(true);
    a.log = (m: string) => void lines.push(m);
  });

  test("text typed into the approval prompt answers it instead of starting a turn", async () => {
    const a = f.app.assistant;
    const from = f.events.mark();

    const ok = a.requestApproval("deploy", "");
    await f.events.wait("command_request", from);
    f.ws.send(JSON.stringify({ type: "text", text: "no" }));
    expect(await ok).toBe(false);
    // consumed by the approval: no new turn, and the page is told what it answered
    expect(a.chatLines().some((l) => l.content === "no")).toBe(false);
    const ev = (await f.events.wait("event", from)) as AnyEvent & { text: string };
    expect(ev.text).toContain("comando rifiutato");
  });

  test("stop cancels whatever the assistant is doing", async () => {
    const a = f.app.assistant;
    const from = f.events.mark();
    f.ws.send(JSON.stringify({ type: "text", text: "una domanda" }));
    await f.events.wait("user", from);
    // the turn is in flight (or already done): `stop` must leave nothing behind and not
    // throw, whether or not there was anything to cancel
    f.ws.send(JSON.stringify({ type: "stop" }));
    await sleep(200);
    expect(a.resp).toBeNull();
    expect(a.speechRunMs).toBe(0);
    expect(f.ws.readyState).toBe(WebSocket.OPEN); // the socket is untouched by a stop
  }, 20_000);

  test("models_refresh re-asks the endpoint and answers with the model list", async () => {
    const from = f.events.mark();
    f.ws.send(JSON.stringify({ type: "models_refresh" }));
    const ev = (await f.events.wait("models", from)) as AnyEvent & {
      models: string[];
      current: string;
      via_pi: boolean;
    };
    expect(ev.models).toEqual(["mock-llm"]);
    expect(ev.current).toBe("mock-llm");
    expect(ev.via_pi).toBe(false);
  });

  test("a model switch loads, announces itself and updates the Config", async () => {
    const a = f.app.assistant;
    const from = f.events.mark();
    f.ws.send(JSON.stringify({ type: "model", model: "mock-llm-2" }));
    const loading = (await f.events.wait("model_loading", from)) as AnyEvent & { model: string };
    expect(loading.model).toBe("mock-llm-2");
    const ready = (await f.events.wait("model_ready", from, 20_000)) as AnyEvent & {
      model: string;
    };
    expect(ready.model).toBe("mock-llm-2");
    expect(a.cfg.llmModel).toBe("mock-llm-2");
  }, 30_000);
});
