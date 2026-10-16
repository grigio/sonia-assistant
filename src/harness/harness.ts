/**
 * Full-duplex event loop — route R2 of the design note:
 *
 *   Silero VAD ─┐
 *   Smart Turn ─┼─► "user done?" ─► (prompt decision if ambiguous) ─► LLM ─► TTS ─► speaker
 *   silence gap ┘
 *   + barge-in: the assistant pauses as soon as the user talks over it, resumes on
 *   backchannels/echo, and is cancelled on a real interruption.
 *
 * Cancellation is cooperative: an `AbortController` per background task (`spawn`) and
 * per response (`Response.controller`).
 */

import readline from "node:readline";
import { LiveTranscription } from "../clients/audiocpp";
import { t as msg } from "../i18n"; // `t` is a timestamp in the frame loop below
import { concatBytes, sleep } from "../util";
import { Assistant, type Utterance } from "./assistant";
import { bargeInterrupts, bargeVerdict } from "./barge-in";
import { isAbortError, now } from "./queues";
import { hasWords } from "./text";
import { checkTurnEnd } from "./turn";

const FRAME_MS = 32; // 512 samples @ 16 kHz

export class Harness extends Assistant {
  // ── main loops ──

  async runAudio(): Promise<void> {
    this.spawnAnnouncer();
    // A dead mic source (pw-record gone, the device unplugged, an ONNX throw) must cost
    // one line and a backoff, not the process: the loop restarts the source and only a
    // source that ends *on purpose* (the offline WAV script ran out) shuts it down.
    let attempt = 0;
    let healthy = 0;
    for (;;) {
      try {
        for await (const frame of this.mic!.frames()) {
          if (attempt > 0 && healthy === 0) this.setMicDown(false);
          healthy += 1;
          if (attempt > 0 && healthy > 32) attempt = 0; // ~1 s of audio: it really is back
          try {
            await this.processFrame(frame, now());
          } catch (e) {
            this.log(`[frame] ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return;
      } catch (e) {
        if (this.stopped) return;
        healthy = 0;
        attempt += 1;
        const delay = Math.min(500 * 2 ** (attempt - 1), 10_000);
        const why = e instanceof Error ? e.message : String(e);
        this.log(`⚠ mic source failed: ${why} — restarting in ${delay} ms (attempt ${attempt})`);
        this.setMicDown(true);
        await sleep(delay);
        if (this.stopped) return;
      }
    }
  }

  /** Type instead of speaking (debug): each line is a finished user turn. */
  async runText(): Promise<void> {
    this.spawnAnnouncer();
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      const text = line.trim();
      if (!text) continue;
      while (this.resp !== null) await sleep(100);
      this.startResponse(text, now());
    }
    while (this.resp !== null) await sleep(200); // let the last answer finish
  }

  // ── per-frame logic (32 ms) ──

  async processFrame(frame: Uint8Array, t: number): Promise<void> {
    const cfg = this.cfg;
    const talking = this.player.audible;
    if (cfg.halfDuplex && (talking || this.resp !== null)) {
      this.preroll = [];
      this.speechRunMs = 0;
      this.vad?.reset();
      return;
    }
    const p = await this.vad!.process(frame);
    this.preroll.push(frame);
    if (this.preroll.length > this.prerollMax) this.preroll.shift();
    const u = this.utt;

    if (u === null) {
      const startThr = talking ? cfg.bargeVadThreshold : cfg.vadStartThreshold;
      const need = talking ? cfg.bargeMinMs : cfg.vadMinSpeechMs;
      this.speechRunMs = p >= startThr ? this.speechRunMs + FRAME_MS : 0;
      if (this.speechRunMs >= need && (cfg.bargeIn || !talking)) this.startUtterance(t);
      return;
    }

    u.asr.send(frame);
    u.audio.push(frame);
    if (p >= cfg.vadEndThreshold) {
      if (t - u.lastSpeech > cfg.turnCheckMs / 1000 && u.decision === "listen") {
        this.log("  ↺ user resumed");
      }
      u.lastSpeech = t;
      u.speechMs += FRAME_MS;
      u.pauseChecked = false;
      u.turnProb = null;
      u.decision = null;
      u.listenUntil = 0;
    } else {
      const silenceMs = (t - u.lastSpeech) * 1000;
      if (silenceMs >= cfg.turnCheckMs && !u.pauseChecked) {
        u.pauseChecked = true;
        this.spawn((sig) => this.smartTurn(u, u.lastSpeech, sig));
      }
      this.applyTurnEnd(u, t);
    }

    if (u.barge && this.resp !== null && this.utt === u && this.pendingApproval === null) {
      this.checkBargeConfirm(u);
    }
  }

  startUtterance(t: number): void {
    this.gen += 1;
    const gen = this.gen;
    const asr = new LiveTranscription(
      this.cfg.asrUrl,
      this.cfg.asrModel,
      this.cfg.asrLanguage,
      (text) => this.onPartial(gen, text),
    );
    const u: Utterance = {
      gen,
      asr,
      tStart: t,
      lastSpeech: t,
      audio: [],
      speechMs: 0,
      pauseChecked: false,
      turnProb: null,
      decision: null,
      decisionText: "",
      listenUntil: 0,
      barge: false,
      partial: "",
    };

    if (this.pendingApproval !== null) {
      this.player.pause(); // user is answering the confirmation question
    } else if (this.resp !== null) {
      if (!this.resp.audioStarted) {
        // the assistant hasn't spoken yet: the user is just continuing their turn
        this.pendingPrefix = `${this.pendingPrefix} ${this.resp.userText}`.trim();
        this.cancelResponse(false, true);
        this.log("  ↺ user continued — merging with previous turn");
      } else if (this.cfg.bargeIn) {
        this.player.pause();
        u.barge = true;
        this.log("  ⏸ user is talking over the assistant (paused)");
        this.emit({ type: "event", text: msg(this.cfg.locale, "evt.bargePause") });
      }
    }
    for (const f of this.preroll) {
      asr.send(f);
      u.audio.push(f);
    }
    this.preroll = [];
    this.utt = u;
    this.spawn(() => asr.open());
    this.refreshState();
  }

  private onPartial(gen: number, text: string): void {
    if (this.utt && this.utt.gen === gen) {
      this.utt.partial = text;
      this.status(`🎤 ${text.trim()}`);
      this.emit({ type: "partial", text: `${this.pendingPrefix} ${text}`.trim() });
    }
  }

  // ── turn-end signals ──

  private async smartTurn(u: Utterance, atSpeech: number, signal: AbortSignal): Promise<void> {
    let prob: number;
    try {
      prob = await this.turn.probability(concatBytes(u.audio), signal);
    } catch (e) {
      if (isAbortError(e)) return;
      this.log(`[smart-turn] ${e}`);
      prob = 0.0;
    }
    if (this.utt === u && u.lastSpeech === atSpeech) {
      u.turnProb = prob;
      if (this.cfg.debug) this.log(`  smart-turn p=${prob.toFixed(2)}`);
    }
  }

  private async decide(u: Utterance, atSpeech: number, signal: AbortSignal): Promise<void> {
    // The last two *lines* of the conversation: the tail can now end in tool results
    // (a SKILL.md, a command's output) — chatter the 4-token judge has no use for.
    const lines: string[] = [];
    for (let i = this.history.length - 1; i >= 0 && lines.length < 2; i--) {
      const m = this.history[i]!;
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = String(m.content ?? "").trim();
      if (text) lines.unshift(`${m.role}: ${text}`);
    }
    const tail = lines.length ? `${lines.join("\n")}\n` : "";
    const text = `${this.pendingPrefix} ${u.partial}`.trim();
    let verdict: "listen" | "speak";
    try {
      verdict = await this.llm.decide(this.decisionPrompt, tail, text, signal);
    } catch (e) {
      if (isAbortError(e)) return;
      this.log(`[decision] ${e}`);
      verdict = "speak";
    }
    if (this.utt === u && u.lastSpeech === atSpeech) {
      u.decision = verdict;
      if (verdict === "listen") {
        u.listenUntil = u.lastSpeech + this.cfg.maxSilenceMs / 1000;
        this.log(`  … LLM: keep listening («${text.slice(-60)}»)`);
        this.emit({ type: "event", text: msg(this.cfg.locale, "evt.keepListening") });
      }
    }
  }

  private applyTurnEnd(u: Utterance, t: number): void {
    const action = checkTurnEnd(u, this.cfg, t);
    if (action.kind === "end") {
      this.endTurn(u, action.reason);
    } else if (action.kind === "ask") {
      u.decision = "pending";
      u.decisionText = action.decisionText;
      this.spawn((sig) => this.decide(u, u.lastSpeech, sig));
    }
  }

  private checkBargeConfirm(u: Utterance): void {
    /* Cancel the assistant for a real interruption without waiting for the turn end. */
    const spoken = this.resp!.spoken.join(" ");
    if (bargeInterrupts(u.partial, spoken, this.cfg)) {
      this.log(`  ✋ interrupted by user: «${u.partial.trim()}»`);
      this.emit({ type: "event", text: msg(this.cfg.locale, "evt.interrupted") });
      this.cancelResponse(true);
    }
  }

  // ── turn end → response ──

  private endTurn(u: Utterance, reason: string): void {
    this.utt = null;
    this.speechRunMs = 0;
    this.spawn((sig) => this.finishTurn(u, reason, sig));
    this.setState("thinking");
  }

  private async finishTurn(u: Utterance, reason: string, signal: AbortSignal): Promise<void> {
    const tEnd = now();
    const text = (await u.asr.finish(this.cfg.asrFlushPadMs, undefined, signal)).trim();
    if (signal.aborted) return; // close()/🧹 while flushing: the answer must not start
    const asrMs = (now() - tEnd) * 1000;

    if (this.pendingApproval !== null) {
      if (!hasWords(text)) {
        this.player.resume();
        this.refreshState();
        return;
      }
      if (this.answerApprovalText(text)) {
        this.emit({ type: "user", text, info: msg(this.cfg.locale, "user.replyConfirm") });
        this.refreshState();
        return;
      }
      // not a yes/no → falls through as a brand-new user turn
    }

    if (this.gen > u.gen && !u.barge && this.resp === null) {
      // the user started talking again while we were flushing: same turn, keep going
      if (hasWords(text)) {
        this.pendingPrefix = `${this.pendingPrefix} ${text}`.trim();
        this.log(`  ↺ user continued — «${text}» carried into the next utterance`);
      }
      return;
    }

    const respAlive = this.resp !== null && u.barge;
    if (respAlive && this.resp !== null) {
      const spoken = this.resp.spoken.join(" ");
      const verdict = bargeVerdict(text, spoken, this.cfg);
      if (verdict !== "interrupt") {
        const what = msg(
          this.cfg.locale,
          verdict === "resume-echo" ? "evt.echo" : "evt.backchannel",
        );
        this.log(`  ▶ resuming (${what}: «${text}»)`);
        this.emit({
          type: "event",
          text: msg(this.cfg.locale, "evt.resume", { what, text }),
        });
        this.player.resume();
        this.refreshState();
        return;
      }
      this.log(`  ✋ interrupted by user`);
      this.cancelResponse(true);
    }

    if (!hasWords(text) && !(this.pendingPrefix && this.gen === u.gen)) {
      if (this.resp && this.player.paused) this.player.resume();
      this.status("");
      this.emit({ type: "partial", text: "" });
      this.refreshState();
      return;
    }

    const full = `${this.pendingPrefix} ${text}`.trim();
    this.pendingPrefix = "";
    const silence = (tEnd - u.lastSpeech) * 1000;
    this.log(`🗣  ${full}`);
    this.log(
      `   turn end: ${reason}, gap ${silence.toFixed(0)} ms, ASR flush ${asrMs.toFixed(0)} ms`,
    );
    // the `user` line goes out from inside startResponse(): it can only carry the
    // checkpoint id of the history message it becomes there
    this.startResponse(
      full,
      u.lastSpeech,
      msg(this.cfg.locale, "user.turnEnd", {
        reason,
        gap: silence.toFixed(0),
        asr: asrMs.toFixed(0),
      }),
    );
  }
}
