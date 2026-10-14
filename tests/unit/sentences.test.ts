/**
 * `src/harness/sentences.ts` — the splitter between the LLM's stream and the TTS:
 * what the user hears first is whatever this decides is one speakable chunk.
 */
import { describe, expect, test } from "bun:test";
import { SentenceSplitter } from "../../src/harness/sentences";

const feedAll = (s: SentenceSplitter, text: string): string[] => s.feed(text);

describe("SentenceSplitter.feed", () => {
  test("cuts on . ! ? … ; : and keeps the punctuation", () => {
    const s = new SentenceSplitter();
    expect(feedAll(s, "Ciao. Come stai? ")).toEqual(["Ciao.", "Come stai?"]);
    expect(s.flush()).toEqual([]); // nothing left over
  });

  test("a sentence with nothing after its period waits: the model may still be typing", () => {
    const s = new SentenceSplitter();
    expect(s.feed("Ciao.")).toEqual([]); // no space yet → hold it
    expect(s.feed(" Va")).toEqual(["Ciao."]);
    expect(s.flush()).toEqual(["Va"]);
  });

  test("flush() hands back the tail so a turn never ends with text unspoken", () => {
    const s = new SentenceSplitter();
    expect(s.feed("l'ultima frase senza punto")).toEqual([]);
    expect(s.flush()).toEqual(["l'ultima frase senza punto"]);
    expect(s.flush()).toEqual([]); // second flush is empty, not a repeat
  });

  test("a newline always cuts — markdown lists and paragraphs", () => {
    const s = new SentenceSplitter();
    expect(feedAll(s, "riga uno\nriga due")).toEqual(["riga uno"]);
    expect(s.flush()).toEqual(["riga due"]);
  });

  test("the FIRST sentence is cut early on a comma: something to say within ~40 chars", () => {
    const s = new SentenceSplitter();
    const out = feedAll(
      s,
      "Questa è una frase abbastanza lunga, che continua qui e non finisce mai",
    );
    expect(out[0]).toBe("Questa è una frase abbastanza lunga,");
    expect(s.flush()[0]?.startsWith("che continua")).toBe(true);
  });

  test("later text waits for 220 chars before cutting on a comma (the first-sentence rule is over)", () => {
    const s = new SentenceSplitter();
    expect(s.feed("Prima frase. ")).toEqual(["Prima frase."]); // one piece already: `first` is spent
    const long = "una frase lunghissima senza punti, ".repeat(10); // comma at 135, 340 chars
    const out = s.feed(long);
    expect(out).toHaveLength(1);
    expect(out[0]!.endsWith(",")).toBe(true);
    expect(out[0]!.length).toBeGreaterThan(120); // the comma at ≥120, not the one at 33
    expect(s.flush()[0]).toContain("senza punti");
  });

  test("pieces that carry no word (a separator line, a lone emoji) are dropped", () => {
    const s = new SentenceSplitter();
    expect(feedAll(s, "---\nvia")).toEqual([]); // `---` alone: no word
    expect(s.flush()).toEqual(["via"]);
  });
});

describe("SentenceSplitter.clean", () => {
  test("strips markdown emphasis, headings and quotes", () => {
    expect(SentenceSplitter.clean("**grassetto** e _corsivo_")).toBe("grassetto e corsivo");
    expect(SentenceSplitter.clean("## titolo")).toBe("titolo");
    expect(SentenceSplitter.clean("`codice` > citazione")).toBe("codice citazione");
  });

  test("keeps the link text, drops the URL", () => {
    expect(SentenceSplitter.clean("leggi [il post](https://esempio.it/x)")).toBe("leggi il post");
  });

  test("drops emoji and collapses whitespace", () => {
    expect(SentenceSplitter.clean("ciao 🎉  mondo   !")).toBe("ciao mondo !");
  });
});
