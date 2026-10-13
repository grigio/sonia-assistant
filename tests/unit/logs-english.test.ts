/**
 * The terminal / `data/logs/*.log` output is English-only, whatever `LOCALE` says.
 *
 * `LOCALE` is a *user-facing* language: the page, the chat lines, what the TTS reads and
 * a tool's result follow it. The log is a diagnostic stream you read across sessions and
 * paste into a bug report, so its own wording never switches language — the harness used
 * to write Italian there (`voce sconosciuta`, `elenco modelli: 14 voci (invariate)`,
 * `default di pi`, `pi: nessun testo in output`).
 *
 * The guard reads every string a log call (or a thrown error, which lands in the log too)
 * can print and fails on an Italian accent or one of the words we used to write in
 * Italian. Payloads are exempt by construction: `this.log(\`🤖 ${text}\`)` prints what the
 * model said, and that is data in the user's language, not the harness' own wording.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../src/config";

/** Every place whose text can end up in a log line (the argument usually spans lines). */
const CALL = /\.log\(|\.status\(|console\.(?:log|error|warn|info)\(|throw new Error\(/g;

/** How far into the call's arguments we read: a template literal never runs further. */
const WINDOW = 300;

/** Italian accents never occur in an English line — the cheapest, strictest signal. */
const ACCENT = /[àèéìòùÀÈÉÌÒÙ]/;

/** The words the harness' own log lines are made of. */
const ITALIAN_WORDS =
  /(^|[^a-zàèéìòù])(voce|voci|elenco|modelli|sconosciuta|salvata|invariate|totali|nessun|utente|assistente|aggiornato|disattivata|autorizzato|esecuzione|interrotto|interrotta|scelta|degli|delle|della|frase|parlare)([^a-zàèéìòù]|$)/i;

/** Files allowed to carry Italian: the catalogue itself and the yes/no word lists. */
const EXEMPT = new Set(["i18n.ts", "text.ts"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = sources(path.join(ROOT, "src")).filter((f) => !EXEMPT.has(path.basename(f)));

describe("logs are English-only", () => {
  test("there are source files to scan (the guard is not silently empty)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test("no log line or thrown error is written in Italian", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf-8");
      CALL.lastIndex = 0;
      for (let m = CALL.exec(text); m !== null; m = CALL.exec(text)) {
        const window = text.slice(m.index, m.index + WINDOW);
        if (ACCENT.test(window) || ITALIAN_WORDS.test(window)) {
          const line = text.slice(0, m.index).split("\n").length;
          offenders.push(`${path.relative(ROOT, file)}:${line} → ${window.slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
