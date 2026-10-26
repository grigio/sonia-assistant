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
  /** The mic source died / came back (pw-record gone, device unplugged). */
  "evt.micDown": "⚠ microfono interrotto: non sento nulla finché non torna",
  "evt.micBack": "✅ microfono attivo di nuovo",

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
  // data/chat.json 94-96: after "Perfetto, grazie." the model wanted add_note, the gate
  // denied it — and the answer that followed claimed it could not "eseguire test tecnici
  // o manipolare l'audio". The denial says nothing about the assistant's abilities, so
  // the wording now spells that out: the tools are still yours, the user just did not ask
  // for this one right now.
  "gated.tool":
    "Questo strumento non è stato eseguito: l'utente non l'ha chiesto con il suo ultimo " +
    "messaggio. Rispondi a voce con una breve frase, senza chiamare altri strumenti e " +
    "senza inventare l'output che avresti ottenuto. Hai questi strumenti: non dire mai che " +
    "non puoi fare una cosa, l'utente semplicemente non te l'ha chiesta adesso.",
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
  /** command-policy rule 4: sensitive paths are refused even in CMD_MODE=auto. */
  "cmd.sensitive":
    "Comando rifiutato: tocca percorsi sensibili (.ssh, chiavi, .env) che non vengono mai " +
    "letti o scritti da soli. Chiedi all'utente di lanciarlo a mano.",
  "cmd.clipped":
    "…[troncato: mancano {n} caratteri nel mezzo — il testo sotto è la FINE dell'output " +
    "originale, non la parte più recente]…",
  "cmd.timeout": "[timeout dopo {s}s] ",
  "cmd.noOutput": "(nessun output)",
  /** A ✕ on the banner killed the shell: what the model is told instead of an output. */
  "cmd.cancelled": "Comando annullato dall'utente: il processo è stato terminato.",
  /** Why a P0.4 command is at the approval prompt (shown next to the model's reason). */
  "cmd.whyPrivileged": "comando privilegiato",
  "cmd.whyDestructive": "operazione distruttiva",
  "cmd.whyUntrusted": "dopo contenuto non fidato",

  // ── the banner above the chat (pending timers / running commands / watches) ──
  "task.cancelTimer": "⏹ timer «{label}» annullato",
  "task.cancelCommand": "⏹ comando interrotto: «{label}»",
  "task.cancelWatch": "⏹ controllo «{label}» fermato",

  // ── the watch tool (a read-only check, repeated until it is stopped) ──
  "watch.none": "Nessun comando da controllare.",
  "watch.badEvery": "Intervallo non valido: indicami un numero di secondi tra {min} e {max}.",
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
  "timer.badSeconds": "Durata del timer non valida: indicami un numero di secondi tra 1 e {max}.",

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
  /** The model sent a malformed arguments blob: the code used to answer with an empty
   *  `args` (and, e.g., a silently invented 60 s "timer"). Say the mistake instead. */
  "tool.badArgs":
    "Argomenti non validi per {name}: il JSON è malformato. Riprova con gli argomenti " +
    "previsti dallo schema della funzione.",
  "ctx.trimmed": "…[troncato: {n} caratteri rimossi per stare nella finestra di contesto]…",
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
  /** The mic source died / came back (pw-record gone, device unplugged). */
  "evt.micDown": "⚠ microphone lost: I hear nothing until it is back",
  "evt.micBack": "✅ microphone back",

  "via.click": "click",
  "via.unclear": "unclear reply",
  "via.cleaned": "chat cleared",
  "via.rewound": "conversation rewound",

  "spoken.approveCommand": "May I run the command you see on screen? Say yes or no.",
  "spoken.noAnswer": "Sorry, I could not put an answer together — could you ask me again?",
  "announce.timerExpired": "The {label} has expired.",

  "hist.interrupted": "[interrupted by the user]",
  "hist.interruptedQuiet": "[interrupted by the user before speaking]",

  "gated.tool":
    "This tool was not run: the user did not ask for it in their last message. " +
    "Answer with one short spoken sentence, without calling any other tool and without " +
    "inventing the output it would have produced. You do have these tools: never say you " +
    "cannot do something, the user simply did not ask for it right now.",
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
  "cmd.sensitive":
    "Refused: this touches sensitive paths (.ssh, keys, .env), never read or written " +
    "unattended. Ask the user to run it by hand.",
  "cmd.clipped":
    "…[truncated: {n} characters missing from the middle — the text below is the END of " +
    "the original output, not its newest part]…",
  "cmd.timeout": "[timed out after {s}s] ",
  "cmd.noOutput": "(no output)",
  "cmd.cancelled": "Command cancelled by the user: the process was killed.",
  "cmd.whyPrivileged": "privileged command",
  "cmd.whyDestructive": "destructive operation",
  "cmd.whyUntrusted": "after untrusted content",

  "task.cancelTimer": "⏹ timer «{label}» cancelled",
  "task.cancelCommand": "⏹ command stopped: «{label}»",
  "task.cancelWatch": "⏹ watch «{label}» stopped",

  "watch.none": "No command to watch.",
  "watch.badEvery": "Invalid interval: give me a number of seconds between {min} and {max}.",
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
  "timer.badSeconds": "Invalid timer duration: give me a number of seconds between 1 and {max}.",

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
  "tool.badArgs":
    "Invalid arguments for {name}: the JSON is malformed. Retry with the fields the " +
    "function schema expects.",
  "ctx.trimmed": "…[trimmed: {n} characters removed to fit the context window]…",
};

