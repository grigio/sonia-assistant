import { describe, expect, test } from "bun:test";
import { Player } from "../../src/audio/player";
import { QueueMic, exactFrames } from "../../src/audio/mic";
import { FRAME_BYTES } from "../../src/audio/wav";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Player pacing", () => {
  test("plays 10 slices (200 ms) at roughly real-time speed", async () => {
    const sent: number[] = [];
    const p = new Player(24000, "", 0, "callback");
    p.writer = (pcm) => sent.push(pcm.length);
    await p.start();
    p.beginSegment("ciao");
    p.enqueue(new Uint8Array(24000 * 2 * 0.2)); // 200 ms of PCM16 @ 24 kHz
    p.endSegment();

    const t0 = performance.now();
    while (p.busy && performance.now() - t0 < 3000) await sleep(10);
    const elapsed = performance.now() - t0;
    await p.close();

    const total = sent.reduce((a, b) => a + b, 0);
    expect(total).toBe(24000 * 2 * 0.2); // everything was played
    expect(sent.every((n) => n === 960)).toBe(true); // 20 ms slices at 24 kHz
    expect(elapsed).toBeGreaterThan(120); // paced, not instant
    expect(elapsed).toBeLessThan(1000);
  });

  test("pause stops the flow, resume continues; flush drops everything", async () => {
    const p = new Player(16000, "", 0, "callback");
    let bytes = 0;
    p.writer = (pcm) => (bytes += pcm.length);
    await p.start();

    p.beginSegment("a");
    p.enqueue(new Uint8Array(16000 * 2 * 0.5)); // 500 ms
    p.endSegment();
    await sleep(80);
    p.pause();
    const atPause = bytes;
    await sleep(150);
    expect(bytes).toBe(atPause); // nothing flows while paused
    p.resume();
    await sleep(100);
    expect(bytes).toBeGreaterThan(atPause); // flowing again

    p.flush();
    expect(p.busy).toBe(false);
    await sleep(60);
    expect(bytes).toBeLessThan(16000 * 2 * 0.5); // the rest was dropped
    await p.close();
  });

  test("callbacks: first audio, segment start, idle", async () => {
    const p = new Player(16000, "", 0, "callback");
    const events: string[] = [];
    p.onFirstAudio = () => events.push("first");
    p.onSegmentStart = (tag) => events.push(`start:${tag}`);
    p.onIdle = () => events.push("idle");
    await p.start();

    p.beginSegment("primo");
    p.enqueue(new Uint8Array(16000 * 2 * 0.05));
    p.endSegment();
    await sleep(200);
    expect(events).toEqual(["first", "start:primo", "idle"]);
    await p.close();
  });

  test("an empty segment is dropped without firing segment start (or idle: never was busy)", async () => {
    const p = new Player(16000, "", 0, "callback");
    const events: string[] = [];
    p.onSegmentStart = (tag) => events.push(`start:${tag}`);
    p.onIdle = () => events.push("idle");
    await p.start();
    p.beginSegment("vuoto");
    p.endSegment(); // nothing enqueued
    await sleep(100);
    expect(events).toEqual([]); // no start:vuoto, no idle (was never busy)
    await p.close();
  });
});

describe("QueueMic", () => {
  test("re-chunks arbitrary pushes into 512-sample frames", async () => {
    const mic = new QueueMic();
    mic.push(new Uint8Array(FRAME_BYTES - 10));
    mic.push(new Uint8Array(10 + FRAME_BYTES + 5));
    mic.push(new Uint8Array(FRAME_BYTES - 5));
    const it = mic.frames();
    const a = (await it.next()).value!;
    const b = (await it.next()).value!;
    expect(a.length).toBe(FRAME_BYTES);
    expect(b.length).toBe(FRAME_BYTES);
    it.return?.(undefined);
  });

  test("frames arrive in order, the oldest are dropped past the cap", async () => {
    const mic = new QueueMic();
    for (let i = 0; i < 250; i++) {
      const buf = new Uint8Array(FRAME_BYTES).fill(i & 0xff);
      mic.push(buf);
    }
    const it = mic.frames();
    // after 250 pushes the queue (MAX = 16 frames = 512 ms) holds 234..249 — everything
    // older was dropped so the assistant keeps up with the room
    for (let i = 234; i < 250; i++) {
      const f = (await it.next()).value!;
      expect(f[0]).toBe(i & 0xff);
    }
    expect(mic.droppedFrames).toBe(234);
    it.return?.(undefined);
  });
});

describe("exactFrames", () => {
  test("assembles fixed frames from ragged chunks", async () => {
    async function* src(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5]);
      yield new Uint8Array([6, 7, 8, 9]);
    }
    const frames: Uint8Array[] = [];
    for await (const f of exactFrames(src(), 2)) frames.push(f);
    expect(frames.map((f) => [...f])).toEqual([[1, 2], [3, 4], [5, 6], [7, 8]]);
  });
});
