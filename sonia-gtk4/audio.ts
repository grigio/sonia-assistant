/**
 * Audio in and out through PipeWire subprocesses — the same tools the harness' CLI mode
 * uses (`src/audio/mic.ts` / `src/audio/player.ts`), so the GTK client speaks the exact
 * formats the servers expect:
 *
 *   mic       pw-record --rate 16000 --channels 1 --format s16 --latency 32ms -
 *             → stdout carries 16 kHz mono s16; this re-chunks it into the 512-sample
 *               (32 ms) frames the capture worklet of the web UI sends, with the peak
 *               of each frame for the pulsing dot.
 *   playback  pw-cat --playback --raw --rate <TTS rate> --channels 1 --format s16 -
 *             ← stdin carries the already-paced PCM the server streams; `flush()` kills
 *               and respawns the process, which clears the device ring buffer (that is
 *               what makes a barge-in cut the assistant's voice within ~one buffer).
 *
 * With AEC on, both are pointed at the fd_ec_source / fd_ec_sink nodes created by
 * `scripts/echo-cancel.sh` (PipeWire's WebRTC echo canceller) — the native counterpart
 * of the browser's AEC, and the reason this client never needs one of its own.
 */

import { spawn, type ChildProcess } from "node:child_process";

export const MIC_RATE = 16000;
export const FRAME_SAMPLES = 512; // 32 ms — what QueueMic on the server re-chunks to
export const FRAME_BYTES = FRAME_SAMPLES * 2;

/** Peak (0..1) of a s16 PCM frame, and the frame itself. */
export type MicFrame = { pcm: Uint8Array; peak: number };

export class Mic {
  private proc: ChildProcess | null = null;
  private stopping = false;
  muted = false;
  onFrame: ((f: MicFrame) => void) | null = null;
  /** Stream ended without stop() — pw-record died (device gone, bad --target). */
  onEnd: ((err: string) => void) | null = null;

  constructor(public target = "") {}

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  start(): void {
    if (this.running) return;
    this.stopping = false;
    const cmd = ["pw-record", "--rate", String(MIC_RATE), "--channels", "1",
      "--format", "s16", "--latency", "32ms"];
    if (this.target) cmd.push("--target", this.target);
    cmd.push("-");
    const proc = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    let errTail = "";
    proc.stderr?.on("data", (d: Buffer) => {
      errTail = (errTail + d.toString("utf-8")).slice(-300);
    });
    let buf = new Uint8Array(0);
    proc.stdout!.on("data", (chunk: Buffer) => {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0);
      merged.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length), buf.length);
      buf = merged;
      while (buf.length >= FRAME_BYTES) {
        const pcm = buf.slice(0, FRAME_BYTES);
        buf = buf.slice(FRAME_BYTES);
        if (this.stopping) return;
        this.onFrame?.({ pcm, peak: peakOf(pcm) });
      }
    });
    proc.once("error", (e) => this.onEnd?.(e.message));
    proc.once("close", (code, signal) => {
      if (this.stopping) return; // stop(): the ending *is* the shutdown
      this.onEnd?.(errTail.trim() || `pw-record exited (${signal ?? code})`);
    });
  }

  stop(): void {
    this.stopping = true;
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) p.kill("SIGKILL");
  }

  /** Change the capture device (AEC toggle): a plain restart of the recorder. */
  retarget(target: string): void {
    this.target = target;
    this.stop();
    this.start();
  }
}

export class Speaker {
  private proc: ChildProcess | null = null;
  private pcmRate = 0;
  private pcmTarget = "";
  private closing = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  errTail = "";
  /** RMS (0..1) of the last chunk written — the header orb's level. */
  lastRms = 0;

  constructor(readonly latencyMs = 60) {}

  /** (Re)spawn the player when it is dead or its rate/target changed. */
  ensure(rate: number, target = ""): void {
    if (this.proc && this.proc.exitCode === null && this.pcmRate === rate && this.pcmTarget === target) {
      return;
    }
    this.close();
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.pcmRate = rate;
    this.pcmTarget = target;
    const cmd = ["pw-cat", "--playback", "--raw", "--rate", String(rate),
      "--channels", "1", "--format", "s16", "--latency", `${this.latencyMs}ms`];
    if (target) cmd.push("--target", target);
    cmd.push("-");
    const proc = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "ignore", "pipe"] });
    this.proc = proc;
    this.closing = false;
    this.errTail = "";
    proc.stderr?.on("data", (d: Buffer) => {
      this.errTail = (this.errTail + d.toString("utf-8")).slice(-300);
    });
    proc.stdin.on("error", () => { /* the reader went away */ });
    // A dead pw-cat used to stay dead for the rest of the session: every later
    // chunk went into a closed pipe and the assistant simply went mute part-way
    // through a sentence — the "interruptions". Come back on our own instead.
    const died = (code: number | null, signal: string | null): void => {
      if (this.closing || this.proc !== proc) return;
      this.proc = null;
      console.log(`[audio] pw-cat exited (${signal ?? code}) — restarting: ${this.errTail.trim()}`);
      this.retry = setTimeout(() => {
        this.retry = null;
        if (!this.closing) this.ensure(this.pcmRate, this.pcmTarget);
      }, 250);
    };
    proc.once("close", died);
    proc.once("error", (e) => {
      this.errTail = (this.errTail + e.message).slice(-300);
      died(null, e.message);
    });
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  write(pcm: Uint8Array): void {
    this.lastRms = rmsOf(pcm);
    if (!pcm.length) return;
    // a chunk arriving with no player (it died, or the rate just changed) means
    // silence from here on — bring it back instead of dropping the sentence
    if (!this.running) this.ensure(this.pcmRate, this.pcmTarget);
    try {
      this.proc?.stdin?.write(pcm);
    } catch {
      /* pipe closed mid-write; the close handler restarts us */
    }
  }

  /** Drop everything still buffered: the barge-in cut (web: the worklet's ring reset). */
  flush(): void {
    if (!this.running) return;
    this.ensure(this.pcmRate, this.pcmTarget); // respawn = a fresh, empty ring
  }

  close(): void {
    this.closing = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) {
      p.kill("SIGKILL");
    }
  }
}

/** Peak of a s16 mono frame, 0..1. */
export function peakOf(pcm: Uint8Array): number {
  const v = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
  let peak = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]!) / 32768;
    if (a > peak) peak = a;
  }
  return peak;
}

/** RMS of a s16 mono chunk, 0..1. */
export function rmsOf(pcm: Uint8Array): number {
  const v = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
  if (!v.length) return 0;
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]! / 32768;
    s += x * x;
  }
  return Math.min(1, Math.sqrt(s / v.length) * 4.5);
}