const CATALOG: Record<Locale, Record<keyof typeof it, string>> = { it, en };

// ── UI strings (the page + the GTK client) ─────────────────────────────────────
// The strings the *interface chrome* is made of (header, settings drawer, buttons,
// state words…) — what static/index.html used to carry as its own `UI_STRINGS`, with
// the `sonia-gtk4/i18n.ts` copy on top. One file now owns them: the server stamps them
// into the page at `GET /` (`uiStringsJson()` → the `__UI_STRINGS__` placeholder, just
// like `__LOCALE__`), and `sonia-gtk4/i18n.ts` imports them for its own controls.
// Same rule as the server's table: `it` is the source, `en` is typed against it, so a
// key may never exist in one language and not the other.

const uiIt = {
  "app.title": "Assistente full-duplex",
  "ui.title": "Assistente vocale",
  "state.connecting": "connessione…",
  "state.listening": "in ascolto",
  "state.user": "stai parlando…",
  "state.thinking": "sto pensando…",
  "state.speaking": "sto parlando",
  "state.confirm": "attendo la tua conferma (sì / no)",
  "state.paused": "in pausa (mi hai interrotto?)",
  "state.offline": "offline",

  "ctx.title.short": "ctx: token usati su n_ctx",
  "ctx.title": "ctx: {used} token usati su {total} ({pct}%)",
  "hdr.voice.title":
    "Voce dell'assistente on/off — spegne solo la riproduzione, il microfono resta attivo",
  "hdr.voice.aria": "Voce dell'assistente on/off",
  "hdr.refresh.title": "Aggiorna l'elenco dei modelli (pi --list-models)",
  "hdr.refresh.aria": "Aggiorna elenco modelli",
  "model.api.title": "Modello LLM (llama-server)",
  "model.pi.title": "Modello di pi — elenco da `pi --list-models` (PI_MODEL)",
  "model.aria": "Modello LLM — scrivi una parte del nome per filtrare l'elenco",
  // gtk-only (the model popover there shows its own counts)
  "model.pop.title": "{n} modelli disponibili",
  "model.pop.matches": "modelli su {n}",
  "model.filter.head": "🔍 «{q}» · {n} di {total}",
  "model.filter.title": " — filtro «{q}»: {n} di {total} modelli (Backspace corregge, Esc azzera)",
  "model.list.title": " — {n} modelli, scrivi una parte del nome per filtrare",

  "set.title": "Impostazioni",
  "set.hint": "ogni scelta è subito attiva, niente da salvare · Esc per chiudere",
  "set.close": "Chiudi le impostazioni",
  "set.grp.listen": "ascolto",
  "set.barge.title": "Se parli sopra l'assistente, questo si ferma e torna ad ascoltare",
  "set.barge.sub": "mi fermi se parli sopra di me",
  "set.half.title": "Mentre l'assistente parla il microfono viene ignorato (serve solo senza AEC)",
  "set.half.sub": "ignora il microfono mentre parlo (niente AEC)",
  "set.aec.title":
    "Manda l'audio in riproduzione all'ecocancellatore del browser, così il microfono non raccoglie la voce dell'assistente",
  "set.aec.sub": "rimanda l'audio in play all'ecocancellatore",
  "set.grp.voice": "voce",
  "set.voice.title":
    "La voce del sintetizzatore: ogni voce è un preset del pacchetto TTS caricato sul server audio (in futuro anche altri pacchetti/lingue)",
  "set.voice": "sintetizzatore",
  "set.voice.aria": "Voce dell'assistente (TTS)",
  "voice.meta": "TTS · {hz} Hz · {n} voci",
  "set.grp.reply": "risposta",
  "think.label": "ragionamento",
  "set.think.title":
    "Il modello ragiona prima di rispondere: il ragionamento appare nel chat come blocco collassato, non viene mai detto ad alta voce",
  "set.think.sub": "penso prima di rispondere · 💭 resta collassato sotto la risposta",
  "set.pi.title":
    'Risponde il CLI pi (pi -c "…"), con i suoi strumenti e la sua memoria, invece dell\'API OpenAI-compatibile di llama-server',
  "set.pi.sub":
    "strumenti, skill e memoria di pi · il modello si sceglie nella tendina in alto e si filtra scrivendoci dentro",
  "set.grp.cmd": "comandi",
  "set.cmd.title": "Esecuzione comandi Linux locali",
  "set.cmd.sub": "quando posso eseguire comandi",
  "set.turn.title":
    "Quanto chiedo all'LLM se hai finito di parlare, quando il silenzio da solo non basta",
  "set.turn": "fine turno",
  "set.turn.sub": "quanto chiedo all'LLM se hai finito",
  "opt.ask": "chiedi",
  "opt.auto": "auto",
  "opt.off": "off",
  "opt.always": "sempre",
  "skills.title":
    "Skill: pacchetti di istruzioni e script nella cartella delle skill. Solo quelle spuntate entrano nel contesto dell'assistente (li decidi tu, non lui).",
  "skills.empty.in": "nessuna skill in {dir}",
  "skills.empty": "nessuna skill trovata",

  "ft.input.ph": "Parla, oppure scrivi qui e premi Invio…",
  "ft.send.title": "Invia il messaggio",
  "ft.send.aria": "Invia il messaggio",
  "ft.mic.title":
    "Microfono on/off — ferma solo l'ascolto, la voce dell'assistente continua (usala in alto a destra)",
  "ft.mic.aria": "Microfono on/off",
  "ft.stop.title": "Ferma l'ascolto e la risposta",
  "ft.stop.aria": "Ferma",
  "ft.reset.title": "Cancella la chat e la memoria della conversazione",
  "ft.reset.aria": "Cancella la chat",
  "overlay.text": "Serve un clic per attivare audio e microfono.",
  "overlay.start": "Avvia",

  "msg.cut": "interrotto",
  "msg.newChat": "Nuova conversazione.",
  "msg.replaced": "Un'altra finestra ha preso il controllo: ricarica la pagina per riprenderlo.",
  "msg.ready": "Pronto. Parla pure — puoi interrompermi quando vuoi.",
  "msg.rew.title": "Riavvolgi la conversazione fin qui — cancella tutto ciò che viene dopo",
  "msg.rew.aria": "Riavvolgi la conversazione fin qui",
  "msg.rew.done": "⟲ conversazione riavvolta: {n} messaggi cancellati",
  "msg.rew.lost":
    "⟲ checkpoint non trovato: nessuna modifica (ricarica la pagina se la chat è sfasata)",
  "think.chars": "· {n} car",
  "cmd.head": "💻 comando",
  "cmd.wants": "💻 vuole eseguire questo comando:",
  "cmd.run": "💻 eseguo:",
  "cmd.runAuto": "💻 eseguo (sola lettura):",
  "cmd.running": "⏳ in esecuzione…",
  "cmd.denied": "❌ non eseguito",
  "cmd.yes": "Esegui",
  "cmd.no": "Annulla",
  "cmd.voiceHint": "oppure rispondi a voce «sì» / «no»",
  "cmd.output": "output ({n} righe)",
  "cmd.stopped": "⏹ annullato",
  "tasks.cancel": "Annulla",
  "tasks.cancelAria": "Annulla «{label}»",
  // tool-card states stay ENGLISH in every locale: they are internal states, the
  // same machine-ish words the log uses, not text to translate
  "tool.running": "⏳ running",
  "tool.error": "⚠ error",
  "tool.blocked": "⛔ blocked",
  "tool.details": "dettagli",
  "tool.noOutput": "(nessun output)",
  "ev.latency": "⏱ primo token {a} ms · primo audio {b} ms",
  "ev.models": "↻ elenco modelli aggiornato: {n} voci",
  "ev.loading": "⏳ carico il modello {m}…",
  "ev.ready": "✅ modello {m} pronto ({s} s)",
  "ev.modelError": "⚠ impossibile caricare {m}: {e}",
  "audio.direct": "{reason} → uscita audio diretta",
  "audio.loopOn": "🔈 AEC loopback attivo",
  "audio.noNet": "rete assente",
  "audio.offline": "rete assente, AEC loopback non disponibile",
  "audio.loopFail": "AEC loopback non connesso (rete?)",
  "audio.loopLost": "connessione AEC loopback persa (rete cambiata?)",
  "audio.loopNone": "AEC loopback non disponibile",
} as const;

