/**
 * Paced playback queue with pause / resume / flush.
 *
 * Playback is paced here in 20 ms slices so the device buffer stays tiny: that is
 * what makes pause / resume / flush (barge-in) take effect within ~one buffer period.
 * Timing runs on `performance.now()` (monotonic).
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { sleep } from "../util";

type Segment = {
  pcm: Uint8Array;
  tag: string; // the sentence text this audio speaks
  started: boolean;
  done: boolean; // no more audio will be appended
};

type Writer = (pcm: Uint8Array) => void;

export type PlayerSink = "pipewire" | "null" | "callback";

export class Player {
  static readonly SLICE_MS = 20;

  writer: Writer | null = null; // used when sink == "callback"
  onFlush: (() => void) | null = null;
  onSegmentStart: ((tag: string) => void) | null = null;
  onFirstAudio: (() => void) | null = null;
  onIdle: (() => void) | null = null;

  readonly queue: Segment[] = [];
  paused = false;

  private proc: ChildProcess | null = null;
  private wake = new Wake();
  private task: Promise<void> | null = null;
  private wasBusy = false;
  private closed = false;

  private recFd: number | null = null;
  private recT0 = 0;
  private recWritten = 0;

  constructor(
    readonly rate: number,
    readonly target = "",
    readonly latencyMs = 60,
    readonly sink: PlayerSink = "pipewire",
    readonly recordPath: string | null = null,
  ) {}

  async start(): Promise<void> {
    if (this.sink === "pipewire") {
      const cmd = [
        "pw-cat",
        "--playback",
        "--raw",
        "--rate",
        String(this.rate),
        "--channels",
        "1",
        "--format",
        "s16",
        "--latency",
        `${this.latencyMs}ms`,
      ];
      if (this.target) cmd.push("--target", this.target);
      cmd.push("-");
      // stdin must be a *pipe*: it is what carries the PCM (see the write below), and
      // `stdio[0] = "ignore"` would make `proc.stdin` null and crash start().
      this.proc = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
      this.proc.stdin!.on("error", () => {
        /* reader went away */
      });
    }
    if (this.recordPath) {
      // 44-byte placeholder header; patched when the recording is closed
      this.recFd = fs.openSync(this.recordPath, "w");
      fs.writeSync(this.recFd, Buffer.alloc(44));
      this.recT0 = performance.now();
    }
    this.task = this.run();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wake.set();
    if (this.task) await this.task.catch(() => {});
    const p = this.proc;
    if (p && p.exitCode === null) {
      p.kill("SIGKILL");
      await new Promise<void>((res) => p.once("close", () => res()));
    }
    if (this.recFd !== null) {
      this.recordSilenceUntilNow();
      this.writeWavHeader();
      fs.closeSync(this.recFd);
      this.recFd = null;
    }
  }

  // ── queue control ──

  beginSegment(tag: string): void {
    this.queue.push({ pcm: new Uint8Array(0), tag, started: false, done: false });
    this.wake.set();
  }

  enqueue(pcm: Uint8Array): void {
    const last = this.queue[this.queue.length - 1];
    if (!last || last.done)
      this.queue.push({ pcm: new Uint8Array(0), tag: "", started: false, done: false });
    const seg = this.queue[this.queue.length - 1]!;
    const merged = new Uint8Array(seg.pcm.length + pcm.length);
    merged.set(seg.pcm, 0);
    merged.set(pcm, seg.pcm.length);
    seg.pcm = merged;
    this.wake.set();
  }

  endSegment(): void {
    const last = this.queue[this.queue.length - 1];
    if (last) last.done = true;
    this.wake.set();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.wake.set();
  }

  flush(): void {
    this.queue.length = 0;
    this.paused = false;
    this.wake.set();
    this.onFlush?.(); // drop audio already buffered on the client
  }

  get busy(): boolean {
    return this.queue.length > 0;
  }

  get audible(): boolean {
    return this.queue.length > 0 && !this.paused;
  }

  // ── recording ──

  private recordSilenceUntilNow(): void {
    if (this.recFd === null) return;
    const due = Math.trunc(((performance.now() - this.recT0) / 1000) * this.rate);
    if (due > this.recWritten) {
      fs.writeSync(this.recFd, Buffer.alloc((due - this.recWritten) * 2));
      this.recWritten = due;
    }
  }

  private writeWavHeader(): void {
    if (this.recFd === null) return;
    const dataBytes = this.recWritten * 2;
    const h = Buffer.alloc(44);
    h.write("RIFF", 0, "latin1");
    h.writeUInt32LE(36 + dataBytes, 4);
    h.write("WAVE", 8, "latin1");
    h.write("fmt ", 12, "latin1");
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(this.rate, 24);
    h.writeUInt32LE(this.rate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36, "latin1");
    h.writeUInt32LE(dataBytes, 40);
    fs.writeSync(this.recFd, h, 0, 44, 0);
  }

  // ── pacing loop ──

  private async run(): Promise<void> {
    const sliceBytes = ((this.rate * Player.SLICE_MS) / 1000) * 2;
    const lead = this.latencyMs / 1000; // keep at most ~one device buffer queued
    let clock = performance.now() / 1000;

    while (!this.closed) {
      if (!this.queue.length || this.paused) {
        if (this.wasBusy && !this.queue.length) {
          this.wasBusy = false;
          this.onIdle?.();
        }
        this.wake.clear();
        await this.wake.wait();
        clock = performance.now() / 1000;
        continue;
      }

      const seg = this.queue[0]!;
      if (!seg.pcm.length && seg.done) {
        this.queue.shift();
        continue;
      }
      if (!seg.pcm.length && !seg.started) {
        // nothing to play yet for this sentence: wait without announcing it
        this.wake.clear();
        await this.wake.wait(50);
        clock = Math.max(clock, performance.now() / 1000);
        continue;
      }
      if (!seg.started) {
        seg.started = true;
        if (!this.wasBusy) {
          this.wasBusy = true;
          this.onFirstAudio?.();
        }
        this.onSegmentStart?.(seg.tag);
      }
      if (!seg.pcm.length) {
        // sentence still being synthesized: wait for more audio (underrun)
        this.wake.clear();
        await this.wake.wait(50);
        clock = Math.max(clock, performance.now() / 1000);
        continue;
      }

      const chunk = seg.pcm.subarray(0, sliceBytes);
      seg.pcm = seg.pcm.subarray(sliceBytes);
      const owned = chunk.slice(); // detach from the (mutable) segment buffer
      this.proc?.stdin?.write(owned);
      this.writer?.(owned);
      if (this.recFd !== null) {
        this.recordSilenceUntilNow();
        fs.writeSync(this.recFd, owned);
        this.recWritten += owned.length / 2;
      }

      clock += owned.length / 2 / this.rate;
      const ahead = clock - performance.now() / 1000;
      if (ahead > lead) {
        await sleep((ahead - lead) * 1000);
      } else if (ahead < -0.2) {
        clock = performance.now() / 1000; // we fell behind (underrun); resync
      }
    }
  }
}

/** A oneshot wake token: `set()` releases the current (and future) `wait()`ers. */
class Wake {
  private p: Promise<void> | null = null;
  private release: (() => void) | null = null;

  wait(timeoutMs?: number): Promise<void> {
    if (!this.p) {
      this.p = new Promise<void>((res) => (this.release = res));
    }
    const p = this.p;
    if (timeoutMs === undefined) return p;
    return Promise.race([p, sleep(timeoutMs)]);
  }

  set(): void {
    this.release?.();
    this.release = null;
    this.p = null;
  }

  clear(): void {
    /* no-op: a `set()` between clear and wait must still be seen (edge-triggered) */
  }
}
