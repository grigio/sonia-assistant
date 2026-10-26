import { describe, expect, test } from "bun:test";
import { exactFrames, QueueMic } from "../../src/audio/mic";
import { Player } from "../../src/audio/player";
import { FRAME_BYTES } from "../../src/audio/wav";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll until `cond` holds. Every wait in this file goes through here rather than a fixed
 * `sleep`: the Player is paced by a real 20 ms timer against the real clock, so a loaded
 * box stretches every slice, and a fixed sleep either waits far longer than needed or
 * (worse) gives up before the thing it was waiting for. `until` fails only when the
 * condition genuinely never holds within `ms`.
 */
async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
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
    await until(() => !p.busy, "the queue to drain");
    const elapsed = performance.now() - t0;
    await p.close();

    const total = sent.reduce((a, b) => a + b, 0);
    expect(total).toBe(24000 * 2 * 0.2); // everything was played
    expect(sent.every((n) => n === 960)).toBe(true); // 20 ms slices at 24 kHz
    // The *lower* bound is the one that matters: it must not be instant (that would mean
    // the pacing loop dumped the buffer). The upper bound is deliberately loose — it only
    // exists to catch a stall, and `until`'s own 4 s budget already does that.
    expect(elapsed).toBeGreaterThan(120);
    expect(elapsed).toBeLessThan(4000);
  });

  test("pause stops the flow, resume continues; flush drops everything", async () => {
    const p = new Player(16000, "", 0, "callback");
    let bytes = 0;
    p.writer = (pcm) => (bytes += pcm.length);
    await p.start();

    p.beginSegment("a");
    p.enqueue(new Uint8Array(16000 * 2 * 0.5)); // 500 ms
    p.endSegment();
    // let a few slices flow so `atPause` is a real non-zero number, whatever the
    // machine's speed — then the paused window can actually prove something
    await until(() => bytes > 0, "the first slices to flow");
    p.pause();
    const atPause = bytes;
    await sleep(150);
    expect(bytes).toBe(atPause); // nothing flows while paused
    p.resume();
    await until(() => bytes > atPause, "playback to resume");
    const afterResume = bytes;

    p.flush();
    expect(p.busy).toBe(false);
    await sleep(60);
    expect(bytes).toBeLessThan(16000 * 2 * 0.5); // the rest was dropped
    expect(bytes).toBeGreaterThanOrEqual(afterResume - 960); // …and only one slice can land after the flush
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
    await until(() => events.length >= 3, "the three callbacks");
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

  test("a burst of tiny TTS deltas is queued as chunks, not re-concatenated", async () => {
    const p = new Player(16000, "", 0, "callback");
    p.paused = true; // park the queue: we are testing storage, not pacing
    await p.start();
    p.beginSegment("molto lunga");
    for (let i = 0; i < 2000; i++) p.enqueue(Uint8Array.from([i & 0xff]));
    p.endSegment();
    const seg = p.queue[0] as unknown as { chunks: Uint8Array[]; length: number };
    expect(seg.chunks).toHaveLength(2000); // the old merge copied the whole tail every delta
    expect(seg.length).toBe(2000);
    p.flush();
    await p.close();
  });

  test("ragged chunks come out byte-for-byte in order", async () => {
    const p = new Player(16000, "", 0, "callback");
    const sent: number[] = [];
    p.writer = (pcm) => sent.push(...pcm);
    await p.start();
    p.beginSegment("x");
    for (const part of [[1, 2, 3], [4], [5, 6, 7, 8, 9], [10, 11]]) {
      p.enqueue(Uint8Array.from(part));
    }
    p.endSegment();
    await until(() => !p.busy, "the queue to drain");
    await p.close();
    expect(sent).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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

  test("close ends the frame iterator and ignores later pushes", async () => {
    const mic = new QueueMic();
    const it = mic.frames();
    const waiting = it.next(); // parked on the queue, as runAudio's loop is
    await mic.close();
    expect((await waiting).done).toBe(true);

    mic.push(new Uint8Array(FRAME_BYTES)); // late WebSocket message: must not resurrect it
    expect((await it.next()).done).toBe(true);
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
    expect(frames.map((f) => [...f])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ]);
  });
});