const uiEn: Record<keyof typeof uiIt, string> = {
  "app.title": "Sonia Assistant",
  "ui.title": "Voice assistant",
  "state.connecting": "connecting…",
  "state.listening": "listening",
  "state.user": "you're talking…",
  "state.thinking": "thinking…",
  "state.speaking": "speaking",
  "state.confirm": "waiting for your confirmation (yes / no)",
  "state.paused": "paused (did you interrupt me?)",
  "state.offline": "offline",

  "ctx.title.short": "ctx: tokens used of n_ctx",
  "ctx.title": "ctx: {used} of {total} tokens ({pct}%)",
  "hdr.voice.title": "Assistant's voice on/off — mutes the playback only, the microphone stays on",
  "hdr.voice.aria": "Assistant's voice on/off",
  "hdr.refresh.title": "Refresh the model list (pi --list-models)",
  "hdr.refresh.aria": "Refresh model list",
  "model.api.title": "LLM model (llama-server)",
  "model.pi.title": "pi model — list from `pi --list-models` (PI_MODEL)",
  "model.aria": "LLM model — type part of the name to filter the list",
  "model.pop.title": "{n} models available",
  "model.pop.matches": "models out of {n}",
  "model.filter.head": "🔍 «{q}» · {n} of {total}",
  "model.filter.title": " — filter «{q}»: {n} of {total} models (Backspace edits, Esc clears)",
  "model.list.title": " — {n} models, type part of a name to filter",

  "set.title": "Settings",
  "set.hint": "every choice applies immediately, nothing to save · Esc closes",
  "set.close": "Close settings",
  "set.grp.listen": "listening",
  "set.barge.title": "If you talk over the assistant, it stops and goes back to listening",
  "set.barge.sub": "you stop when I talk over you",
  "set.half.title":
    "While the assistant speaks the microphone is ignored (only needed without AEC)",
  "set.half.sub": "ignore the microphone while I speak (no AEC)",
  "set.aec.title":
    "Sends the playback audio to the browser's echo canceller, so the microphone never picks up the assistant's voice",
  "set.aec.sub": "routes the playing audio back to the canceller",
  "set.grp.voice": "voice",
  "set.voice.title":
    "The synthesiser's voice: every voice is a preset of the TTS pack loaded on the audio server (other packs/languages later)",
  "set.voice": "synthesiser",
  "set.voice.aria": "Assistant's voice (TTS)",
  "voice.meta": "TTS · {hz} Hz · {n} voices",
  "set.grp.reply": "reply",
  "think.label": "reasoning",
  "set.think.title":
    "The model reasons before answering: the reasoning shows in the chat as a collapsed block and is never spoken aloud",
  "set.think.sub": "I think before answering · 💭 stays collapsed under the answer",
  "set.pi.title":
    'The pi CLI answers (pi -c "…"), with its own tools and memory, instead of llama-server\'s OpenAI-compatible API',
  "set.pi.sub":
    "pi's tools, skills and memory · pick the model in the dropdown above and filter by typing into it",
  "set.grp.cmd": "commands",
  "set.cmd.title": "Local Linux command execution",
  "set.cmd.sub": "when I may run commands",
  "set.turn.title":
    "How often I ask the LLM whether you have finished speaking, when silence alone is not enough",
  "set.turn": "end of turn",
  "set.turn.sub": "how often I ask the LLM if you are done",
  "opt.ask": "ask",
  "opt.auto": "auto",
  "opt.off": "off",
  "opt.always": "always",
  "skills.title":
    "Skills: instruction and script packages in the skills folder. Only the ticked ones enter the assistant's context (you decide, not it).",
  "skills.empty.in": "no skills in {dir}",
  "skills.empty": "no skills found",

  "ft.input.ph": "Speak, or type here and press Enter…",
  "ft.send.title": "Send the message",
  "ft.send.aria": "Send the message",
  "ft.mic.title":
    "Microphone on/off — stops the listening only, the assistant's voice keeps going (use the one top-right)",
  "ft.mic.aria": "Microphone on/off",
  "ft.stop.title": "Stop listening and answering",
  "ft.stop.aria": "Stop",
  "ft.reset.title": "Clear the chat and the conversation memory",
  "ft.reset.aria": "Clear the chat",
  "overlay.text": "One click is needed to switch on the audio and the microphone.",
  "overlay.start": "Start",

  "msg.cut": "interrupted",
  "msg.newChat": "New conversation.",
  "msg.replaced": "Another window took control — reload the page to take it back.",
  "msg.ready": "Ready. Just speak — you can interrupt me whenever you like.",
  "msg.rew.title": "Rewind the conversation to here — drops everything after it",
  "msg.rew.aria": "Rewind the conversation to here",
  "msg.rew.done": "⟲ conversation rewound: {n} messages dropped",
  "msg.rew.lost":
    "⟲ checkpoint not found: nothing changed (reload the page if the chat is out of step)",
  "think.chars": "· {n} chars",
  "cmd.head": "💻 command",
  "cmd.wants": "💻 wants to run this command:",
  "cmd.run": "💻 running:",
  "cmd.runAuto": "💻 running (read-only):",
  "cmd.running": "⏳ running…",
  "cmd.denied": "❌ not run",
  "cmd.yes": "Run",
  "cmd.no": "Cancel",
  "cmd.voiceHint": "or answer by voice «yes» / «no»",
  "cmd.output": "output ({n} lines)",
  "cmd.stopped": "⏹ cancelled",
  "tasks.cancel": "Cancel",
  "tasks.cancelAria": "Cancel «{label}»",
  "tool.running": "⏳ running",
  "tool.error": "⚠ error",
  "tool.blocked": "⛔ blocked",
  "tool.details": "details",
  "tool.noOutput": "(no output)",
  "ev.latency": "⏱ first token {a} ms · first audio {b} ms",
  "ev.models": "↻ model list refreshed: {n} entries",
  "ev.loading": "⏳ loading model {m}…",
  "ev.ready": "✅ model {m} ready ({s} s)",
  "ev.modelError": "⚠ cannot load {m}: {e}",
  "audio.direct": "{reason} → direct audio output",
  "audio.loopOn": "🔈 AEC loopback active",
  "audio.noNet": "no network",
  "audio.offline": "no network, AEC loopback unavailable",
  "audio.loopFail": "AEC loopback not connected (network?)",
  "audio.loopLost": "AEC loopback connection lost (network changed?)",
  "audio.loopNone": "AEC loopback unavailable",
};

