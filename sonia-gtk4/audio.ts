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

import { type ChildProcess, spawn } from "node:child_process";

export const MIC_RATE = 16000;
/** High-pass corner (Hz) for the capture chain; `SONIA_MIC_HPF=0` turns it off. */
export function hpfHz(): number {
  const v = Number(process.env.SONIA_MIC_HPF ?? 350);
  return Number.isFinite(v) ? v : 350;
}
/** Gate sensitivity: how far above the learned floor a frame must sit (SONIA_MIC_GATE). */
export function gateRatio(): number {
  const v = Number(process.env.SONIA_MIC_GATE ?? 2.5);
  return Number.isFinite(v) && v > 0 ? v : 2.5;
}
export const FRAME_SAMPLES = 512; // 32 ms — what QueueMic on the server re-chunks to
export const FRAME_BYTES = FRAME_SAMPLES * 2;

/** Peak (0..1) of a s16 PCM frame, and the frame itself. */
export type MicFrame = { pcm: Uint8Array<ArrayBuffer>; peak: number };

/**
 * Adaptive noise gate.
 *
 * A quiet room is not digital silence: the laptop's internal mic picks up a
 * steady low rumble (measured here: rms ≈ 0.016, energy concentrated at
 * 100–300 Hz, with occasional bursts to peak 0.08). The harness' Silero VAD
 * reads that as speech with probability ~1.0 — six seconds of a silent room
 * produced 123/186 frames over the 0.5 start threshold, so the assistant kept
 * "hearing" you. A high-pass filter only takes the edge off it (mean probability
 * 0.38 at 400 Hz), so the level has to be gated as well.
 *
 * The gate learns the floor from the quietest frames it sees and only lets
 * through what stands clearly above it. A gated frame is sent as zeros, never
 * dropped: the harness still gets a continuous 32 ms stream (barge-in, AEC and
 * the timing of the silence gap all assume no gaps), it just sees actual silence
 * instead of room noise.
 *
 * Speech must survive the gate, so the floor only ever follows frames the gate
 * already considers noise — speech can never raise the floor and mute itself.
 */
export class NoiseGate {
  private floor: number;
  /** Frames at/under the floor seen so far, for `gateStats()`. */
  private gated = 0;
  private seen = 0;

  constructor(
    /** rms above `floor * ratio` is let through. */
    readonly ratio = 2.5,
    /** Never gate below this rms, however quiet the room is. */
    readonly absFloor = 0.006,
    /** Initial guess before any frame has been seen. */
    floor = 0.008,
  ) {
    this.floor = floor;
  }

  /** Current learned noise floor (rms, 0..1). */
  get level(): number {
    return this.floor;
  }

  /**
   * `keep` is true when the frame is loud enough to pass. `rms` of a rejected
   * frame pulls the floor down (fast), anything else lifts it back slowly —
   * the asymmetry is what keeps speech from being absorbed into the floor.
   */
  keep(rms: number): boolean {
    this.seen++;
    const pass = rms >= Math.max(this.absFloor, this.floor * this.ratio);
    if (pass) {
      this.floor += (rms - this.floor) * 0.0005;
    } else {
      this.gated++;
      this.floor = Math.min(this.floor, rms + (this.floor - rms) * 0.08);
    }
    return pass;
  }

  gateStats(): { gated: number; seen: number; floor: number } {
    return { gated: this.gated, seen: this.seen, floor: this.floor };
  }

  reset(): void {
    this.floor = 0.008;
    this.gated = 0;
    this.seen = 0;
  }
}

/**
 * Fourth-order high-pass (two cascaded Butterworth biquads).
 *
 * The rumble a quiet room produces sits under ~300 Hz — the phone band edge —
 * while speech carries almost all of its intelligibility above it. Filtering
 * there is what makes the level gate below able to tell the two apart: measured
 * on a silent room, the per-frame rms went from 0.056 to well under half that
 * with the low band gone, while a loud 140 Hz voice fundamental is attenuated
 * but still audible to the ASR (the formants and fricatives above 700 Hz carry
 * the words). `fc <= 0` disables it.
 */
export class HighPass {
  private b: number[] = [];
  private a: number[] = [];
  private x1 = new Float32Array(2);
  private x2 = new Float32Array(2);
  private o1 = new Float32Array(2);
  private o2 = new Float32Array(2);

