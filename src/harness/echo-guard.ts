/**
 * Echo guard: the assistant hearing its own voice.
 *
 * A leaky echo canceller (phone, laptop speakers at high volume) lets the TTS back into the
 * mic, the VAD fires, and the ASR returns either a piece of what the assistant just said or
 * a classic recogniser hallucination of near-silence ("Subscribe.", "Thanks for watching").
 * Left alone, that cancels the reply or becomes a user turn the assistant then answers.
 *
 * The barge-in check (`barge-in.ts`) only compares with the *current* reply's spoken
 * sentences and counts every word, so function words ("you", "the", "in") inflate the
 * overlap, a reply that has just ended is no longer compared at all, and a hallucination of
 * the echo matches nothing. This guard keeps ~20 s of what was spoken, compares on content
 * words with a small fuzzy match, knows the hallucination phrases, and is consulted only for
 * utterances that started while the assistant was audible or within `tailMs` after playback
 * ended.
 */

import { words } from "./text";

/** Words that never decide an echo: they occur in any sentence of any reply. */
const STOPWORDS = new Set([
  // en
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "from",
  "by",
  "with",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "am",
  "it",
  "its",
  "it's",
  "i",
  "i'm",
  "you",
  "you're",
  "your",
  "we",
  "they",
  "he",
  "she",
  "him",
  "her",
  "his",
  "my",
  "me",
  "our",
  "their",
  "them",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "what",
  "which",
  "who",
  "how",
  "when",
  "where",
  "why",
  "do",
  "does",
  "did",
  "can",
  "could",
  "would",
  "will",
  "should",
  "not",
  "no",
  "so",
  "just",
  "then",
  "than",
  "too",
  "very",
  "all",
  "any",
  "some",
  "one",
  "up",
  "out",
  "about",
  "into",
  "over",
  "s",
  "t",
  // it
  "il",
  "lo",
  "la",
  "i",
  "gli",
  "le",
  "un",
  "uno",
  "una",
  "di",
  "da",
  "del",
  "della",
  "che",
  "e",
  "è",
  "o",
  "ma",
  "per",
  "con",
  "su",
  "non",
  "mi",
  "ti",
  "si",
  "ci",
  "ne",
  "a",
  "al",
  "alla",
  "in",
  "nel",
  "nella",
  "come",
  "cosa",
  "sono",
  "sei",
]);

/**
 * What a speech recogniser writes for silence, noise or a voice too garbled to decode —
 * subtitles of YouTube videos it was trained on. Inside the echo window these are never
 * the user (matched against the whole normalised utterance, or contained in it).
 */
const HALLUCINATION_EXACT = new Set([
  "subscribe",
  "please subscribe",
  "like and subscribe",
  "thank you for watching",
  "thanks for watching",
  "thank you for watching and see you next time",
  "see you next time",
  "you",
  "bye",
  "bye bye",
  "thank you",
  "thank you so much",
  "grazie per la visione",
  "grazie a tutti",
  "sottotitoli e revisione a cura di qtss",
]);
const HALLUCINATION_PART =
  /\bsubscri|\bfor watching\b|\bamara\.?org\b|\bsottotitoli\b|\bcaptions? by\b|\bthe channel\b/;

/**
 * Words that are a real interruption even when the assistant happened to say them too
 * ("…don't stop now" → the user's "stop"): an utterance carrying one is never an echo.
 */
const COMMAND_WORDS = new Set([
  "stop",
  "wait",
  "pause",
  "enough",
  "quiet",
  "shut",
  "cancel",
  "hold",
  "hey",
  "sonia",
  "basta",
  "fermo",
  "ferma",
  "fermati",
  "aspetta",
  "zitta",
  "silenzio",
  "annulla",
]);

export type EchoVerdict = { echo: boolean; reason: string; ratio: number };

/** Levenshtein distance, early exit above `max`. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length]! <= max;
}

/** A heard word "is" a spoken one: equal, or a near miss of a longer word (ASR slips). */
function fuzzyHas(w: string, spoken: Set<string>, spokenList: string[]): boolean {
  if (spoken.has(w)) return true;
  if (w.length < 4) return false;
  const max = w.length >= 8 ? 2 : 1;
  return spokenList.some((s) => s.length >= 4 && within(w, s, max));
}

/** Share of `heard`'s words found in `spoken`; content words decide when there are any. */
export function contentOverlap(heard: string, spoken: string): number {
  const hw = words(heard);
  if (!hw.length) return 0;
  const sw = words(spoken);
  const set = new Set(sw);
  const content = hw.filter((w) => !STOPWORDS.has(w));
  const base = content.length ? content : hw;
  const uniq = [...new Set(sw)];
  return base.filter((w) => fuzzyHas(w, set, uniq)).length / base.length;
}

export function isHallucination(text: string): boolean {
  const norm = words(text).join(" ");
  if (!norm) return false;
  return HALLUCINATION_EXACT.has(norm) || HALLUCINATION_PART.test(norm);
}

export class EchoGuard {
  /** What was spoken, with the time (s, `now()` clock) each sentence started playing. */
  private spoken: { t: number; text: string }[] = [];
  /** Last time the player was audible (s). */
  private lastAudible = Number.NEGATIVE_INFINITY;

  constructor(
    readonly windowS = 20,
    readonly tailMs = 1500,
    readonly threshold = 0.6,
  ) {}

  /** A sentence starts playing. */
  noteSpoken(text: string, t: number): void {
    if (!text.trim()) return;
    this.spoken.push({ t, text });
    this.prune(t);
  }

  /** Called every frame the player is audible. */
  noteAudible(t: number): void {
    this.lastAudible = t;
  }

  /** The assistant is speaking now, or stopped less than `tailMs` ago. */
  inWindow(t: number, speakingNow: boolean): boolean {
    return speakingNow || (t - this.lastAudible) * 1000 <= this.tailMs;
  }

  /** The assistant's text of the last `windowS` seconds (+ the reply in progress). */
  recentText(t: number, extra = ""): string {
    this.prune(t);
    return `${this.spoken.map((s) => s.text).join(" ")} ${extra}`.trim();
  }

  clear(): void {
    this.spoken = [];
  }

  private prune(t: number): void {
    // keep the sentence that started just before the window: it may still be playing
    while (this.spoken.length > 1 && t - this.spoken[1]!.t > this.windowS) this.spoken.shift();
    if (this.spoken.length === 1 && t - this.spoken[0]!.t > this.windowS * 2) this.spoken.shift();
  }

  /**
   * Is `heard` the assistant's own voice? Only meaningful for an utterance that began in
   * the echo window — the caller checks that (`inWindow` at the utterance's start).
   */
  verdict(heard: string, t: number, extra = ""): EchoVerdict {
    const ws = words(heard);
    if (!ws.length) return { echo: false, reason: "empty", ratio: 0 };
    if (ws.some((w) => COMMAND_WORDS.has(w))) return { echo: false, reason: "command", ratio: 0 };
    if (isHallucination(heard)) return { echo: true, reason: "asr-hallucination", ratio: 1 };
    const ratio = contentOverlap(heard, this.recentText(t, extra));
    return ratio >= this.threshold
      ? { echo: true, reason: "overlap", ratio }
      : { echo: false, reason: "new-words", ratio };
  }
}
