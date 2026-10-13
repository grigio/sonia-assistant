/**
 * Microphone capture through PipeWire (pw-record) and out-of-band sources: the
 * browser's WebSocket (web mode) and a WAV file (offline tests).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { FRAME_BYTES, FRAME_SAMPLES, MIC_RATE, loadWav16kMono } from "./wav";
import { concatBytes, sleep } from "../util";

export { FRAME_BYTES, FRAME_SAMPLES, MIC_RATE };

export interface MicSource {
  frames(): AsyncGenerator<Uint8Array, void, unknown>;
  close(): Promise<void>;
}

export class PipeWireMic implements MicSource {
  private proc: ChildProcess | null = null;

  constructor(private readonly target = "") {}

  async *frames(): AsyncGenerator<Uint8Array, void, unknown> {
    const cmd = [
      "pw-record",
      "--rate", String(MIC_RATE),
      "--channels", "1",
      "--format", "s16",
      "--latency", "32ms",
    ];
    if (this.target) cmd.push("--target", this.target);
    cmd.push("-");
    const proc = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
    this.proc = proc;
    for await (const frame of exactFrames(proc.stdout!, FRAME_BYTES)) yield frame;
  }

  async close(): Promise<void> {
    const p = this.proc;
    if (p && p.exitCode === null) {
      p.kill("SIGKILL");
      await new Promise<void>((res) => p.once("close", () => res()));
    }
  }
}

/** Frames pushed from outside (the browser over WebSocket), re-chunked to 512 samples. */
export class QueueMic implements MicSource {
  private readonly q: Uint8Array[] = [];
  private buf = new Uint8Array(0);
  private waiter: (() => void) | null = null;
  /**
   * Backlog cap (32 ms frames). Was 200 = **6.4 s**: whenever the consumer stalled for a
   * moment (GC, an ONNX spike) the queue kept growing and never shrank again — the mic
   * heard the room half a minute late. 16 frames (512 ms) absorbs a real stall without
   * dropping a single frame of speech, and bounds the worst-case latency; beyond that the
   * *oldest* audio goes so the assistant keeps up with the room.
   */
  private static readonly MAX = 16;
  /** For the log line: frames discarded because the consumer could not keep up. */
  droppedFrames = 0;

  push(pcm: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + pcm.length);
    merged.set(this.buf, 0);
    merged.set(pcm, this.buf.length);
    this.buf = merged;
    while (this.buf.length >= FRAME_BYTES) {
      const frame = this.buf.slice(0, FRAME_BYTES);
      this.buf = this.buf.slice(FRAME_BYTES);
      if (this.q.length >= QueueMic.MAX) {
        this.q.shift(); // consumer stalled: drop the oldest
        this.droppedFrames++;
      }
      this.q.push(frame);
      this.waiter?.();
      this.waiter = null;
    }
  }

  async *frames(): AsyncGenerator<Uint8Array, void, unknown> {
    for (;;) {
      while (this.q.length) yield this.q.shift()!;
      await new Promise<void>((res) => (this.waiter = res));
    }
  }

  async close(): Promise<void> {
    this.waiter?.();
    this.waiter = null;
  }
}

/** Feeds WAV files as if they were spoken live (16 kHz mono s16), then silence. */
export class WavMic implements MicSource {
  private readonly audio: Uint8Array;
  readonly done = { fired: false };

  constructor(script: [number, string][], tailS = 20) {
    const parts: Uint8Array[] = [];
    for (const [delay, p] of script) {
      parts.push(new Uint8Array(Math.trunc(delay * MIC_RATE) * 2));
      parts.push(loadWav16kMono(p));
    }
    parts.push(new Uint8Array(Math.trunc(tailS * MIC_RATE) * 2));
    this.audio = concatBytes(parts);
  }

  async *frames(): AsyncGenerator<Uint8Array, void, unknown> {
    const t0 = performance.now();
    let n = 0;
    for (let off = 0; off + FRAME_BYTES <= this.audio.length; off += FRAME_BYTES) {
      n++;
      const due = t0 + (n * FRAME_SAMPLES * 1000) / MIC_RATE - performance.now();
      if (due > 0) await sleep(due);
      yield this.audio.subarray(off, off + FRAME_BYTES);
    }
    this.done.fired = true;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Yield fixed-size frames from a byte stream (short reads are buffered). */export async function* exactFrames(
  stream: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  let buf = new Uint8Array(0);
  for await (const chunk of stream) {
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf, 0);
    merged.set(chunk, buf.length);
    buf = merged;
    while (buf.length >= size) {
      yield buf.slice(0, size);
      buf = buf.slice(size);
    }
  }
}

