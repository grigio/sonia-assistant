/**
 * Tool-call markup must never reach the TTS.
 *
 * A model with no native tool to call writes it as plain content instead:
 *
 *   17:37:57 🤖 <toolcall <function=runcommand <parameter=command ls -la /sys/… </parameter
 *        <parameter=reason Check RAM details </parameter </function </toolcall
 *
 * Read aloud that is nonsense — and worse, the mic hears that speech and ASR recognises
 * it as a *user* turn, so the markup lands in the chat as the user's own words.
 *
 * `ToolMarkupFilter` drops it on the way to the sentence splitter (whitespace left
 * behind is the splitter's business: `SentenceSplitter.clean()` collapses it).
 */
import { describe, expect, test } from "bun:test";
import { ToolMarkupFilter, TOOL_OPEN, TOOL_CLOSE } from "../../src/clients/toolmarkup";

const LT = "<";

/** Feed every chunk, then flush: the text that survives. */
function run(chunks: string[]): string {
  const f = new ToolMarkupFilter();
  return chunks.map((c) => f.feed(c)).join("") + f.flush();
}

/** What a surviving text looks like once the speech pipeline has normalised it. */
function spoken(chunks: string[]): string {
  return run(chunks).replace(/\s+/g, " ").trim();
}

/** The markup the live model wrote (data/logs/restart.log, 17:37:57), verbatim but for "<". */
const OBSERVED =
  LT + "toolcall " + LT + "function=runcommand " + LT + "parameter=command " +
  "ls -la /sys/devices/system/memory/memory188/ " + LT + "/parameter " +
  LT + "parameter=reason Check RAM details " + LT + "/parameter " +
  LT + "/function " + LT + "/toolcall";

describe("ToolMarkupFilter", () => {
  test("the recognised tags are the tool-call ones", () => {
    expect(TOOL_OPEN).toContain(LT + "toolcall");
    expect(TOOL_CLOSE).toContain(LT + "/toolcall");
    expect(TOOL_OPEN.some((t) => t.startsWith(LT + "function"))).toBe(true);
  });

  test("plain text passes untouched", () => {
    expect(run(["Le tue RAM ", "sono a 9600 MT/s."])).toBe("Le tue RAM sono a 9600 MT/s.");
    const f = new ToolMarkupFilter();
    expect(f.feed("")).toBe("");
    expect(f.flush()).toBe("");
    expect(f.seen).toBe(false);
  });

  test("the markup the model actually wrote is dropped whole", () => {
    expect(spoken([OBSERVED])).toBe("");
    const f = new ToolMarkupFilter();
    f.feed(OBSERVED);
    f.flush();
    expect(f.seen).toBe(true);
    expect(f.droppedChars).toBe(OBSERVED.length);
  });

  test("the same block split at every possible boundary is still dropped", () => {
    for (let i = 1; i < OBSERVED.length; i++) {
      expect(spoken([OBSERVED.slice(0, i), OBSERVED.slice(i)])).toBe("");
    }
  });

  test("text before and after a block survives", () => {
    expect(spoken(["Ho controllato: ", OBSERVED, "Le RAM sono a 9600 MT/s."])).toBe(
      "Ho controllato: Le RAM sono a 9600 MT/s.",
    );
    // …and the very same filter keeps passing text after swallowing a block
    const f = new ToolMarkupFilter();
    const said = f.feed("Ho controllato: " + OBSERVED + " Le RAM sono a 9600 MT/s.");
    expect(said.replace(/\s+/g, " ")).toBe("Ho controllato: Le RAM sono a 9600 MT/s.");
    expect(f.seen).toBe(true);
    expect(f.feed(" Niente di più.")).toBe(" Niente di più.");
    expect(f.flush()).toBe("");
  });

  test("an unclosed block is dropped to the end of the stream", () => {
    expect(run(["Proseguo: " + LT + "toolcall " + LT + "function=runcommand ls"])).toBe(
      "Proseguo: ",
    );
    const f = new ToolMarkupFilter();
    expect(f.feed("Risposta " + LT + "toolcall")).toBe("Risposta ");
    expect(f.flush()).toBe("");
    expect(f.seen).toBe(true);
  });

  test("an unfinished tag is never emitted, and is caught by the next chunk", () => {
    const f = new ToolMarkupFilter();
    expect(f.feed("Parlavo " + LT + "func")).toBe("Parlavo ");
    expect(f.feed("tion=run_command ls" + LT + "/function> e poi finisco.")).toBe(
      " e poi finisco.",
    );
  });

  test("a stray closer outside a block is dropped too", () => {
    expect(spoken(["Va bene " + LT + "/function " + LT + "/toolcall, arrivederci."])).toBe(
      "Va bene , arrivederci.",
    );
  });

  test("the <|tool_call|> style is recognised as well", () => {
    const qwen = LT + "|tool_call|>get_datetime" + LT + "|/tool_call|>";
    expect(spoken(["Ora " + qwen + " sono le sedici."])).toBe("Ora sono le sedici.");
  });

  test("reset() puts the filter back to a clean sheet", () => {
    const f = new ToolMarkupFilter();
    f.feed(LT + "toolcall " + LT + "function=x");
    f.reset();
    expect(f.seen).toBe(false);
    expect(f.droppedChars).toBe(0);
    expect(f.feed("Tutto qui.")).toBe("Tutto qui.");
    expect(f.flush()).toBe("");
  });
});