  constructor(
    readonly fc = 350,
    readonly rate = MIC_RATE,
    stages = 2,
  ) {
    if (fc <= 0) return;
    const w = (2 * Math.PI * fc) / rate;
    const c = Math.cos(w);
    const sin = Math.sin(w);
    const k = sin / (2 * Math.SQRT1_2); // Butterworth Q
    const a0 = 1 + k;
    this.b = [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0];
    this.a = [(-2 * c) / a0, (1 - k) / a0];
    this.stages = stages;
  }

  private stages = 2;

  get enabled(): boolean {
    return this.fc > 0;
  }

  /** Filter an s16 frame in place and return it (no allocation in steady state). */
  apply(pcm: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    if (!this.enabled) return pcm;
    const v = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
    for (let s = 0; s < this.stages; s++) {
      const [b0, b1, b2] = this.b;
      const [a1, a2] = this.a;
      let x1 = this.x1[s]!,
        x2 = this.x2[s]!,
        o1 = this.o1[s]!,
        o2 = this.o2[s]!;
      for (let i = 0; i < v.length; i++) {
        const x = v[i]! / 32768;
        const y = b0! * x + b1! * x1 + b2! * x2 - a1! * o1 - a2! * o2;
        x2 = x1;
        x1 = x;
        o2 = o1;
        o1 = y;
        v[i] = Math.max(-32768, Math.min(32767, Math.round(y * 32768)));
      }
      this.x1[s] = x1;
      this.x2[s] = x2;
      this.o1[s] = o1;
      this.o2[s] = o2;
    }
    return pcm;
  }

  /** Where the filter is now — a device switch resets it (a new stream, new floor). */
  reset(): void {
    this.x1.fill(0);
    this.x2.fill(0);
    this.o1.fill(0);
    this.o2.fill(0);
  }
}

/** An all-zero frame of `FRAME_BYTES`, reused instead of allocating per frame. */
export const SILENT_FRAME = (() => {
  const z = new Uint8Array(FRAME_BYTES);
  return z;
})();

export class Mic {
  private proc: ChildProcess | null = null;
  private stopping = false;
  muted = false;
  /** Level gate in front of the harness' VAD — see NoiseGate. */
  readonly gate = new NoiseGate(gateRatio());
  /** Removes the low rumble the gate then works on — see HighPass. */
  readonly hp = new HighPass(hpfHz());
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
    this.hp.reset();
    const cmd = [
      "pw-record",
      "--rate",
      String(MIC_RATE),
      "--channels",
      "1",
      "--format",
      "s16",
      "--latency",
      "32ms",
    ];
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

  /**
   * High-pass, then gate, then hand the frame on: what leaves the mic is
   * band-limited, and a frame the gate rejected leaves as zeros rather than as a
   * hole in the stream (the harness assumes a continuous 32 ms cadence). The peak
   * the UI draws is zeroed with it, so the dot stops pulsing at room noise.
   */
  gated(f: MicFrame): MicFrame {
    const pcm = this.hp.apply(f.pcm);
    if (this.gate.keep(rmsOf(pcm))) return pcm === f.pcm ? f : { pcm, peak: peakOf(pcm) };
    return { pcm: SILENT_FRAME, peak: 0 };
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
    if (
      this.proc &&
      this.proc.exitCode === null &&
      this.pcmRate === rate &&
      this.pcmTarget === target
    ) {
      return;
    }
    this.close();
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.pcmRate = rate;
    this.pcmTarget = target;
    const cmd = [
      "pw-cat",
      "--playback",
      "--raw",
      "--rate",
      String(rate),
      "--channels",
      "1",
      "--format",
      "s16",
      "--latency",
      `${this.latencyMs}ms`,
    ];
    if (target) cmd.push("--target", target);
    cmd.push("-");
    const proc = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "ignore", "pipe"] });
    this.proc = proc;
    this.closing = false;
    this.errTail = "";
    proc.stderr?.on("data", (d: Buffer) => {
      this.errTail = (this.errTail + d.toString("utf-8")).slice(-300);
    });
    proc.stdin.on("error", () => {
      /* the reader went away */
    });
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
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
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