/** The one catalogue the page and the GTK client draw from (stamped in / imported). */
export const UI_STRINGS: Record<Locale, Record<keyof typeof uiIt, string>> = {
  it: uiIt,
  en: uiEn,
};

/**
 * `UI_STRINGS` as an injection-ready script value for `index()`: the page says
 * `const UI_STRINGS = __UI_STRINGS__;` and the server swaps this in. Every `<` is
 * escaped (`\u003c`) so the JSON can never close the `<script>` element itself, and —
 * because the stamp order matters (`__UI_STRINGS__` first, `__LOCALE__` second) — the
 * data must not carry the locale stamp: the catalogue texts guard it loudly.
 */
export function uiStringsJson(): string {
  const json = JSON.stringify(UI_STRINGS).replace(/</g, "\\u003c");
  if (json.includes("__LOCALE__")) {
    throw new Error("a UI string carries the literal __LOCALE__ stamp — fix the wording");
  }
  return json;
}

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
  const base =
    (raw ?? "")
      .trim()
      .toLowerCase()
      .split(/[-_.@]/)[0] ?? "";
  return (LOCALES as string[]).includes(base) ? (base as Locale) : null;
}

/**
 * The words only one of our two languages uses. Function words, not topic nouns: they are
 * what a speech transcript keeps even when the task's own name (a timer's label, e.g.
 * "Saluto finale") is all in the other language. Ambiguous little words ("in", "a", "me")
 * are left out of both lists — they would vote twice.
 */
const IT_MARKERS = new Set([
  "il",
  "lo",
  "la",
  "gli",
  "le",
  "un",
  "uno",
  "una",
  "di",
  "del",
  "dello",
  "della",
  "dei",
  "degli",
  "delle",
  "che",
  "per",
  "tra",
  "fra",
  "più",
  "minuto",
  "minuti",
  "secondo",
  "secondi",
  "ora",
  "ore",
  "ricorda",
  "ricordami",
  "sveglia",
  "svegliami",
  "poi",
  "quando",
  "scade",
  "scaduto",
  "scadenza",
  "favore",
  "grazie",
  "ciao",
  "buongiorno",
  "buonasera",
  "puoi",
  "vorrei",
  "metti",
  "imposta",
]);
const EN_MARKERS = new Set([
  "the",
  "of",
  "to",
  "for",
  "and",
  "my",
  "your",
  "that",
  "this",
  "minute",
  "minutes",
  "second",
  "seconds",
  "hour",
  "hours",
  "remind",
  "reminder",
  "wake",
  "timer",
  "then",
  "when",
  "please",
  "set",
  "expires",
  "expired",
  "ring",
  "rings",
  "alarm",
  "thanks",
  "could",
  "would",
  "should",
  "hi",
  "hello",
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
