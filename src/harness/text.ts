/** Text helpers: word extraction, backchannels, yes/no, echo ratio. */

export const BACKCHANNELS = new Set([
  "sì",
  "si",
  "ok",
  "okay",
  "mhm",
  "mh",
  "mm",
  "mmh",
  "ah",
  "eh",
  "ehm",
  "uhm",
  "aha",
  "certo",
  "già",
  "giusto",
  "esatto",
  "capito",
  "vabbè",
  "bene",
  "perfetto",
  "ecco",
  "va",
  "yes",
  "yeah",
  "right",
  "uh-huh",
  "hm",
  "hmm",
  "oh",
]);

export const YES_WORDS = new Set([
  "sì",
  "si",
  "ok",
  "okay",
  "esegui",
  "eseguilo",
  "vai",
  "procedi",
  "certo",
  "conferma",
  "confermo",
  "fallo",
  "pure",
  "yes",
  "va",
  "bene",
  "d'accordo",
  "daccordo",
  "autorizzo",
]);

export const NO_WORDS = new Set([
  "no",
  "annulla",
  "stop",
  "fermo",
  "ferma",
  "aspetta",
  "non",
  "nega",
  "lascia",
  "niente",
]);

/**
 * Unicode word regex: JS `\w` is ASCII-only, so we use `\p{L}` — which keeps every
 * accented letter (à è é ì í ò ó ù ú …) instead of dropping it.
 */
export const WORD = /[\p{L}\p{N}_']+/gu;
const WORD_ANY = /[\p{L}\p{N}_']/u;

export function words(text: string): string[] {
  WORD.lastIndex = 0;
  return [...text.toLocaleLowerCase("it").matchAll(WORD)].map((m) => m[0]!);
}

export function hasWords(text: string): boolean {
  return WORD_ANY.test(text);
}

export function isBackchannel(text: string): boolean {
  const ws = words(text);
  return ws.length > 0 && ws.length <= 3 && ws.every((w) => BACKCHANNELS.has(w));
}

export function classifyYesNo(text: string): "yes" | "no" | null {
  const ws = words(text);
  if (!ws.length || ws.length > 6) return null;
  if (ws.some((w) => NO_WORDS.has(w))) return "no";
  if (ws.some((w) => YES_WORDS.has(w))) return "yes";
  return null;
}

export function echoRatio(heard: string, spoken: string): number {
  const hw = words(heard);
  const sw = new Set(words(spoken));
  if (!hw.length) return 1.0;
  return hw.filter((w) => sw.has(w)).length / hw.length;
}
