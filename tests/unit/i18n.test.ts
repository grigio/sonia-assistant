/**
 * The two catalogues behind `LOCALE` (.env → src/config.ts):
 *
 *   - `normalizeLocale` accepts how people actually write a locale (`it`, `IT`,
 *     `it_IT.UTF-8`, `en_GB`) and refuses everything this build does not ship;
 *   - `t()` fills `{placeholders}` and leaves an unknown one visible instead of
 *     swallowing it;
 *   - both shipped languages carry the same keys (typed at compile time — this test
 *     pins the runtime half of it: no key may render as `some.key`).
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Config, ROOT } from "../../src/config";
import {
  DEFAULT_LOCALE,
  LOCALES,
  detectLocale,
  intlLocale,
  normalizeLocale,
  parseLocale,
  t,
} from "../../src/i18n";

/** Every key the server side ships, one per message the user can end up reading. */
const SAMPLE_KEYS = [
  "user.replyConfirm",
  "user.turnEnd",
  "evt.bargePause",
  "evt.resume",
  "evt.cmdApproved",
  "via.click",
  "spoken.approveCommand",
  "announce.timerExpired",
  "hist.interrupted",
  "gated.tool",
  "pi.addendum",
  "prompt.langDefault",
  "role.user",
  "role.assistant",
  "cmd.none",
  "cmd.denied",
  "cmd.timeout",
  "date.full",
  "timer.set",
  "note.saved",
  "note.clearAsk",
  "tool.truncated",
  "tool.gatedInfo",
  "tool.unknown",
] as const;

describe("normalizeLocale", () => {
  test("our two languages, in the spellings people actually type", () => {
    expect(normalizeLocale("it")).toBe("it");
    expect(normalizeLocale("IT")).toBe("it");
    expect(normalizeLocale(" it ")).toBe("it");
    expect(normalizeLocale("it_IT.UTF-8")).toBe("it");
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en_GB")).toBe("en");
    expect(normalizeLocale("en-US")).toBe("en");
  });

  test("unset → the default (Italian); a language we do not ship → English", () => {
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(null)).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("   ")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("fr")).toBe("en");
    expect(normalizeLocale("de_DE.UTF-8")).toBe("en");
    expect(normalizeLocale("zh")).toBe("en");
  });

  test("parseLocale says null for what we do not ship, instead of guessing", () => {
    expect(parseLocale("it")).toBe("it");
    expect(parseLocale("IT")).toBe("it");
    expect(parseLocale("it_IT.UTF-8")).toBe("it");
    expect(parseLocale("en-GB")).toBe("en");
    expect(parseLocale("")).toBeNull();
    expect(parseLocale(undefined)).toBeNull();
    expect(parseLocale("fr")).toBeNull();
  });
});

describe("detectLocale", () => {
  test("the user's own words beat the UI's language", () => {
    expect(detectLocale("tra cinque minuti il saluto finale", "en")).toBe("it");
    expect(detectLocale("remind me in five minutes about the final greeting", "it")).toBe("en");
  });

  test("an accent is Italian whatever else the text says", () => {
    expect(detectLocale("caffè", "en")).toBe("it");
    expect(detectLocale("the caffè in cucina", "it")).toBe("it");
  });

  test("nothing to go by → the fallback (never a guess)", () => {
    expect(detectLocale("")).toBe(DEFAULT_LOCALE);
    expect(detectLocale(null, "en")).toBe("en");
    expect(detectLocale("Saluto finale", "en")).toBe("en"); // no marker, no vote
  });
});

