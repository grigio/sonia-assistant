import { describe, expect, test } from "bun:test";
import { ThinkTagFilter, OPEN_TAGS, CLOSE_TAGS } from "../../src/clients/think";

const [OPEN, OPEN2] = OPEN_TAGS;
const [CLOSE, CLOSE2] = CLOSE_TAGS;

/** Feed every chunk, then flush: the full list of parts, in order. */
function run(chunks: string[]): { kind: string; text: string }[] {
  const f = new ThinkTagFilter();
  return [...chunks.flatMap((c) => f.feed(c)), ...f.flush()];
}

function text(chunks: string[]): string {
  return run(chunks)
    .filter((p) => p.kind === "text")
    .map((p) => p.text)
    .join("");
}

function reasoning(chunks: string[]): string {
  return run(chunks)
    .filter((p) => p.kind === "reasoning")
    .map((p) => p.text)
    .join("");
}

describe("ThinkTagFilter", () => {
  test("the recognised tags are the usual ones", () => {
    expect(OPEN.startsWith("<")).toBe(true);
    expect(CLOSE).toBe("<" + "/think>");
    expect(OPEN2).toBe("```think");
    expect(CLOSE2).toBe("```");
  });

  test("no tags at all → everything is answer text", () => {
    expect(text(["Ciao", ", come stai?"])).toBe("Ciao, come stai?");
    expect(run(["Ciao", ", come stai?"]).every((p) => p.kind === "text")).toBe(true);
  });

  test("a think block is pulled out of the answer", () => {
    const chunks = [OPEN, "calcolo a mente…", CLOSE, "Risposta: 39."];
    expect(run(chunks).map((p) => p.kind)).toEqual(["reasoning", "text"]);
    expect(reasoning(chunks)).toBe("calcolo a mente…");
    expect(text(chunks)).toBe("Risposta: 39.");
  });

  test("a tag split across chunks is still a tag", () => {
    const chunks = ["sto per ", "pensare…",      // text before the block
                    OPEN.slice(0, 2), OPEN.slice(2), "un momento", CLOSE,
                    "Risposta fin", "ale."];     // …and the answer after it
    expect(reasoning(chunks)).toBe("un momento");
    expect(text(chunks)).toBe("sto per pensare…Risposta finale.");
  });

  test("an unfinished opening tag is never emitted as text", () => {
    expect(run(["ciao <th"])).toEqual([{ kind: "text", text: "ciao " }]);
    // …and it is picked up by the next chunk
    expect(run(["ciao <th", "ink> pensa…", CLOSE])).toEqual([
      { kind: "text", text: "ciao " },
      { kind: "reasoning", text: " pensa…" },
    ]);
  });

  test("markdown fences work too", () => {
    const chunks = [OPEN2, "sto per rispondere", CLOSE2, "Ciao!"];
    expect(reasoning(chunks)).toBe("sto per rispondere");
    expect(text(chunks)).toBe("Ciao!");
  });

  test("text before the opening tag stays text", () => {
    expect(text(["Ecco: ", OPEN, "…", CLOSE, "fatto"])).toBe("Ecco: fatto");
  });

  test("an unclosed tag means reasoning runs to the end of the stream", () => {
    const chunks = [OPEN, "ancora in dubbio"];
    expect(reasoning(chunks)).toBe("ancora in dubbio");
    expect(text(chunks)).toBe("");
    expect(run(chunks).every((p) => p.kind === "reasoning")).toBe(true);
  });

  test("flush drops an unfinished tag", () => {
    const f = new ThinkTagFilter();
    const out = [...f.feed("Risposta <"), ...f.flush()];
    expect(out).toEqual([{ kind: "text", text: "Risposta " }]);
  });

  test("empty feed/flush are no-ops", () => {
    const f = new ThinkTagFilter();
    expect(f.feed("")).toEqual([]);
    expect(f.flush()).toEqual([]);
    expect(f.thinking).toBe(false);
  });
});
