/**
 * Barge-in / echo rules: pause right away, cancel on a real interruption,
 * resume on backchannels or an echo of the assistant's own words.
 */

import type { Config } from "../config";
import { echoRatio, isBackchannel, words } from "./text";
import { realWords } from "./turn";

/** `_check_barge_confirm`: cancel the assistant without waiting for the turn end. */
export function bargeInterrupts(partial: string, spoken: string, cfg: Config): boolean {
  return (
    realWords(partial).length >= cfg.bargeConfirmWords &&
    echoRatio(partial, spoken) < cfg.echoOverlap
  );
}

export type BargeVerdict = "resume-echo" | "resume-backchannel" | "interrupt";

/**
 * `_finish_turn` while a response is still alive (`u.barge`): decide between
 * resuming playback or cancelling; anything intelligible that is neither a
 * backchannel nor an echo falls through as an interruption.
 */
export function bargeVerdict(
  text: string,
  spokenJoined: string,
  cfg: Config,
): BargeVerdict {
  const ws = words(text);
  if (!ws.length || isBackchannel(text) || echoRatio(text, spokenJoined) >= cfg.echoOverlap) {
    const what = ws.length && !isBackchannel(text) ? "echo" : "backchannel";
    return what === "echo" ? "resume-echo" : "resume-backchannel";
  }
  return "interrupt";
}
