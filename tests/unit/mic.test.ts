/**
 * The two halves of the mic's failure story:
 *
 *  1. `PipeWireMic` — a `pw-record` that dies must be *thrown*, never silently ended
 *     (a normal end means "the offline WAV script ran out" and shuts the loop down);
 *  2. `Harness.runAudio` — a dead source costs a log line, an `offline` orb and a
 *     backoff, not the process.
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MicSource } from "../../src/audio/mic";
import { PipeWireMic } from "../../src/audio/mic";
import { FRAME_BYTES } from "../../src/audio/wav";
import { Config } from "../../src/config";
import type { StateName } from "../../src/events";
import { Harness } from "../../src/harness/harness";
import { sleep } from "../../src/util";

const REAL_PATH = process.env.PATH ?? "";

/** A directory with our own `pw-record` in it, put in front of PATH for one test. */
function fakePwRecord(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonia-fake-pw-"));
  const file = path.join(dir, "pw-record");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return dir;
}

/** Run `fn` with PATH set to `value`, whatever happens. */
const withPath = async (value: string, fn: () => Promise<void>): Promise<void> => {
  process.env.PATH = value;
  try {
    await fn();
  } finally {
    process.env.PATH = REAL_PATH;
  }
};

/** Drain `frames()` until it ends or throws. */
async function drain(
  mic: PipeWireMic,
  max = 50,
): Promise<{ frames: number; error: string | null }> {
  let frames = 0;
  try {
    for await (const _frame of mic.frames()) {
      frames += 1;
      if (frames >= max) break;
    }
    return { frames, error: null };
  } catch (e) {
    return { frames, error: e instanceof Error ? e.message : String(e) };
  }
}

const dirs: string[] = [];
afterAll(() => {
  process.env.PATH = REAL_PATH;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("PipeWireMic: a dead pw-record is a failure, not the end of the stream", () => {
  test("pw-record exiting mid-stream throws, and the message says why", async () => {
    const dir = fakePwRecord('echo "no device found" >&2\nexit 3');
    dirs.push(dir);
    await withPath(`${dir}:${REAL_PATH}`, async () => {
      const r = await drain(new PipeWireMic());
      expect(r.error).toContain("pw-record exited (code 3)");
      expect(r.error).toContain("no device found"); // its own complaint travels with it
      expect(r.frames).toBe(0);
    });
  });

  test("pw-record not installed at all throws instead of hanging on a dead socket", async () => {
    await withPath("/nonexistent-bin-dir", async () => {
      const r = await drain(new PipeWireMic());
      expect(r.error).not.toBeNull();
      expect(r.error!).toContain("pw-record");
    });
  });

  test("close() ends the stream normally — the shutdown must not look like a crash", async () => {
    const dir = fakePwRecord("while true; do head -c 2048 /dev/zero; sleep 0.01; done");
    dirs.push(dir);
    await withPath(`${dir}:${REAL_PATH}`, async () => {
      const mic = new PipeWireMic();
      let frames = 0;
      let error: string | null = null;
      try {
        for await (const _frame of mic.frames()) {
          frames += 1;
          if (frames === 3) void mic.close();
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      expect(error).toBeNull();
      expect(frames).toBeGreaterThanOrEqual(3);
    });
  }, 15_000);

  test("frames() called again after close() never respawns pw-record", async () => {
    const dir = fakePwRecord("while true; do head -c 2048 /dev/zero; sleep 0.01; done");
    dirs.push(dir);
    await withPath(`${dir}:${REAL_PATH}`, async () => {
      const mic = new PipeWireMic();
      void mic.close();
      const r = await drain(mic, 1);
      expect(r.frames).toBe(0); // ends at once: shutdown wins over the restart
      expect(r.error).toBeNull();
    });
  }, 15_000);
});

// ── the loop that consumes it ───────────────────────────────────────────────

/** `frames()` per call: throw (a crash) or yield one frame and end (a clean source). */
class ScriptedMic implements MicSource {
  calls = 0;
  constructor(private readonly plan: Array<"throw" | "frame">) {}
  async *frames(): AsyncGenerator<Uint8Array, void, unknown> {
    const act = this.plan[this.calls] ?? "frame";
    this.calls += 1;
    if (act === "throw") throw new Error("boom");
    yield new Uint8Array(FRAME_BYTES);
  }
  async close(): Promise<void> {}
}

const build = (mic: MicSource): { h: Harness; logs: string[]; states: StateName[] } => {
  const h = new Harness(new Config(), mic, "null");
  const logs: string[] = [];
  const states: StateName[] = [];
  h.log = (m) => logs.push(m);
  h.emit = (ev) => {
    if (ev.type === "state") states.push(ev.state);
  };
  return { h, logs, states };
};

describe("Harness.runAudio: a dead mic source is restarted, not fatal", () => {
  test("first source crashes → logged, orb offline, second source works and the orb is back", async () => {
    const mic = new ScriptedMic(["throw", "frame"]);
    const { h, logs, states } = build(mic);
    await h.runAudio(); // resolves when the second source ends on purpose
    await h.close();

    expect(mic.calls).toBe(2);
    expect(
      logs.some((l) => l.includes("mic source failed: boom — restarting in 500 ms (attempt 1)")),
    ).toBe(true);
    expect(logs.some((l) => l.includes("mic source down"))).toBe(true);
    expect(logs.some((l) => l.includes("mic source back"))).toBe(true);
    expect(states).toEqual(["offline", "listening"]);
  }, 15_000);

  test("a source that ends on purpose is a normal shutdown: no restart, no warning", async () => {
    const mic = new ScriptedMic(["frame"]);
    const { h, logs, states } = build(mic);
    await h.runAudio();
    await h.close();

    expect(mic.calls).toBe(1);
    expect(logs.filter((l) => l.includes("mic source failed"))).toEqual([]);
    expect(states).toEqual([]); // never left `listening`
  }, 15_000);

  test("close() stops the backoff loop: one failure, no respawn after shutdown", async () => {
    const mic = new ScriptedMic(["throw", "throw", "throw", "throw"]);
    const { h, logs } = build(mic);
    const running = h.runAudio();
    await sleep(100); // the first failure is logged, the loop is in its 500 ms backoff
    expect(logs.some((l) => l.includes("mic source failed"))).toBe(true);
    await h.close();
    await running;
    expect(mic.calls).toBe(1);
  }, 15_000);
});
