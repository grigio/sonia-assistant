/**
 * `src/harness/turn.ts` — the end-of-turn rules (route R2). Pure: silence gap +
 * Smart Turn score + the 4-token judge's verdict, in that order. This is the decision the
 * whole full-duplex behaviour hangs on, and it had no test at all.
 */
import { describe, expect, test } from "bun:test";
import type { LiveTranscription } from "../../src/clients/audiocpp";
import { Config } from "../../src/config";
import type { Utterance } from "../../src/harness/assistant";
import { checkTurnEnd, realWords, type TurnEndAction } from "../../src/harness/turn";

/** A `Utterance` with only the fields `checkTurnEnd` reads. */
function utt(over: Partial<Utterance> = {}): Utterance {
  return {
    gen: 1,
    asr: null as unknown as LiveTranscription,
    tStart: 0,
    lastSpeech: 100, // seconds — `now` is relative to it
    audio: [],
    speechMs: 0,
    pauseChecked: false,
    turnProb: null,
    decision: null,
    decisionText: "",
    listenUntil: 0,
    barge: false,
    partial: "",
    ...over,
  };
}

const cfg = (over: Partial<Config> = {}): Config => Object.assign(new Config(), over);

/** The decision, or the reason the turn ended. */
const at = (u: Utterance, c: Config, silenceMs: number): TurnEndAction =>
  checkTurnEnd(u, c, u.lastSpeech + silenceMs / 1000);

describe("the silence gap", () => {
  test("below MIN_SILENCE_MS nothing is decided yet", () => {
    expect(at(utt({ partial: "ciao" }), cfg(), 100)).toEqual({ kind: "none" });
    expect(at(utt({ partial: "ciao" }), cfg(), 299)).toEqual({ kind: "none" });
  });

  test("a pause that is not yet a candidate stays silent — no judge, no end", () => {
    expect(at(utt({ partial: "ciao" }), cfg(), 400)).toEqual({ kind: "none" });
  });

  test("past SILENCE_MS the turn is decided: in auto mode a real partial goes to the judge", () => {
    expect(at(utt({ partial: "ciao" }), cfg(), 900)).toEqual({ kind: "ask", decisionText: "ciao" });
  });

  test("the score is what buys the early end: 900 ms are not needed", () => {
    const r = at(utt({ partial: "ciao", turnProb: 0.87 }), cfg(), 350);
    expect(r).toEqual({ kind: "end", reason: "smart-turn 0.87" });
  });

  test("a score under the threshold is not a finish: the silence gap still applies", () => {
    expect(at(utt({ partial: "ciao", turnProb: 0.2 }), cfg(), 350)).toEqual({ kind: "none" });
    expect(at(utt({ partial: "ciao", turnProb: 0.2 }), cfg(), 900)).toEqual({
      kind: "ask",
      decisionText: "ciao",
    });
    // …and with nothing to judge (no words yet) the gap alone ends it
    expect(at(utt({ partial: "", turnProb: 0.2 }), cfg(), 900)).toEqual({
      kind: "end",
      reason: "silence",
    });
  });
});

describe("DECISION_MODE", () => {
  test('"off" never asks the LLM: the audio signals alone end the turn', () => {
    const c = cfg({ decisionMode: "off" });
    expect(at(utt({ partial: "Che ore sono" }), c, 1000)).toEqual({
      kind: "end",
      reason: "silence",
    });
  });

  test('"auto" asks only when nothing else finished the turn', () => {
    const c = cfg({ decisionMode: "auto" });
    expect(at(utt({ partial: "Che ore sono" }), c, 1000)).toEqual({
      kind: "ask",
      decisionText: "Che ore sono",
    });
    // …but a Smart Turn "complete" is an answer in itself: no second opinion needed
    expect(at(utt({ partial: "Che ore sono", turnProb: 0.9 }), c, 1000)).toEqual({
      kind: "end",
      reason: "smart-turn 0.90",
    });
  });

  test('"always" asks even on a confident score', () => {
    const c = cfg({ decisionMode: "always" });
    expect(at(utt({ partial: "Che ore sono", turnProb: 0.9 }), c, 1000)).toEqual({
      kind: "ask",
      decisionText: "Che ore sono",
    });
  });

  test('a trailing question/exclamation ends it as "punctuation" — the model already finished', () => {
    expect(at(utt({ partial: "Che ore sono?" }), cfg(), 1000)).toEqual({
      kind: "end",
      reason: "punctuation",
    });
  });

  test("an ellipsis is NOT a sentence end here (only .?!): the judge still gets asked", () => {
    // `SentenceSplitter.END` accepts `…`, the turn judge's regex does not — pinned as it
    // stands, so a future "should `…` end a turn too?" is a deliberate change.
    expect(at(utt({ partial: "Va bene così…" }), cfg(), 1000)).toEqual({
      kind: "ask",
      decisionText: "Va bene così…",
    });
  });

  test("an empty partial is never judged: ASR partials lag ~0.5 s", () => {
    expect(at(utt({ partial: "" }), cfg({ decisionMode: "always" }), 1000)).toEqual({
      kind: "end",
      reason: "silence",
    });
    expect(at(utt({ partial: "   " }), cfg({ decisionMode: "always" }), 1000)).toEqual({
      kind: "end",
      reason: "silence",
    });
  });
});

describe("the judge's verdict", () => {
  test("LISTEN holds the turn open until MAX_SILENCE_MS, then ends it", () => {
    const u = utt({
      partial: "Che ore sono",
      decision: "listen",
      decisionText: "Che ore sono",
      listenUntil: 100 + 2.5,
    });
    expect(at(u, cfg(), 1000)).toEqual({ kind: "wait" });
    expect(at(u, cfg(), 2499)).toEqual({ kind: "wait" });
    expect(at(u, cfg(), 2500)).toEqual({ kind: "end", reason: "max silence" });
  });

  test("REPLY ends the turn with the judge's own reason", () => {
    const u = utt({
      partial: "Che ore sono",
      decision: "speak",
      decisionText: "Che ore sono",
    });
    expect(at(u, cfg(), 1000)).toEqual({ kind: "end", reason: "LLM decision" });
  });

  test("late ASR words invalidate the verdict: the partial it judged is not what was said", () => {
    const u = utt({
      partial: "Che ore sono adesso",
      decision: "listen",
      decisionText: "Che ore sono", // the judge saw the shorter partial
      listenUntil: 100 + 2.5,
    });
    expect(at(u, cfg(), 1000)).toEqual({
      kind: "ask",
      decisionText: "Che ore sono adesso",
    });
    // the verdict and its window are dropped here; the caller stamps "pending"
    expect(u.decision).toBeNull();
    expect(u.listenUntil).toBe(0);
  });

  test('"pending" (the request is in flight) waits, whatever the clock says', () => {
    const u = utt({ partial: "Che ore sono", decision: "pending", decisionText: "…" });
    expect(at(u, cfg(), 5000)).toEqual({ kind: "wait" });
  });
});

describe("realWords (the barge-in confirmation count)", () => {
  test("backchannels do not count as an interruption", () => {
    expect(realWords("mhm sì")).toEqual([]);
    expect(realWords("ok certo")).toEqual([]);
  });

  test("real speech does", () => {
    expect(realWords("Sì, fermati adesso")).toEqual(["fermati", "adesso"]);
  });

  test("an empty partial is empty, not an error", () => {
    expect(realWords("")).toEqual([]);
  });
});
