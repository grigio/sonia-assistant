/**
 * Turn-end rules (route R2): pause ≥ 200 ms → Smart Turn; score ≥ 0.5 + pause ≥ 300 ms
 * → turn ends; pause ≥ 900 ms + "not finished" → 4-token LLM decision LISTEN/REPLY.
 * Pure rules over the `Utterance` + `Config` — no I/O, nothing but the fields it resets.
 */

import type { Config } from "../config";
import type { Utterance } from "./assistant";
import { BACKCHANNELS, hasWords, words } from "./text";

export type TurnEndAction =
  | { kind: "none" } // nothing to decide yet
  | { kind: "wait" } // a decision is pending, or inside the "keep listening" window
  | { kind: "end"; reason: string } // the turn is over
  | { kind: "ask"; decisionText: string }; // spawn the LLM decision prompt

export function checkTurnEnd(u: Utterance, cfg: Config, now: number): TurnEndAction {
  const silenceMs = (now - u.lastSpeech) * 1000;
  if (silenceMs < cfg.minSilenceMs) return { kind: "none" };

  if (
    (u.decision === "listen" || u.decision === "speak") &&
    u.partial.trim() !== u.decisionText
  ) {
    // late partial words arrived during the pause (ASR lags ~0.5 s): judge again
    u.decision = null;
    u.listenUntil = 0;
  }

  if (u.listenUntil) {
    if (now >= u.listenUntil) return { kind: "end", reason: "max silence" };
    return { kind: "wait" };
  }

  let complete = u.turnProb !== null && u.turnProb >= cfg.smartTurnThreshold;
  const candidate = complete || silenceMs >= cfg.silenceMs;
  if (!candidate) return { kind: "none" };

  let ask = cfg.decisionMode === "always" || (cfg.decisionMode === "auto" && !complete);
  if (!hasWords(u.partial)) {
    ask = false; // partials lag ~0.5 s; nothing to judge yet → rely on audio signals
  } else if (cfg.decisionMode === "auto" && /[.?!]\W*$/.test(u.partial.trim())) {
    ask = false; // Voxtral punctuated a finished sentence: no need to ask the LLM
    complete = true;
  }

  if (!ask) {
    const reason =
      complete && u.turnProb !== null && u.turnProb >= cfg.smartTurnThreshold
        ? `smart-turn ${u.turnProb.toFixed(2)}`
        : complete
          ? "punctuation"
          : "silence";
    return { kind: "end", reason };
  }
  if (u.decision === null) return { kind: "ask", decisionText: u.partial.trim() };
  if (u.decision === "speak") return { kind: "end", reason: "LLM decision" };
  return { kind: "wait" };
}

/** Words in a partial that are NOT backchannels (barge-in confirmation count). */
export function realWords(partial: string): string[] {
  return words(partial).filter((w) => !BACKCHANNELS.has(w));
}