describe("t()", () => {
  test("every shipped locale answers every key with text, not with the key", () => {
    for (const locale of LOCALES) {
      for (const key of SAMPLE_KEYS) {
        const out = t(locale, key);
        expect(out).toBeString();
        expect(out).not.toBe(key);
        expect(out.length).toBeGreaterThan(0);
      }
    }
  });

  test("{placeholders} are filled from the vars", () => {
    expect(t("it", "note.removed", { idx: 2, victim: "comprare il pane" })).toBe(
      "Nota 2 rimossa: «comprare il pane».",
    );
    expect(t("en", "note.removed", { idx: 2, victim: "buy milk" })).toBe(
      "Note 2 removed: «buy milk».",
    );
    expect(t("it", "timer.set", { label: "caffè", s: 60 })).toBe(
      "Timer 'caffè' impostato per 60 secondi.",
    );
    expect(t("en", "timer.set", { label: "coffee", s: 60 })).toBe(
      "Timer 'coffee' set for 60 seconds.",
    );
    expect(t("it", "cmd.timeout", { s: 30 })).toBe("[timeout dopo 30s] ");
    expect(t("en", "cmd.timeout", { s: 30 })).toBe("[timed out after 30s] ");
  });

  test("an unknown placeholder stays visible instead of vanishing", () => {
    const out = t("it", "note.removed", { idx: 1 });
    expect(out).toContain("{victim}");
    expect(out).toContain("Nota 1 rimossa");
  });

  test("the two languages render the same message in their own words", () => {
    const it = t("it", "hist.interrupted");
    const en = t("en", "hist.interrupted");
    expect(it).toBe("[interrotto dall'utente]");
    expect(en).toBe("[interrupted by the user]");
    expect(it).not.toBe(en);
  });

  test("the date helper follows the locale", () => {
    expect(intlLocale("it")).toBe("it-IT");
    expect(intlLocale("en")).toBe("en-GB");
  });
});

describe("Config.locale", () => {
  test("LOCALE is a normal env knob of Config.fromEnv", () => {
    const prev = process.env["LOCALE"];
    try {
      process.env["LOCALE"] = "en";
      expect(Config.fromEnv().locale).toBe("en");
      process.env["LOCALE"] = "it_IT.UTF-8";
      expect(Config.fromEnv().locale).toBe("it");
      process.env["LOCALE"] = "xx_YY";
      expect(Config.fromEnv().locale).toBe("en");
      delete process.env["LOCALE"];
      expect(Config.fromEnv().locale).toBe("it");
    } finally {
      if (prev === undefined) delete process.env["LOCALE"];
      else process.env["LOCALE"] = prev;
    }
  });
});

// ── the page's own catalogue (static/index.html runs before the WebSocket exists) ──

describe("UI_STRINGS in static/index.html", () => {
  const html = fs.readFileSync(path.join(ROOT, "static", "index.html"), "utf-8");

  /** The `const UI_STRINGS = {…};` literal, evaluated on its own. */
  const page = ((): Record<string, Record<string, string>> => {
    const start = html.indexOf("const UI_STRINGS = {");
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf("\n};", start);
    expect(end).toBeGreaterThan(start);
    const literal = html.slice(start + "const UI_STRINGS =".length, end + 2).trim();
    return new Function(`return (${literal})`)() as Record<string, Record<string, string>>;
  })();

  test("the server can stamp a locale into the page", () => {
    expect(html).toContain('lang="__LOCALE__"');
    expect(html).toContain('Object.hasOwn(UI_STRINGS, "__LOCALE__")');
  });

  test("it and en carry exactly the same keys", () => {
    const it = Object.keys(page["it"] ?? {}).sort();
    const en = Object.keys(page["en"] ?? {}).sort();
    expect(it.length).toBeGreaterThan(50);
    expect(en).toEqual(it);
    for (const key of it) {
      expect(page["it"]![key]!.length).toBeGreaterThan(0);
      expect(page["en"]![key]!.length).toBeGreaterThan(0);
    }
  });

  test("every key the markup and the script ask for is in the catalogue", () => {
    const used = new Set<string>();
    for (const m of html.matchAll(/\b(?:t|tf)\("([^"]+)"/g)) used.add(m[1]!);
    for (const m of html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g))
      used.add(m[1]!);
    used.add("msg.cut"); // the one string CSS shows (content: "  ✂ " var(--cut))
    expect(used.size).toBeGreaterThan(40);
    for (const key of used) {
      expect(page["it"]![key], `it is missing "${key}"`).toBeDefined();
      expect(page["en"]![key], `en is missing "${key}"`).toBeDefined();
    }
  });
});
