/** Shared SSE (`text/event-stream`) parsing: bytes → `data:` payload strings. */

/**
 * Async-iterate an SSE byte stream and yield the payload of every `data:` line.
 * Multi-line `data:` concatenation per the spec; `[DONE]` is yielded as-is.
 */
export async function* sseData(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  let buf = "";
  let dataLines: string[] = [];

  for await (const chunk of source) {
    buf += Buffer.from(chunk).toString("utf-8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line === "") {
        if (dataLines.length) {
          yield dataLines.join("\n");
          dataLines = [];
        }
        continue;
      }
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      // comments (`: …`) and other fields (event:, id:, retry:) are ignored
    }
  }
  if (dataLines.length) yield dataLines.join("\n");
}

/**
 * Line-at-a-time splitter for byte chunks (used where we hand-roll HTTP and
 * need raw lines, not spec-compliant SSE events — e.g. the ASR client).
 */
export class LineSplitter {
  private buf = "";
  push(chunk: Uint8Array): string[] {
    this.buf += Buffer.from(chunk).toString("utf-8");
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      lines.push(this.buf.slice(0, idx).replace(/\r$/, ""));
      this.buf = this.buf.slice(idx + 1);
    }
    return lines;
  }
  flush(): string[] {
    if (!this.buf) return [];
    const rest = this.buf;
    this.buf = "";
    return [rest];
  }
}
