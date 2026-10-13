/**
 * Server-side localization: every string that reaches the user (the chat's own lines,
 * the event lines under it, the spoken sentences, a tool's result — the tool card shows
 * it too) lives in one catalogue per locale, picked by `LOCALE` in `.env`.
 *
 *   LOCALE=it  →  Italian (default, the language the whole app was written in)
 *   LOCALE=en  →  English
 *
 * A key exists once per catalogue and `en` is typed against `it`, so a translation can
 * never go missing: adding a key to `it` is a compile error until `en` has it too.
 *
 * The browser front-end has its own catalogue (static/index.html, `UI_STRINGS`): it runs
 * before the WebSocket is up, so it cannot fetch these. Keep the wording in step by hand.
 *
 * `LOCALE` is the *UI's* language — the assistant's own voice mirrors the user instead
 * (LANGUAGE RULE in prompts/system.txt), so anything the user hears later and out of the
 * blue (a timer ringing) picks the language of the request that scheduled it:
 * `detectLocale` reads it off the user's own words.
 */

export type Locale = "it" | "en";

/** How an approval was resolved: the chat shows it in the user's language, the log
 *  always in English (logs never switch language — see tests/unit/logs-english.test.ts). */
export type ViaKey = "via.click" | "via.unclear" | "via.cleaned" | "via.rewound";

export const LOCALES: Locale[] = ["it", "en"];
export const DEFAULT_LOCALE: Locale = "it";

