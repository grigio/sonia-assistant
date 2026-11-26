/**
 * The "[interrupted by the user]" history marker must not teach the model to write it:
 * it is hidden from the model's view of its own turns (a note goes on the next user
 * message instead) and stripped from anything the model says or speaks.
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, StreamItem } from "../../src/clients/llm";
import { Config } from "../../src/config";
import { Assistant } from "../../src/harness/assistant";
import { hasInterruptMarker, stripInterruptMarkers } from "../../src/harness/text";
import { Tools } from "../../src/tools";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function scripted(replies: string[]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fd-marker-"));
  dirs.push(tmp);
  const cfg = Config.fromEnv();
  cfg.llmEnableTools = true;
  cfg.llmViaPi = false;
  cfg.toolGate = false;
  cfg.locale = "en";
  const a = new Assistant(cfg, null, "null");
  a.log = () => {};
  a.tools = new Tools({
    dataDir: path.join(tmp, "data"),
    announce: () => {},
    cmdMode: "off",
    history: () => a.history,
  });
  const spoken: string[] = [];
  const requests: ChatMessage[][] = [];
  a.emit = () => {};
  const stub = a as unknown as { llm: unknown; tts: unknown; player: unknown };
  stub.llm = {
    stream: async function* (messages: ChatMessage[]): AsyncGenerator<StreamItem> {
      requests.push(structuredClone(messages));
      const text = replies.shift();
      if (text) yield { kind: "text", text };
    },
    resetSession: () => {},
  };
  stub.tts = { stream: async function* (): AsyncGenerator<Uint8Array> {} };
  stub.player = {
    busy: false,
    paused: false,
    audible: false,
    flush: () => {},
    beginSegment: (s: string) => spoken.push(s),
    endSegment: () => {},
    enqueue: () => {},
  };
  return { a, spoken, requests };
}

async function turn(a: Assistant, text: string): Promise<void> {
  a.startResponse(text, Date.now());
  await a.resp?.task;
}

describe("interruption marker helpers", () => {
  test("stripped in both locales, with the leading ellipsis", () => {
    expect(stripInterruptMarkers("I'll check the weather. … [interrupted by the user]")).toBe(
      "I'll check the weather.",
    );
    expect(stripInterruptMarkers("Ecco. … [interrotto dall'utente]")).toBe("Ecco.");
    expect(stripInterruptMarkers("[interrupted by the user before speaking]")).toBe("");
    expect(stripInterruptMarkers("A normal [bracketed] sentence.")).toBe(
      "A normal [bracketed] sentence.",
    );
    expect(hasInterruptMarker("fine")).toBe(false);
  });
});

describe("interruption marker in a turn", () => {
  test("a marker the model writes is never spoken nor kept", async () => {
    const { a, spoken } = scripted(["Sure, here you go. [interrupted by the user]"]);
    await turn(a, "tell me a story");
    expect(spoken.join(" ")).toContain("here you go");
    expect(spoken.join(" ")).not.toContain("interrupted");
    expect(JSON.stringify(a.history)).not.toContain("interrupted");
  });

  test("the model never sees the marker in its own earlier turn; the next user message carries a note", async () => {
    const { a, requests } = scripted(["Ok."]);
    a.history.push(
      { role: "user", content: "tell me a story" },
      { role: "assistant", content: "Once upon a time … [interrupted by the user]" },
    );
    await turn(a, "never mind");
    const sent = requests[0] ?? [];
    expect(JSON.stringify(sent)).not.toContain("[interrupted");
    const last = sent[sent.length - 1];
    expect(String(last?.content)).toContain("interrupted your previous reply");
    expect(String(last?.content)).toContain("never mind");
    // the stored history keeps the marker (the UI shows it)
    expect(JSON.stringify(a.history)).toContain("[interrupted by the user]");
  });
});
