/**
 * `src/harness/barge-in.ts` — what happens when the user talks over the assistant:
 * cancel on a real interruption, keep playing on a backchannel or on the assistant's
 * own echo coming back through the speakers.
 */
import { describe, expect, test } from "bun:test";
import { Config } from "../../src/config";
import { bargeInterrupts, bargeVerdict } from "../../src/harness/barge-in";

const cfg = new Config();
const SPOKEN = "questo è il testo che l'assistente sta dicendo in questo momento";
const ECHO = "testo che l'assistente sta dicendo"; // every word it just said
const NEW = "fermati adesso per favore"; // none of them

describe("bargeInterrupts (cancel right away, mid-sentence)", () => {
  test("three or more real words that are not the echo → interrupt", () => {
    expect(bargeInterrupts(NEW, SPOKEN, cfg)).toBe(true);
  });

  test("fewer than BARGE_CONFIRM_WORDS real words → not yet (a stray word, a cough)", () => {
    expect(bargeInterrupts("fermati", SPOKEN, cfg)).toBe(false);
    expect(bargeInterrupts("sì ok fermati", SPOKEN, cfg)).toBe(false); // 1 real + 2 filler
  });

  test("backchannels never count towards the three", () => {
    expect(bargeInterrupts("mhm sì ok certo", SPOKEN, cfg)).toBe(false);
  });

  test("the assistant hearing itself is not an interruption", () => {
    expect(bargeInterrupts(ECHO, SPOKEN, cfg)).toBe(false);
  });

  test("BARGE_CONFIRM_WORDS is what the sensitivity rides on", () => {
    const strict = Object.assign(new Config(), { bargeConfirmWords: 1 });
    expect(bargeInterrupts("fermati", SPOKEN, strict)).toBe(true);
    expect(bargeInterrupts(NEW, SPOKEN, strict)).toBe(true);
  });
});

describe("bargeVerdict (at the turn end of a turn that was talking over us)", () => {
  test("nothing heard → resume (the pause was ours, not a cancellation)", () => {
    expect(bargeVerdict("", SPOKEN, cfg)).toBe("resume-backchannel");
  });

  test("a backchannel → resume", () => {
    expect(bargeVerdict("mhm", SPOKEN, cfg)).toBe("resume-backchannel");
    expect(bargeVerdict("sì certo", SPOKEN, cfg)).toBe("resume-backchannel");
  });

  test("an echo of what was said → resume as an echo (logged differently)", () => {
    expect(bargeVerdict(ECHO, SPOKEN, cfg)).toBe("resume-echo");
  });

  test("real new speech → interrupt: the reply is cancelled, the part said stays in history", () => {
    expect(bargeVerdict(NEW, SPOKEN, cfg)).toBe("interrupt");
    expect(bargeVerdict("no non finire adesso", SPOKEN, cfg)).toBe("interrupt");
  });

  test("ECHO_OVERLAP is the dial: a stricter one calls a partial echo an interruption", () => {
    const partial = "testo che sta adesso"; // 3 of its 4 words were just said → 0.75
    expect(bargeVerdict(partial, SPOKEN, cfg)).toBe("resume-echo"); // 0.75 ≥ 0.6
    const strict = Object.assign(new Config(), { echoOverlap: 0.95 });
    expect(bargeVerdict(partial, SPOKEN, strict)).toBe("interrupt"); // 0.75 < 0.95
  });
});