const it = {
  // ── chat lines (info under a user message) ──
  "user.replyConfirm": "risposta alla conferma",
  "user.typed": "testo digitato",
  "user.turnEnd": "fine turno: {reason} · pausa {gap} ms · ASR {asr} ms",

  // ── event lines (the dim lines between the bubbles) ──
  "evt.bargePause": "⏸ in pausa: l'utente parla",
  "evt.keepListening": "… l'LLM dice: continuo ad ascoltare",
  "evt.interrupted": "✋ interrotto dall'utente",
  "evt.resume": "▶ riprendo ({what}: «{text}»)",
  "evt.echo": "eco",
  "evt.backchannel": "assenso",
  "evt.cmdApproved": "✅ comando autorizzato",
  "evt.cmdDenied": "❌ comando rifiutato",

  // ── how an approval was resolved (in parentheses after the line above) ──
  "via.click": "clic",
  "via.unclear": "risposta non chiara",
  "via.cleaned": "chat pulita",
  "via.rewound": "conversazione riavvolta",

  // ── spoken by the TTS voice / shown as a 🔔 announcement ──
  "spoken.approveCommand": "Posso eseguire il comando che vedi sullo schermo? Dimmi sì o no.",
  /** Last resort of a turn in which the model produced no text at all (see runResponse). */
  "spoken.noAnswer":
    "Scusa, non sono riuscito a concludere la risposta: puoi ripetermi la domanda?",
  "announce.timerExpired": "Il {label} è scaduto.",

  // ── history notes (kept in the conversation, shown again after a reload) ──
  "hist.interrupted": "[interrotto dall'utente]",
  "hist.interruptedQuiet": "[interrotto dall'utente prima di parlare]",

  // ── prompt fragments ──
  "gated.tool":
    "Questo strumento non è stato eseguito: l'utente non l'ha chiesto con il suo ultimo " +
    "messaggio. Rispondi a voce con una breve frase, senza chiamare altri strumenti e " +
    "senza inventare l'output che avresti ottenuto: se non puoi rispondere senza quello " +
    "strumento, dillo.",
  "pi.addendum":
    "\nSei in esecuzione dentro il CLI pi: usa pure i suoi strumenti " +
    "(bash, read, edit, write, …) e le sue skill quando servono. " +
    "Gli strumenti dell'harness vocale (note, timer, run_command) qui non esistono.",

  /** Last request of a turn whose tool rounds are spent: it carries no tools, so the
   *  model is told so in words — otherwise it writes its next call as plain text. */
  "prompt.answerNow":
    "Basta strumenti: rispondi adesso con una o due frasi a voce, usando quello che hai " +
    "già trovato. Non chiamare altri strumenti.",

  /** Appended to the system prompt, last: the generic "mirror the user" rule alone does
   *  not hold on a 4B model once the skills block follows it (measured 5/5 Italian
   *  answers to English with LOCALE=en; 0/5 with this line). */
  "prompt.langDefault":
    "Lingua predefinita: ITALIANO — l'interfaccia di questo utente è in italiano: quando un " +
    "messaggio si può leggere in entrambe le lingue rispondi in italiano (rispecchia comunque " +
    "l'altra lingua quando il messaggio è chiaramente scritto in inglese).",

  /** Role labels of the conversation pi renders as one prompt (PiSession.render). */
  "role.user": "Utente",
  "role.assistant": "Assistente",

  // ── run_command ──
  "cmd.none": "Nessun comando specificato.",
  "cmd.disabled": "L'esecuzione di comandi è disattivata.",
  "cmd.denied": "L'utente NON ha autorizzato il comando: non è stato eseguito.",
  "cmd.clipped":
    "…[troncato: mancano {n} caratteri nel mezzo — il testo sotto è la FINE dell'output " +
    "originale, non la parte più recente]…",
  "cmd.timeout": "[timeout dopo {s}s] ",
  "cmd.noOutput": "(nessun output)",
  /** A ✕ on the banner killed the shell: what the model is told instead of an output. */
  "cmd.cancelled": "Comando annullato dall'utente: il processo è stato terminato.",

  // ── the banner above the chat (pending timers / running commands / watches) ──
  "task.cancelTimer": "⏹ timer «{label}» annullato",
  "task.cancelCommand": "⏹ comando interrotto: «{label}»",
  "task.cancelWatch": "⏹ controllo «{label}» fermato",

  // ── the watch tool (a read-only check, repeated until it is stopped) ──
  "watch.none": "Nessun comando da controllare.",
  "watch.started":
    "Controllo «{label}» avviato: ripete il comando ogni {s} secondi, da solo, fino a " +
    "quando non lo fermi.",
  "watch.noneRunning": "Nessun controllo periodico in esecuzione.",
  "watch.runningList":
    "Controlli in esecuzione: {labels}. Passa a stop_watch il nome (o un frammento) per " +
    "fermarne uno.",
  "watch.notFound": "Nessun controllo corrisponde a «{label}».",
  "watch.stopped": "Controllo «{label}» fermato.",
  "announce.watchValue": "Controllo di {label}: {out}",
  "announce.watchMatched": "Attenzione, {label}: {out}",

  // ── clock (the date the get_datetime tool reads out) ──
  "date.full": "{date}, ore {time}",

  // ── timer ──
  "timer.set": "Timer '{label}' impostato per {s} secondi.",

  // ── notes ──
  "note.saved": "Nota salvata.",
  "note.noneRemove": "Nessuna nota da rimuovere.",
  "note.index": "Numero non valido: le note vanno da 1 a {n}. Rileggi con list_notes.",
  "note.mismatch":
    "La nota {idx} non è quella che mi hai indicato (c'è «{victim}»): nulla cancellato. " +
    "Rileggi con list_notes.",
  "note.removed": "Nota {idx} rimossa: «{victim}».",
  "note.removedLast": "Nota {idx} rimossa: «{victim}» — non ne restano altre.",
  "note.noneClear": "Nessuna nota da cancellare.",
  "note.clearAsk":
    "Ci sono {n} note e cancellarle tutte è definitivo: chiedi all'utente, poi richiama " +
    "clear_notes con confirm true. Per una sola, remove_note.",
  "note.cleared": "{n} note cancellate — ",
  "note.none": "Nessuna nota.",

  // ── a tool card's own meta line (pi's structured content, a gated call) ──
  // Internal states of a tool call, English in BOTH catalogues: the card's state words
  // (and the log's) never switch language, only the text around them does.
  "tool.truncated": "truncated",
  "tool.gatedInfo": "denied: not requested",
  "tool.blocked": "⛔ blocked",
  "tool.unknown": "Strumento sconosciuto: {name}",
} as const;

