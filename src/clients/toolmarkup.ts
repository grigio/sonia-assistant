/**
 * Pull *tool-call markup* out of the streamed assistant text.
 *
 * A model that cannot (or was not offered the means to) call a tool natively writes its
 * call as plain content instead — typically when the turn has spent its rounds of
 * function calling and the last request carries no `tools` at all:
 *
 *   <toolcall <function=runcommand <parameter=command ls -la /sys/… </parameter
 *   <parameter=reason Check RAM details </parameter </function </toolcall
 *
 * That is a tool call, not an answer. Left in the text it is (1) read aloud by the TTS —
 * and the mic then hears that speech and recognises it as a *user* turn, so the markup
 * shows up as the user's own words — and (2) stored in the history as the assistant's
 * reply. This filter drops it on the way to the splitter, and reports it so the log can
 * say what happened.
 *
 * Like `ThinkTagFilter`, a tag can be split across two chunks: an unfinished tail is
 * held back instead of being emitted.
 */

import { partialTagSuffix } from "./think";

/** "<" as a variable: keeps the tag literals out of the source (docs/tools mangle them). */
const LT = "<";

/** What opens a markup block: whichever comes first in the stream wins. */
export const TOOL_OPEN = [
  `${LT}toolcall>`,
  `${LT}toolcall`,
  `${LT}function=`,
  `${LT}parameter=`,
  `${LT}|tool_call|>`,
  `${LT}|tool_calls|>`,
  `${LT}|tool_args|>`,
  `${LT}|tool_result|>`,
] as const;

/** What closes it (the `>`-less forms too: a model emits fragments, not tags). */
export const TOOL_CLOSE = [
  `${LT}/toolcall>`,
  `${LT}/toolcall`,
  `${LT}/function>`,
  `${LT}/function`,
  `${LT}/parameter>`,
  `${LT}/parameter`,
  `${LT}|/tool_call|>`,
  `${LT}|/tool_args|>`,
] as const;

/** Outside a block a stray closer is dropped too (a call split into several fragments). */
const ANY_TAG: readonly string[] = [...TOOL_OPEN, ...TOOL_CLOSE];

/** Index of the earliest complete occurrence of any tag, or -1. */
function firstIndex(s: string, tags: readonly string[]): number {
  let best = -1;
  for (const tag of tags) {
    const i = s.indexOf(tag);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

export class ToolMarkupFilter {
  private buf = "";
  private inMarkup = false;
  private dropped = 0;

  /** Feed one chunk; returns the part of it that is real text (the tail stays buffered). */
  feed(chunk: string): string {
    if (chunk) this.buf += chunk;
    let out = "";
    for (;;) {
      const tags = this.inMarkup ? TOOL_CLOSE : ANY_TAG;
      const i = firstIndex(this.buf, tags);
      if (i < 0) {
        // no tag (or only the beginning of one): pass the text, hold the unfinished tail
        const cut = this.buf.length - partialTagSuffix(this.buf, tags);
        if (cut > 0) {
          // inside a block the tail is markup to swallow, not text to speak
          if (this.inMarkup) this.dropped += cut;
          else out += this.buf.slice(0, cut);
          this.buf = this.buf.slice(cut);
        }
        return out;
      }
      if (!this.inMarkup) out += this.buf.slice(0, i); // text before the block stays
      const used = tags.find((t) => this.buf.startsWith(t, i))!;
      this.dropped += i + used.length;
      this.buf = this.buf.slice(i + used.length);
      // a closer outside a block is simply dropped; only an opener starts a block
      this.inMarkup = this.inMarkup ? false : (TOOL_OPEN as readonly string[]).includes(used);
    }
  }

  /** End of the response: an unclosed block is dropped, a held tail is text. */
  flush(): string {
    const held = this.buf;
    this.buf = "";
    if (this.inMarkup) {
      this.dropped += held.length;
      this.inMarkup = false;
      return "";
    }
    return held;
  }

  /** True once any markup has been dropped from this response. */
  get seen(): boolean {
    return this.dropped > 0;
  }

  /** How many characters of markup this response swallowed (for the log line). */
  get droppedChars(): number {
    return this.dropped;
  }

  /** Back to a clean sheet (used when the filter is reused across turns). */
  reset(): void {
    this.buf = "";
    this.inMarkup = false;
    this.dropped = 0;
  }
}
