/** POSIX-ish shell word splitting: single/double quotes, backslash escapes, no comments. */

/** One word, plus how many shell-separator characters reached it from *outside* quotes.
 *  The policy layer needs to tell `a;b` (two commands) from merely a quoted "a;b.txt". */
export interface ShlexWord {
  word: string;
  /** count of unquoted `;` / `&` / `|` characters that make up this word */
  bare: number;
}

export function shlexSplitWords(s: string): ShlexWord[] {
  const out: ShlexWord[] = [];
  let cur = "";
  let bare = 0;
  let inToken = false;
  let i = 0;

  const push = () => {
    if (inToken) {
      out.push({ word: cur, bare });
      cur = "";
      bare = 0;
      inToken = false;
    }
  };

  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      push();
      i++;
      continue;
    }
    if (c === "'") {
      inToken = true;
      i++;
      const end = s.indexOf("'", i);
      if (end < 0) throw new Error("No closing quotation");
      cur += s.slice(i, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      inToken = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[i + 1]!;
          cur += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
          i += 2;
        } else {
          cur += s[i]!;
          i++;
        }
      }
      if (i >= s.length) throw new Error("No closing quotation");
      i++; // closing "
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      inToken = true;
      cur += s[i + 1]!;
      i += 2;
      continue;
    }
    inToken = true;
    cur += c;
    if (c === ";" || c === "&" || c === "|") bare += 1; // outside quotes: control flow
    i++;
  }
  push();
  return out;
}

export function shlexSplit(s: string): string[] {
  return shlexSplitWords(s).map((w) => w.word);
}
