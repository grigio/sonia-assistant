/** Clients for the audio.cpp servers: live ASR, Smart Turn, streaming TTS. */

import net from "node:net";
import { pcm16ToWavBytes } from "../audio/wav";
import { abortError, timeoutSignal } from "../util";

type PartialCb = (text: string) => void;
/** Failure report: ASR errors used to be a bare `console.error` in library code. */
type ErrorCb = (msg: string) => void;

// ───────────────────────── live ASR (full-duplex HTTP/1.1) ─────────────────────────

/**
 * One utterance streamed to `POST /v1/audio/transcriptions/live`.
 *
 * The request body is chunked raw PCM written while the SSE response is read on the
 * *same* socket (fetch/undici can't do that reliably) — hence a hand-rolled HTTP/1.1
 * client over `net.Socket` (this class).
 */
export class LiveTranscription {
  text = "";
  readonly tOpen = performance.now();

  private sock: net.Socket | null = null;
  private connected = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** Framed chunks waiting for the socket to take them (see `writeChunk`). */
  private outq: Buffer[] = [];
  private outBytes = 0;
  private droppedBytes = 0;
  private closed = false;
  private finishRequested = false;
  private finalResolve: ((s: string) => void) | null = null;
  readonly final: Promise<string>;
  private buf: Buffer = Buffer.alloc(0);
  private phase: "status" | "headers" | "body" | "done" = "status";
  private chunked = false;
  private headers: Record<string, string> = {};
  private sseBuf = "";

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly language = "",
    private readonly onPartial: PartialCb | null = null,
    private readonly onError: ErrorCb | null = null,
  ) {
    this.final = new Promise<string>((res) => (this.finalResolve = res));
  }

  /** ~16 s / ~32 s of 16 kHz s16 audio: generous for a server that reads in real time. */
  private static readonly MAX_PENDING = 512_000; // before open()
  private static readonly MAX_QUEUED = 1_048_576; // socket buffer + this queue
  /** Write when the kernel buffer is below this; above it we queue instead of pushing. */
  private static readonly HIGH_WATER = 262_144;

  private get path(): string {
    const q = new URLSearchParams({
      model: this.model,
      sample_rate: "16000",
      channels: "1",
      sample_format: "s16le",
    });
    if (this.language) q.set("language", this.language);
    return `/v1/audio/transcriptions/live?${q}`;
  }

  async open(): Promise<void> {
    const u = new URL(this.baseUrl);
    const host = u.hostname || "127.0.0.1";
    const port = u.port ? Number(u.port) : 80;
    const path = u.pathname.replace(/\/$/, "") + this.path;
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(port, host, resolve);
      sock.once("error", reject);
      this.sock = sock;
    }).catch((e) => {
      // a refused/hung connection used to leave `final` pending forever: report it and
      // resolve with what we have, so finish() cannot block on a socket that never opened
      this.fail(`connect failed: ${e instanceof Error ? e.message : e}`);
      throw e;
    });
    const sock = this.sock!;
    sock.removeAllListeners("error");
    sock.on("error", () => this.fail("socket error"));
    sock.on("close", () => this.fail("connection closed"));
    sock.on("data", (d: Buffer) => this.onData(d));
    sock.on("drain", () => this.flushOut());

    const head =
      `POST ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
      "Content-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n" +
      "Accept: text/event-stream\r\nConnection: close\r\n\r\n";
    sock.write(head);
    this.connected = true;
    if (this.pending.length) {
      for (const p of this.pending) this.writeChunk(p);
      this.pending = [];
      this.pendingBytes = 0;
    }
    if (this.finishRequested) this.writeEnd();
  }

  send(pcm: Uint8Array): void {
    if (this.closed || pcm.length === 0) return;
    if (!this.sock || !this.connected) {
      const b = Buffer.from(pcm);
      this.pending.push(b);
      this.pendingBytes += b.length;
      // bounded: the backlog before open() can only be a few frames, never minutes
      while (this.pendingBytes > LiveTranscription.MAX_PENDING && this.pending.length > 1) {
        const drop = this.pending.shift()!;
        this.pendingBytes -= drop.length;
        this.noteDropped(drop.length);
      }
      return;
    }
    this.writeChunk(Buffer.from(pcm));
  }

  /**
   * One HTTP chunk, framed as a single write. Never written straight to the socket: the
   * return value of `sock.write()` is ignored by most code, so a slow server would make
   * this queue grow without bound. Instead the frames wait here (bounded — the *oldest*
   * audio is dropped first, which keeps the chunk framing valid) and `flushOut()` pushes
   * them while the kernel buffer is below the high-water mark, on write and on `drain`.
   */
  private writeChunk(pcm: Buffer): void {
    const framed = Buffer.concat([
      Buffer.from(`${pcm.length.toString(16)}\r\n`),
      pcm,
      Buffer.from("\r\n"),
    ]);
    this.outq.push(framed);
    this.outBytes += framed.length;
    while (this.outBytes > LiveTranscription.MAX_QUEUED && this.outq.length > 1) {
      const drop = this.outq.shift()!;
      this.outBytes -= drop.length;
      this.noteDropped(drop.length);
    }
    this.flushOut();
  }

  private flushOut(): void {
    const sock = this.sock;
    if (!sock || sock.destroyed) return;
    while (this.outq.length && sock.writableLength < LiveTranscription.HIGH_WATER) {
      const b = this.outq.shift()!;
      this.outBytes -= b.length;
      sock.write(b);
    }
  }

  private noteDropped(n: number): void {
    const first = this.droppedBytes === 0;
    this.droppedBytes += n;
    if (first) this.warn(`[asr] overload: dropping oldest audio (server not reading)`);
  }

  private warn(msg: string): void {
    if (this.onError) this.onError(msg);
    else console.error(`\n${msg}`);
  }

  private writeEnd(): void {
    if (this.closed || !this.sock) return;
    this.closed = true;
    this.sock.write("0\r\n\r\n");
  }

  /**
   * Close the body and wait for transcript.text.done. Voxtral keeps its last tokens
   * until it has seen ~0.5 s of audio past them, so `padMs` of silence is appended
   * (processed faster than realtime) before closing.
   */
  async finish(padMs = 480, timeoutMs = 10_000, signal?: AbortSignal): Promise<string> {
    if (padMs > 0) this.send(new Uint8Array(16 * padMs * 2)); // 16 samples/ms * 2 bytes
    this.finishRequested = true;
    if (this.sock && this.connected) this.writeEnd();
    if (signal?.aborted) {
      this.abort();
      throw abortError();
    }
    // three ways out: the transcript's `done`, the flush timeout, or a cancelled turn
    // (`close()` / 🧹 must not wait out the 10 s flush — it used to, see `void signal`)
    let onAbort: (() => void) | undefined;
    const raced = signal
      ? Promise.race([
          this.final,
          new Promise<never>((_, rej) => {
            onAbort = () => rej(abortError());
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ])
      : this.final;
    try {
      return await withTimeout(raced, timeoutMs, () => this.text);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.abort();
    }
  }

  abort(): void {
    this.closed = true;
    if (!this.finalSettled()) this.resolveFinal(this.text);
    this.phase = "done";
    try {
      this.sock?.destroy();
    } catch {
      /* ignore */
    }
  }

  private finalSettled(): boolean {
    return this.phase === "done";
  }

  private resolveFinal(text: string): void {
    if (this.finalResolve) {
      this.phase = "done";
      this.finalResolve(text);
      this.finalResolve = null;
    }
  }

  private fail(what: string): void {
    if (this.phase !== "done") {
      this.closed = true; // nobody is reading this socket: stop feeding it
      this.warn(`[asr] ${what}`);
    }
    this.resolveFinal(this.text);
  }

  // ── response parsing (status → headers → body) ──

  private onData(d: Buffer): void {
    if (this.phase === "done") return;
    this.buf = Buffer.concat([this.buf, d]);
    this.pump();
  }

  private pump(): void {
    while (this.phase !== "done") {
      if (this.phase === "status" || this.phase === "headers") {
        const idx = this.buf.indexOf("\r\n");
        if (idx < 0) return;
        const line = this.buf.subarray(0, idx).toString("latin1");
        this.buf = this.buf.subarray(idx + 2);
        if (this.phase === "status") {
          if (!/\s200\b/.test(line)) {
            this.fail(`ASR HTTP error: ${line} ${this.buf.subarray(0, 300).toString("latin1")}`);
            return;
          }
          this.phase = "headers";
        } else if (line === "") {
          this.chunked = (this.headers["transfer-encoding"] ?? "").includes("chunked");
          this.phase = "body";
        } else {
          const c = line.indexOf(":");
          if (c > 0)
            this.headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
        }
        continue;
      }

      // body
      if (this.chunked) {
        const idx = this.buf.indexOf("\r\n");
        if (idx < 0) return;
        const size = parseInt(
          this.buf.subarray(0, idx).toString("latin1").split(";")[0]!.trim() || "0",
          16,
        );
        if (Number.isNaN(size)) {
          this.fail("ASR: bad chunk size");
          return;
        }
        if (size === 0) {
          this.resolveFinal(this.text);
          return;
        }
        if (this.buf.length < idx + 2 + size + 2) return; // wait for the whole chunk
        const data = this.buf.subarray(idx + 2, idx + 2 + size);
        this.buf = this.buf.subarray(idx + 2 + size + 2);
        this.feedBody(data);
      } else {
        if (this.buf.length === 0) return;
        const data = this.buf;
        this.buf = Buffer.alloc(0);
        this.feedBody(data);
      }
    }
  }

  private feedBody(data: Buffer): void {
    this.sseBuf += data.toString("utf-8");
    let idx: number;
    while ((idx = this.sseBuf.indexOf("\n")) >= 0) {
      const line = this.sseBuf.slice(0, idx).replace(/\r$/, "");
      this.sseBuf = this.sseBuf.slice(idx + 1);
      this.handleSse(line);
    }
  }

  private handleSse(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      this.resolveFinal(this.text);
      return;
    }
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    const t = (ev["type"] as string) ?? "";
    if (t === "transcript.text.delta") {
      this.text += (ev["delta"] as string) ?? "";
      this.onPartial?.(this.text);
    } else if (t === "transcript.text.done") {
      this.text = (ev["text"] as string) || this.text;
      this.resolveFinal(this.text);
    } else if (t === "error") {
      this.warn(`[asr] server error: ${data}`);
    }
  }
}

// ───────────────────────────── Smart Turn v3.2 ─────────────────────────────

export class SmartTurn {
  private readonly url: string;
  constructor(
    baseUrl: string,
    private readonly model: string,
  ) {
    this.url = baseUrl.replace(/\/$/, "") + "/v1/tasks/run";
  }

  /** The model looks at the last 8 s. */
  async probability(pcm16k: Uint8Array, signal?: AbortSignal): Promise<number> {
    const trimmed =
      pcm16k.length > 8 * 16000 * 2 ? pcm16k.subarray(pcm16k.length - 8 * 16000 * 2) : pcm16k;
    const body = {
      model: this.model,
      request: { audio_base64: Buffer.from(pcm16ToWavBytes(trimmed, 16000)).toString("base64") },
    };
    let r: Response;
    try {
      r = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // a hung :8093 used to leak this task and silently degrade turn-end to the
        // 900 ms silence path: the timeout bounds it, the signal cancels it
        signal: timeoutSignal(5_000, signal),
      });
    } catch (e) {
      if (signal?.aborted) throw e; // a real cancellation stays silent upstream
      throw new Error("smart-turn: no answer within 5 s (server down or stalled)");
    }
    const js = (await r.json()) as {
      custom_schema_output?: { data?: { probability?: number } };
    };
    return Number(js.custom_schema_output?.data?.probability ?? 0);
  }
}

// ───────────────────────────── streaming TTS ─────────────────────────────

export class TTS {
  rate = 24000;
  private readonly base: string;
  /** Preset name of the pack (`embeddings/<voice>.safetensors`): switchable at runtime. */
  private voice: string;
  constructor(
    baseUrl: string,
    private readonly model: string,
    voice: string,
  ) {
    this.base = baseUrl.replace(/\/$/, "");
    this.voice = voice;
  }

  get voiceName(): string {
    return this.voice;
  }

  /** Another preset: every request below sends the voice it holds *now*. */
  setVoice(voice: string): void {
    this.voice = voice;
  }

  /** Load the new preset before it is really spoken, so the first sentence stays quick.
   *  Never throws: a cold voice only makes that one utterance slower. */
  async warmVoice(): Promise<void> {
    try {
      const r = await fetch(this.base + "/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: "Pronto.", voice: this.voice }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await r.arrayBuffer();
    } catch {
      /* nothing to report: the next synthesis simply warms it then */
    }
  }

  /** Warm the model and read the sample rate from a tiny offline WAV. */
  async detectRate(): Promise<number> {
    let r: Response;
    try {
      r = await fetch(this.base + "/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: "Pronto.", voice: this.voice }),
        // warmup compiles the graph: generous, but a stalled :8092 must not hang start()
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new Error(
        `TTS ${this.base}: warmup did not answer in 60 s (${e instanceof Error ? e.message : e})`,
      );
    }
    if (!r.ok) throw new Error(`TTS warmup HTTP ${r.status} on ${this.base}`);
    const wav = Buffer.from(await r.arrayBuffer());
    if (wav.subarray(0, 4).toString("latin1") === "RIFF") this.rate = wav.readUInt32LE(24);
    return this.rate;
  }

  /** SSE stream of `speech.audio.delta` events → PCM16 chunks. */
  async *stream(text: string, signal?: AbortSignal): AsyncGenerator<Uint8Array, void, unknown> {
    let r: Response;
    try {
      r = await fetch(this.base + "/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: text,
          voice: this.voice,
          response_format: "pcm",
          stream_format: "sse",
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      // a refused/reset connection says which server it was (`String(e)` alone loses the
      // URL), and a cancellation must keep its AbortError shape for the callers above
      if (signal?.aborted) throw e;
      throw new Error(`TTS ${this.base}: ${e instanceof Error ? e.message : e}`);
    }
    if (!r.ok) throw new Error(`TTS HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    if (!r.body) throw new Error("TTS: empty body");
    for await (const raw of r.body as unknown as AsyncIterable<Uint8Array>) {
      const lines = Buffer.from(raw).toString("utf-8").split("\n");
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev["type"] === "speech.audio.delta") {
          yield Buffer.from(ev["audio"] as string, "base64");
        } else if (ev["type"] === "error") {
          throw new Error(`TTS stream error: ${data}`);
        }
      }
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((res) => {
        timer = setTimeout(() => res(fallback()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