const en: Record<keyof typeof it, string> = {
  // chat lines
  "user.replyConfirm": "reply to the confirmation",
  "user.typed": "typed text",
  "user.turnEnd": "turn end: {reason} · gap {gap} ms · ASR {asr} ms",

  // event lines
  "evt.bargePause": "⏸ paused: the user is talking",
  "evt.keepListening": "… the LLM says: keep listening",
  "evt.interrupted": "✋ interrupted by the user",
  "evt.resume": "▶ resuming ({what}: «{text}»)",
  "evt.echo": "echo",
  "evt.backchannel": "backchannel",
  "evt.cmdApproved": "✅ command approved",
  "evt.cmdDenied": "❌ command denied",

  "via.click": "click",
  "via.unclear": "unclear reply",
  "via.cleaned": "chat cleared",
  "via.rewound": "conversation rewound",

  "spoken.approveCommand": "May I run the command you see on screen? Say yes or no.",
  "spoken.noAnswer":
    "Sorry, I could not put an answer together — could you ask me again?",
  "announce.timerExpired": "The {label} has expired.",

  "hist.interrupted": "[interrupted by the user]",
  "hist.interruptedQuiet": "[interrupted by the user before speaking]",

  "gated.tool":
    "This tool was not run: the user did not ask for it in their last message. " +
    "Answer with one short spoken sentence, without calling any other tool and without " +
    "inventing the output it would have produced: if you cannot answer without that " +
    "tool, say so.",
  "pi.addendum":
    "\nYou are running inside the pi CLI: feel free to use its own tools " +
    "(bash, read, edit, write, …) and its skills where they help. " +
    "The voice harness' tools (notes, timer, run_command) do not exist here.",

  "prompt.answerNow":
    "Enough tools: answer now with one or two spoken sentences, using what you already " +
    "found. Do not call any other tool.",

  "prompt.langDefault":
    "Language default: ENGLISH — this user's interface is in English, so when a message " +
    "could be read either way, answer in English (still mirror it when they clearly speak " +
    "another language).",

  "role.user": "User",
  "role.assistant": "Assistant",

  "cmd.none": "No command given.",
  "cmd.disabled": "Command execution is disabled.",
  "cmd.denied": "The user did NOT authorize the command: it was not run.",
  "cmd.clipped":
    "…[truncated: {n} characters missing from the middle — the text below is the END of " +
    "the original output, not its newest part]…",
  "cmd.timeout": "[timed out after {s}s] ",
  "cmd.noOutput": "(no output)",
  "cmd.cancelled": "Command cancelled by the user: the process was killed.",

  "task.cancelTimer": "⏹ timer «{label}» cancelled",
  "task.cancelCommand": "⏹ command stopped: «{label}»",
  "task.cancelWatch": "⏹ watch «{label}» stopped",

  "watch.none": "No command to watch.",
  "watch.started":
    "Watch «{label}» started: it repeats the command every {s} seconds on its own, until " +
    "you stop it.",
  "watch.noneRunning": "No watch is running.",
  "watch.runningList":
    "Running watches: {labels}. Pass stop_watch a name (or a fragment) to stop one.",
  "watch.notFound": "No watch matches «{label}».",
  "watch.stopped": "Watch «{label}» stopped.",
  "announce.watchValue": "Check of {label}: {out}",
  "announce.watchMatched": "Heads-up, {label}: {out}",

  "date.full": "{date}, {time}",

  "timer.set": "Timer '{label}' set for {s} seconds.",

  "note.saved": "Note saved.",
  "note.noneRemove": "No note to remove.",
  "note.index": "Invalid number: notes run from 1 to {n}. Re-read them with list_notes.",
  "note.mismatch":
    "Note {idx} is not the one you meant (there's «{victim}»): nothing deleted. " +
    "Re-read them with list_notes.",
  "note.removed": "Note {idx} removed: «{victim}».",
  "note.removedLast": "Note {idx} removed: «{victim}» — no notes left.",
  "note.noneClear": "No note to delete.",
  "note.clearAsk":
    "There are {n} notes and deleting them all is final: ask the user, then call " +
    "clear_notes with confirm true. For a single one, use remove_note.",
  "note.cleared": "{n} notes deleted — ",
  "note.none": "No notes.",

  "tool.truncated": "truncated",
  "tool.gatedInfo": "denied: not requested",
  "tool.blocked": "⛔ blocked",
  "tool.unknown": "Unknown tool: {name}",
};

