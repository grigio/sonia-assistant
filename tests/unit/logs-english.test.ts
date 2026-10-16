/**
 * The terminal / `data/logs/*.log` output is English-only, whatever `LOCALE` says.
 *
 * `LOCALE` is a *user-facing* language: the page, the chat lines, what the TTS reads and
 * a tool's result follow it. The log is a diagnostic stream you read across sessions and
 * paste into a bug report, so its own wording never switches language — the harness used
 * to write Italian there (`voce sconosciuta`, `elenco modelli: 14 voci (invariate)`,
 * `default di pi`, `pi: nessun testo in output`).
 *
 * ## How this is checked, and why not with a regex over a window
 *
 * The first version of this guard read the 300 characters of source after every call site
 * and failed on any Italian accent in there. That is a proximity test, not a wording test:
 *
 *  - it fired on `this.log(…)` calls whose *arguments* were harness data (`${name}`,
 *    `${ev.result}`, an identifier built a few lines earlier) — i.e. on exactly the
 *    payloads this test is meant to exempt;
 *  - its result depended on formatting: wrapping a call, renaming a neighbouring variable
 *    or reordering two statements could flip it, so it failed builds for reasons that had
 *    nothing to do with language, and a long line could hide a real violation past the
 *    window.
 *
 * So the guard now *parses* each call's first argument and inspects only its **static
 * text**: the literal chunks of a template literal, the contents of a plain string, each
 * piece of a `"a" + "b"` concatenation. `${…}` holes and bare expressions are data by
 * construction and are dropped, which is the exemption the header describes — enforced
 * structurally instead of by a 300-character guess.
 *
 * The known cost of being precise: a call whose whole argument is a bare identifier
 * (`this.log(head + …)`, `assistant.ts:1108`) has no static text and is therefore not
 * checked. `onlyIndirectArguments` below reports those, and the count is asserted, so the
 * blind spot cannot grow unnoticed — a call that gains an Italian literal is caught the
 * moment the literal is written inline.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../src/config";

/** Every place whose text can end up in a log line (the argument usually spans lines). */
const CALL = /\.log\(|\.status\(|console\.(?:log|error|warn|info)\(|throw new Error\(/g;

/** Italian accents never occur in an English line — the cheapest, strictest signal. */
const ACCENT = /[àèéìòùÀÈÉÌÒÙ]/;

/** The words the harness' own log lines are made of. */
const ITALIAN_WORDS =
  /(^|[^a-zàèéìòù])(voce|voci|elenco|modelli|sconosciuta|salvata|invariate|totali|nessun|utente|assistente|aggiornato|disattivata|autorizzato|esecuzione|interrotto|interrotta|scelta|degli|delle|della|frase|parlare)([^a-zàèéìòù]|$)/i;

/** Files allowed to carry Italian: the catalogue itself and the yes/no word lists. */
const EXEMPT = new Set(["i18n.ts", "text.ts"]);

/**
 * How far into the file a `${…}` hole is skipped. Holes hold harness expressions — the
 * odd nested literal (`${pkg.name} (${lang})`, `evt.resume`, a regex) — and this is the
 * character budget under which one is treated as pathological rather than legitimate.
 */
const MAX_HOLE = 600;

/** Skip a hole's contents: balanced `{}`, with strings, comments and nested templates. */
function skipHole(src: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < src.length && i - start <= MAX_HOLE) {
    const c = src[i]!;
    if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      depth--;
      i++;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'") {
      i = skipQuoted(src, i, c);
    } else if (c === "`") {
      i = skipTemplate(src, i).end;
    } else if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      i++;
    }
  }
  return i;
}

/** A `'…'` or `"…"` literal: return the index just past its closing quote. */
function skipQuoted(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") i += 2;
    else if (c === quote) return i + 1;
    else i++;
  }
  return src.length;
}

/**
 * A `` `…` `` template: collect its literal chunks, skipping every `${…}` hole. Returns
 * the index just past the closing backtick.
 */
function skipTemplate(src: string, start: number): { text: string; end: number } {
  let i = start + 1;
  let text = "";
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      text += src.slice(i, i + 2);
      i += 2;
    } else if (c === "`") {
      return { text, end: i + 1 };
    } else if (c === "$" && src[i + 1] === "{") {
      i = skipHole(src, i + 2);
    } else {
      text += c;
      i++;
    }
  }
  return { text, end: i };
}

/**
 * The static text of one call's first argument, starting at `from` (just past the `(`).
 * Returns `null` when the argument is a bare expression with no literal part.
 */
function staticArg(src: string, from: number): { text: string; end: number } | null {
  let i = from;
  let text = "";
  let literal = false;
  for (;;) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    const c = src[i]!;
    if (c === "`") {
      const t = skipTemplate(src, i);
      text += t.text;
      literal = true;
      i = t.end;
    } else if (c === '"' || c === "'") {
      const end = skipQuoted(src, i, c);
      text += src.slice(i + 1, end - 1);
      literal = true;
      i = end;
    } else {
      // a bare expression: the operand's own extent does not matter, only whether a
      // `+` follows it — which the loop below finds either way
      i++;
      while (i < src.length && !/[+\s,)]/.test(src[i]!)) {
        if ("\"'`({".includes(src[i]!)) break;
        i++;
      }
    }
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] === "+") {
      i++;
      continue;
    }
    break;
  }
  return literal ? { text, end: i } : null;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

type Site = { file: string; line: number; text: string };

function scan(): { sites: Site[]; indirect: string[] } {
  const sites: Site[] = [];
  const indirect: string[] = [];
  for (const file of sources(path.join(ROOT, "src"))) {
    if (EXEMPT.has(path.basename(file))) continue;
    const src = fs.readFileSync(file, "utf-8");
    const rel = path.relative(ROOT, file);
    CALL.lastIndex = 0;
    for (let m = CALL.exec(src); m !== null; m = CALL.exec(src)) {
      const line = src.slice(0, m.index).split("\n").length;
      const arg = staticArg(src, m.index + m[0].length);
      if (arg === null) indirect.push(`${rel}:${line}`);
      else if (arg.text.trim()) sites.push({ file: rel, line, text: arg.text });
    }
  }
  return { sites, indirect };
}

describe("logs are English-only", () => {
  const { sites, indirect } = scan();

  test("the scan is not silently empty", () => {
    // a broken extractor would find nothing and pass everything
    expect(sites.length).toBeGreaterThan(100);
    expect(indirect.length).toBeGreaterThan(0); // the blind spot is real and counted
  });

  test("no log line or thrown error is written in Italian", () => {
    const offenders = sites
      .filter((s) => ACCENT.test(s.text) || ITALIAN_WORDS.test(s.text))
      .map((s) => `${s.file}:${s.line} → ${s.text.replace(/\s+/g, " ").trim().slice(0, 120)}`);
    expect(offenders).toEqual([]);
  });

  test("calls whose whole argument is a bare identifier stay few enough to read", () => {
    // Each one is a place where wording *could* hide with no literal to inspect. The
    // count is pinned so a refactor that turns 4 checked calls into 40 unchecked ones
    // has to be a deliberate edit here rather than a silent loss of coverage.
    expect(indirect.length).toBeLessThanOrEqual(12);
  });
});
