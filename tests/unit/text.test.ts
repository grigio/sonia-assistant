/**
 * `src/harness/text.ts` — the word helpers every turn rule is written in:
 * extraction (Unicode, not `\w`), backchannels, yes/no and the echo ratio that
 * separates "the assistant hears itself" from "the user is interrupting".
 */
import { describe, expect, test } from "bun:test";
import {
  BACKCHANNELS,
  YES_WORDS,
  NO_WORDS,
  classifyYesNo,
  echoRatio,
  hasWords,
  isBackchannel,
  words,
} from "../../src/harness/text";

describe("words / hasWords", () => {
  test("lowercases, splits on punctuation and keeps accents (\\p{L}, not \\w)", () => {
    expect(words("Ciao, Ettore! Come stai?")).toEqual(["ciao", "ettore", "come", "stai"]);
    // ASCII \w would drop every accented letter — the whole Italian vocabulary
    expect(words("perché, giù, ANNI, è")).toEqual(["perché", "giù", "anni", "è"]);
  });

  test("words() resets the shared regex: two calls must not continue each other", () => {
    expect(words("uno due")).toEqual(["uno", "due"]);
    expect(words("tre")).toEqual(["tre"]);
  });

  test("hasWords is any letter/digit/apostrophe — a number counts, pure punctuation does not", () => {
    expect(hasWords("2:30")).toBe(true);
    expect(hasWords("l'ora")).toBe(true);
    expect(hasWords("  …  ")).toBe(false);
    expect(hasWords("")).toBe(false);
    expect(hasWords("---")).toBe(false);
  });
});

describe("backchannels", () => {
  test("one to three filler words are a backchannel", () => {
    for (const s of ["mhm", "sì", "certo", "ok right", "mh sì esatto"]) {
      expect(isBackchannel(s)).toBe(true);
    }
  });

  test("a fourth word (or anything not in the list) makes it real speech", () => {
    expect(isBackchannel("mhm sì certo va")).toBe(false);
    expect(isBackchannel("ferma un attimo")).toBe(false);
    expect(isBackchannel("")).toBe(false);
  });

  test("the catalogue covers both languages", () => {
    expect(BACKCHANNELS.has("capito")).toBe(true);
    expect(BACKCHANNELS.has("uh-huh")).toBe(true);
  });
});

describe("classifyYesNo", () => {
  test("no wins over yes when both appear («sì, no, annulla» is a no)", () => {
    expect(classifyYesNo("sì")).toBe("yes");
    expect(classifyYesNo("certo, fallo")).toBe("yes");
    expect(classifyYesNo("no")).toBe("no");
    expect(classifyYesNo("sì, annulla")).toBe("no");
  });

  test("too long, empty or neutral → null (never guess on a sentence)", () => {
    expect(classifyYesNo("")).toBeNull();
    expect(classifyYesNo("come stai oggi")).toBeNull();
    // > 6 words is a reply, not an answer to "may I run it?"
    expect(classifyYesNo("sì vai avanti pure fallo adesso grazie")).toBeNull();
  });

  test("the yes/no vocabularies are what the approval prompt relies on", () => {
    expect(YES_WORDS.has("autorizzo")).toBe(true);
    expect(NO_WORDS.has("ferma")).toBe(true);
  });
});

describe("echoRatio", () => {
  const spoken = "questo è il testo che l'assistente sta dicendo adesso";

  test("the assistant's own words come back at 1.0 (echo), a new sentence near 0", () => {
    expect(echoRatio(spoken, spoken)).toBe(1.0);
    expect(echoRatio("il testo che l'assistente sta dicendo", spoken)).toBeGreaterThan(0.6);
    expect(echoRatio("ferma subito non parlare", spoken)).toBe(0);
  });

  test("an empty transcript is treated as total echo: never an interruption", () => {
    expect(echoRatio("", spoken)).toBe(1.0);
  });

  test("the ratio is of *heard* words found in *spoken*: shorter echoes rank higher", () => {
    expect(echoRatio("dicendo adesso", spoken)).toBe(1.0);
  });
});