const CATALOG: Record<Locale, Record<keyof typeof it, string>> = { it, en };

/**
 * `LOCALE` may be written as a POSIX locale (`it_IT.UTF-8`, `en_GB`): the base language
 * wins. Empty = unset → the default (`it`); a language this build does not ship falls
 * back to English, the safe choice for a stranger's machine.
 */
export function normalizeLocale(raw: string | null | undefined): Locale {
  const known = parseLocale(raw);
  if (known) return known;
  return (raw ?? "").trim() ? "en" : DEFAULT_LOCALE;
}

/** The same base-language pick, but `null` when this build does not ship it. */
export function parseLocale(raw: string | null | undefined): Locale | null {
  const base = (raw ?? "").trim().toLowerCase().split(/[-_.@]/)[0] ?? "";
  return (LOCALES as string[]).includes(base) ? (base as Locale) : null;
}

/**
 * The words only one of our two languages uses. Function words, not topic nouns: they are
 * what a speech transcript keeps even when the task's own name (a timer's label, e.g.
 * "Saluto finale") is all in the other language. Ambiguous little words ("in", "a", "me")
 * are left out of both lists — they would vote twice.
 */
const IT_MARKERS = new Set([
  "il", "lo", "la", "gli", "le", "un", "uno", "una", "di", "del", "dello", "della",
  "dei", "degli", "delle", "che", "per", "tra", "fra", "più", "minuto", "minuti",
  "secondo", "secondi", "ora", "ore", "ricorda", "ricordami", "sveglia", "svegliami",
  "poi", "quando", "scade", "scaduto", "scadenza", "favore", "grazie", "ciao",
  "buongiorno", "buonasera", "puoi", "vorrei", "metti", "imposta",
]);
const EN_MARKERS = new Set([
  "the", "of", "to", "for", "and", "my", "your", "that", "this", "minute", "minutes",
  "second", "seconds", "hour", "hours", "remind", "reminder", "wake", "timer", "then",
  "when", "please", "set", "expires", "expired", "ring", "rings", "alarm", "thanks",
  "could", "would", "should", "hi", "hello",
]);
const ACCENTS = /[àèéìòùáíóúâêîôû]/;

/**
 * The language of *this* piece of text, or `fallback` when nothing in it votes: the
 * assistant mirrors the user's language, so a timer set in Italian has to ring in
 * Italian even with `LOCALE=en` — "The Saluto finale has expired." is neither language.
 */
export function detectLocale(
  text: string | null | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  const src = text ?? "";
  let it = 0;
  let en = 0;
  for (const m of src.toLocaleLowerCase("it").matchAll(/[\p{L}\p{N}']+/gu)) {
    const w = m[0]!;
    if (IT_MARKERS.has(w)) it++;
    else if (EN_MARKERS.has(w)) en++;
  }
  if (ACCENTS.test(src)) it += 2; // è, à, ò … an accent is Italian, never English
  return it > en ? "it" : en > it ? "en" : fallback;
}

/** `{name}` placeholders are filled from `vars`; an unknown one is left as it was. */
export function t(
  locale: Locale,
  key: keyof typeof it,
  vars?: Record<string, string | number>,
): string {
  const raw: string = CATALOG[locale]?.[key] ?? CATALOG[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** BCP-47 tag for `Intl`: same language, the date layout each locale reads natively. */
export function intlLocale(locale: Locale): string {
  return locale === "it" ? "it-IT" : "en-GB";
}
