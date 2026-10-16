/**
 * The context meter behind the bar next to the title: *tokens used* / *n_ctx*.
 *
 * Two numbers, two sources — both must be cheap and, above all, side-effect free:
 *
 *  * **total** comes from the model lists we already fetch (`GET /v1/models` for the API
 *    leg, `pi --list-models` for the pi leg), never from llama-server's `/props?model=…`,
 *    which *loads the model* it is asked about (and, with `max_instances=1`, evicts the
 *    one that is running). `LLM_CONTEXT_WINDOW` overrides both when neither says.
 *  * **used** is `prompt + completion` of the last streamed request — exactly what that
 *    request put in the KV cache, i.e. what the next prompt has to fit into.
 *
 * When `total` is unknown (0) the UI hides the bar: a bar without a denominator is a lie.
 */

/**
 * The size the history may reach before the oldest turn is shed (`Assistant.fitHistory`).
 *
 * `total` is n_ctx; `charsPerToken` is the ratio the *last real request* measured (its
 * history size against the `prompt_tokens` the server reported), so a session full of
 * shell output is budgeted by the tokenizer that reads it rather than by a guess.
 *
 * A `total` of 0 (no model list ever reported n_ctx, `LLM_CONTEXT_WINDOW` unset) used to
 * disable trimming altogether — the history then grew until the server refused the
 * request. There it is the *smallest* window we could be talking to that is assumed
 * (8k), which is the safe direction to be wrong in.
 *
 * 4k tokens are kept free on top of it for the system prompt and for the reply
 * (`max_tokens` + the reasoning budget), and the result never drops below
 * `CTX_MIN_BUDGET_CHARS` — a floor so a tiny window still keeps the last exchanges.
 */
export function historyBudget(total: number, charsPerToken: number = CHARS_PER_TOKEN): number {
  const window = total > 0 ? total : CTX_ASSUMED_WINDOW;
  return Math.max(CTX_MIN_BUDGET_CHARS, (window - CTX_RESERVE_TOKENS) * charsPerToken);
}

/** n_ctx assumed while no model list reports one: the smallest window we could have. */
export const CTX_ASSUMED_WINDOW = 8192;
/** Tokens kept free for the system prompt + the reply (max_tokens and the thinking budget). */
export const CTX_RESERVE_TOKENS = 4000;
/** The history never shrinks below this: the last exchanges are worth more than the fit. */
export const CTX_MIN_BUDGET_CHARS = 6000;
/** Chars/token of Italian prose + shell output, until a real request measures better. */
export const CHARS_PER_TOKEN = 3;

/**
 * The measured chars/token, clamped: one odd request (a prompt that is mostly the system
 * prompt, a burst of non-Latin text) must not size the budget of every later turn.
 * Falls back to `CHARS_PER_TOKEN` when nothing has been measured yet.
 */
export function estimateCharsPerToken(chars: number, tokens: number): number {
  if (!Number.isFinite(chars) || !Number.isFinite(tokens)) return CHARS_PER_TOKEN;
  if (chars <= 0 || tokens <= 0) return CHARS_PER_TOKEN;
  return Math.min(6, Math.max(1.5, chars / tokens));
}

/** What the `/ws` protocol carries for the meter. */
export type ContextState = { used: number; total: number };

/**
 * `pi --list-models` → `{ "provider/id": context window }`.
 * The `context` column is what pi displays: `32768`, `32.8K`, `1M`.
 */
export function contextsFromPiList(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of piModelRows(text)) {
    if (row.context > 0) out[row.id] = row.context;
  }
  return out;
}

/** One `provider model context …` line of `pi --list-models`. */
export type PiModelRow = { id: string; context: number };

/** Rows of `pi --list-models`, header and non-size lines dropped. */
export function piModelRows(text: string): PiModelRow[] {
  const rows: PiModelRow[] = [];
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/).filter(Boolean);
    if (cols.length < 3 || cols[1] === "model" || !SIZE_RE.test(cols[2]!)) continue;
    const id = `${cols[0]}/${cols[1]}`;
    if (rows.some((r) => r.id === id)) continue;
    rows.push({ id, context: parseContextSize(cols[2]!) });
  }
  return rows;
}

/** The "context" column of `pi --list-models`: a plain number or a K/M/G suffix. */
const SIZE_RE = /^[\d.]+[KMGkmg]?$/;

/**
 * `"32768"` → 32768, `"32.8K"` → 32800, `"1M"` → 1000000.
 * K/M/G are powers of ten: that is how pi rounds them (`32768` is *displayed* as `32.8K`).
 */
export function parseContextSize(raw: string): number {
  const m = /^([\d.]+)\s*([KMGkmg]?)$/.exec(raw.trim());
  if (!m) return 0;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const scale = m[2] ? { K: 1e3, M: 1e6, G: 1e9 }[m[2]!.toUpperCase() as "K" | "M" | "G"] : 1;
  return Math.round(value * scale);
}

/**
 * llama-server's `GET /v1/models` → `{ model id (and aliases): n_ctx }`.
 * `meta.n_ctx` is present while the model is loaded, `--ctx-size` (in `status.args`) always
 * is — asking the list never loads anything, unlike `/props?model=…`.
 */
export function contextsFromServerModels(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    const m = raw as {
      id?: unknown;
      aliases?: unknown;
      meta?: { n_ctx?: unknown } | null;
      status?: { args?: unknown } | null;
    };
    const n = serverNCtx(m);
    if (n <= 0) continue;
    const ids = [m.id, ...(Array.isArray(m.aliases) ? m.aliases : [])].filter(
      (x): x is string => typeof x === "string" && x !== "",
    );
    for (const id of ids) out[id] = n;
  }
  return out;
}

/** n_ctx of one `/v1/models` entry: the live value first, the launch flag as it stands. */
function serverNCtx(m: {
  meta?: { n_ctx?: unknown } | null;
  status?: { args?: unknown } | null;
}): number {
  const live = m.meta?.n_ctx;
  if (typeof live === "number" && Number.isFinite(live) && live > 0) return Math.trunc(live);
  const args = m.status?.args;
  if (Array.isArray(args)) {
    const i = args.indexOf("--ctx-size");
    if (i >= 0 && typeof args[i + 1] === "string") return parseContextSize(args[i + 1]!);
  }
  return 0;
}
