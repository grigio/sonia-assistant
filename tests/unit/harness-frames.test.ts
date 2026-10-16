/**
 * The 32 ms frame loop, end to end and *without* any network: real Silero frames in, a
 * stubbed transcript out. This is the flow the whole app exists for:
 *
 *   silence → loud tone (Silero ≥ 0.5 for ≥ vadMinSpeechMs) → utterance starts →
 *   more speech → 200 ms of silence books Smart Turn (p = 0.99) →
 *   silence ≥ minSilenceMs ends the turn → asr.finish() → the text becomes a response,
 *   state `thinking`.
 *
 * The stubs sit exactly on the seams the loop defines — `turn.probability(audio)` and
 * each utterance's `asr.send/finish` — so this test asserts the *routing*, not ONNX's
 * arithmetic (vad.test.ts covers the model itself, and the skip-for-absent-model rule
 * is the same one: CI fetches models, a fresh clone still runs the suite).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Player } from "../../src/audio/player";
import { Config, ROOT } from "../../src/config";
import { Harness } from "../../src/harness/harness";
import { sleep } from "../../src/util";
import { SileroVAD, VAD_FRAME } from "../../src/vad";

const MODEL = path.join(ROOT, "models", "silero", "silero_vad.onnx");
const have = fs.existsSync(MODEL);
const it = (have ? test : test.skip) as typeof test;

/** `VAD_FRAME` samples of a 16 kHz tone, int16 LE — exactly what a 32 ms frame is. */
function frame(amp: number): Uint8Array {
  const b = new Uint8Array(VAD_FRAME * 2);
  const v = new DataView(b.buffer);
  for (let i = 0; i < VAD_FRAME; i++) {
    v.setInt16(i * 2, Math.trunc(Math.sin(i / 8) * amp), true);
  }
  return b;
}

describe("processFrame: a spoken turn ends and becomes a response", () => {
  it("silence → tone → utterance → smart-turn 0.99 → silence ≥ 300 ms → thinking", async () => {
    if (!have) return;
    const cfg = new Config();
    // The driver is a tone, not a voice: Silero is right not to score it ≥ 0.5 (it
    // peaks ≈ 0.12; vad.test.ts pins the *relative* scoring). The gate itself is a
    // config knob, so the routing test gates the tone in (silence stays ≤ 0.010).
    cfg.vadStartThreshold = 0.04;
    cfg.vadEndThreshold = 0.02;
    const a = new Harness(cfg, null, "null"); // no start(): no sockets, no loops

    // The pieces start() would have built — enough for the frame loop to run:
    // a silent, silent-sink player (audible === false) and the real VAD.
    a.player = new Player(24_000, "", 60, "null", null);
    await a.player.start();
    a.vad = await new SileroVAD(MODEL).ready;
    (a as unknown as { turn: unknown }).turn = {
      probability: async () => 0.99, // the model says: a complete request
    };

    // A transcript that never opens a socket is rented in at startUtterance: the real
    // LiveTranscription the spawn starts fails calmly offline and is thrown away.
    const responses: { text: string; info?: string }[] = [];
    const h = a as unknown as {
      startUtterance: (t: number) => void;
      startResponse: (text: string, t: number, info?: string) => void;
    };
    h.startUtterance = (t: number) => {
      (Harness.prototype.startUtterance as (t: number) => void).call(a, t);
      const u = a.utt as unknown as { asr: unknown };
      u.asr = {
        send: () => {},
        open: async () => {},
        finish: async (_pad?: number, _timeout?: number, _signal?: AbortSignal) =>
          "quanto costa la cioccolata calda",
      };
    };
    h.startResponse = (text: string, _t: number, info?: string) => {
      responses.push({ text, info });
      a.setState("thinking"); // the real one would stream the LLM; here: stay thinking
    };

    // Virtual clock: every frame is 32 ms, exactly the loop's contract.
    let tMs = 0;
    const pump = async (n: number, amp: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        await a.processFrame(frame(amp), tMs / 1000);
        tMs += 32;
      }
    };

    await pump(20, 0); // ~0.6 s of silence: quiet context, nothing started
    expect(a.utt).toBeNull();
    expect(a.state).toBe("listening");

    // The tone: the gate sits at 0.04 (the tone scores 0.05–0.12 from its third
    // frame), then vadMinSpeechMs (96 ms) confirms — 10 attempts are far more than enough
    for (let i = 0; i < 10 && a.utt === null; i++) await pump(1, 12_000);
    expect(a.utt, "a speech-loud tone must open an utterance").not.toBeNull();

    await pump(8, 12_000); // still talking in the opened utterance (~0.25 s)
    expect(a.utt).not.toBeNull();

    // Silence: ≥ turnCheckMs (200 ms) books the Smart Turn once, ≥ minSilenceMs
    // (300 ms) with p ≥ smartTurnThreshold ends the turn — no LLM decision asked
    // (decisionMode auto + a complete request).
    await pump(1, 0); // the frame where speech stops
    expect(a.state).toBe("user");
    await pump(16, 0); // 512 ms: past both thresholds
    expect(a.utt).toBeNull(); // the turn ended on its own
    expect(a.state).toBe("thinking");

    // The answer text travels through asr.finish → startResponse, asynchronously.
    for (let i = 0; i < 100 && responses.length === 0; i++) await sleep(20);
    expect(responses).toHaveLength(1);
    expect(responses[0]!.text).toContain("cioccolata");
    expect(responses[0]!.info, "the end reason").toContain("smart-turn");
  });
});
