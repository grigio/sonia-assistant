/**
 * Split streamed assistant text into *reasoning* and *answer* parts.
 *
 * Two shapes exist in the wild:
 *
 *  * a separate `reasoning_content` field per delta (llama-server, DeepSeek-style) — the
 *    caller reads it directly and never reaches this filter;
 *  * inline think tags inside `content` (a "think" block, or a markdown fence opened
 *    with three backticks + "think") — those would otherwise be spoken aloud by the TTS,
 *    so this filter pulls them out.
 *
 * A tag boundary can fall anywhere between two chunks (the opening tag split in half),
 * so the unfinished tail stays buffered instead of being emitted.
 */

export type ThinkPart = { kind: "reasoning" | "text"; text: string };

/** "<" as a variable: keeps the tag literals out of the source (docs/tools mangle them). */
const LT = "<";

/** Opening / closing tags we recognise: whichever comes first in the stream wins.
 *  Written as concatenations, not template literals, on purpose: `as const` keeps these
 *  literal types, which the tests assert against. */
export const OPEN_TAGS = [LT + "think>", "```think"] as const;
export const CLOSE_TAGS = [LT + "/think>", "```"] as const;

/** Longest suffix of `s` that is a *proper* prefix of one of `tags` (0 if none). */
export function partialTagSuffix(s: string, tags: readonly string[]): number {
  let hold = 0;
  for (const tag of tags) {
    for (let n = tag.length - 1; n > 0; n--) {
      if (s.endsWith(tag.slice(0, n))) {
        hold = Math.max(hold, n);
        break; // a longer prefix of the same tag cannot match either
      }
    }
  }
  return hold;
}

/** Index of the earliest complete occurrence of any tag, or -1. */
function firstIndex(s: string, tags: readonly string[]): number {
  let best = -1;
  for (const tag of tags) {
    const i = s.indexOf(tag);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

export class ThinkTagFilter {
  private buf = "";
  private inThink = false;

  /** Feed one chunk; returns the parts that are complete (the tail stays buffered). */
  feed(chunk: string): ThinkPart[] {
    if (chunk) this.buf += chunk;
    const out: ThinkPart[] = [];
    for (;;) {
      const tags = this.inThink ? CLOSE_TAGS : OPEN_TAGS;
      const kind: ThinkPart["kind"] = this.inThink ? "reasoning" : "text";
      const i = firstIndex(this.buf, tags);
      if (i < 0) {
        // no tag (or only the beginning of one): emit all but the unfinished tail
        const cut = this.buf.length - partialTagSuffix(this.buf, tags);
        if (cut > 0) {
          out.push({ kind, text: this.buf.slice(0, cut) });
          this.buf = this.buf.slice(cut);
        }
        return out;
      }
      if (i > 0) out.push({ kind, text: this.buf.slice(0, i) });
      const used = tags.find((t) => this.buf.startsWith(t, i));
      if (used === undefined) return out; // unreachable: firstIndex found one here
      this.buf = this.buf.slice(i + used.length);
      this.inThink = !this.inThink;
    }
  }

  /** End of stream: flush what is left (an unclosed tag is reasoning to the end). */
  flush(): ThinkPart[] {
    if (!this.buf) return [];
    const kind: ThinkPart["kind"] = this.inThink ? "reasoning" : "text";
    const tags = this.inThink ? CLOSE_TAGS : OPEN_TAGS;
    const cut = this.buf.length - partialTagSuffix(this.buf, tags);
    const text = cut > 0 ? this.buf.slice(0, cut) : "";
    this.buf = "";
    return text ? [{ kind, text }] : [];
  }

  get thinking(): boolean {
    return this.inThink;
  }
}
