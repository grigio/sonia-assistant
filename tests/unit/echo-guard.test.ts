/**
 * `src/harness/echo-guard.ts`: the assistant hearing its own TTS through a leaky echo
 * canceller must not barge in nor become a user turn, while a real interruption still does.
 */
import { describe, expect, test } from "bun:test";
import { contentOverlap, EchoGuard, isHallucination } from "../../src/harness/echo-guard";

const STORY =
  "Liesel found an old book in a forgotten chapel, its pages glowing faintly with ink " +
  "that moved on its own. As she read, the words whispered secrets of forgotten empires " +
  "and rivers that flowed backward.";

function guardWith(text: string, t = 100): EchoGuard {
  const g = new EchoGuard();
  g.noteSpoken(text, t);
  g.noteAudible(t + 5);
  return g;
}

describe("echo verdict", () => {
  test("a fragment of what was just said is echo", () => {
    const g = guardWith(STORY);
    const v = g.verdict("the words whispered secrets of forgotten empires", 106);
    expect(v.echo).toBe(true);
    expect(v.reason).toBe("overlap");
  });

  test("ASR slips on the echo still match (fuzzy words)", () => {
    const g = guardWith(STORY);
    expect(g.verdict("words whisperd secret of forgoten empire", 106).echo).toBe(true);
  });

  test("an ASR hallucination ('Subscribe.') inside the window is echo", () => {
    const g = guardWith(STORY);
    const v = g.verdict("Subscribe.", 106);
    expect(v.echo).toBe(true);
    expect(v.reason).toBe("asr-hallucination");
    expect(isHallucination("Thanks for watching!")).toBe(true);
    expect(isHallucination("what's the weather")).toBe(false);
  });

  test("short commands interrupt even when the assistant said the same word", () => {
    const g = guardWith("Don't stop now, wait for the end of the story.");
    expect(g.verdict("stop", 106).echo).toBe(false);
    expect(g.verdict("wait", 106).echo).toBe(false);
    expect(g.verdict("Sonia, stop.", 106).echo).toBe(false);
  });

  test("a new question with words the assistant never said is not echo", () => {
    const g = guardWith(STORY);
    // shares 'can', 'you', 'for', 'the', 'in' with any story — content words decide
    const v = g.verdict("Can you check for the weather in Lisbon?", 106);
    expect(v.echo).toBe(false);
    expect(g.verdict("Can you check", 106).echo).toBe(false);
  });

  test("the reply in progress counts too (extra text)", () => {
    const g = new EchoGuard();
    expect(g.verdict("rivers that flowed backward", 50, STORY).echo).toBe(true);
  });

  test("text older than the window is forgotten", () => {
    const g = new EchoGuard(20);
    g.noteSpoken(STORY, 0);
    g.noteSpoken("The bridge trembled as she stepped onto it.", 30);
    // the story stopped playing at 30 s (the next sentence began): 25 s ago at t=55
    expect(g.verdict("whispered secrets of forgotten empires", 55).echo).toBe(false);
    expect(g.verdict("the bridge trembled", 55).echo).toBe(true);
  });

  test("empty text is not echo (nothing to drop)", () => {
    expect(guardWith(STORY).verdict("", 106).echo).toBe(false);
  });
});

describe("echo window", () => {
  test("open while speaking and for 1.5 s after playback", () => {
    const g = new EchoGuard();
    g.noteAudible(10);
    expect(g.inWindow(10.2, true)).toBe(true);
    expect(g.inWindow(11.4, false)).toBe(true);
    expect(g.inWindow(11.6, false)).toBe(false);
  });

  test("never opened before anything was played", () => {
    expect(new EchoGuard().inWindow(5, false)).toBe(false);
  });
});

describe("contentOverlap", () => {
  test("only stopwords → all words decide", () => {
    expect(contentOverlap("and the", "and the cat")).toBe(1);
  });
  test("content words decide", () => {
    expect(contentOverlap("the weather in Lisbon", "the story in the forest")).toBe(0);
  });
});
