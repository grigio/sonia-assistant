/**
 * UI strings for the native GTK4 client — the *shared* catalogue from `src/i18n.ts`
 * (the file the server also stamps into `static/index.html` at `GET /`, so the two
 * front-ends cannot drift apart any more) plus the `aec.*` / `gtk.*` keys only this
 * client has controls for. `it` stays the source catalogue.
 */
import { type Locale, UI_STRINGS } from "../src/i18n";

export type { Locale };

/** Keys only the native client uses (the web UI has no equivalent controls). */
const GTK_STRINGS: Record<Locale, Record<string, string>> = {
  it: {
    "aec.on": "🔈 AEC di sistema attivo (fd_ec_source/fd_ec_sink)",
    "aec.missing": "module-echo-cancel non caricato — esegui scripts/echo-cancel.sh on",
    "aec.off": "AEC di sistema disattivato",
    "aec.speaker": "uscita: altoparlanti (nessun target AEC)",
    "gtk.mic.target": "sorgente: {name}",
    "gtk.prefs": "Impostazioni",
    "gtk.about.title": "Informazioni",
    "gtk.out": "output ({n} righe)",
    "gtk.noBackend.title": "Backend non raggiungibile",
    "gtk.noBackend.body":
      "Nessuna risposta su {url}.\n\nIl client è solo una finestra: llama-server, i server audio.cpp e l'harness devono essere già avviati. Da terminale:\n\nbun run start",
    "gtk.close": "Chiudi",
    "dbg.title": "Calibrazione audio",
    "dbg.sec.mic": "Voce utente",
    "dbg.sec.silence": "Silenzio",
    "dbg.sec.voice": "Voce assistente",
    "dbg.refresh": "Rileggi i volumi e azzera i contatori",
    "dbg.close": "Chiudi la calibrazione",
    "dbg.num.db": "rms {rms} · picco {peak}",
    "dbg.num.sil": "rumore {floor} · soglia {thr} · {pct}% sopra",
    "dbg.chip.voice": "voce",
    "dbg.chip.silence": "silenzio",
    "dbg.chip.off": "spento",
    "dbg.chip.zeros": "zeri",
    "dbg.chip.clip": "clipping",
    "dbg.chip.ok": "ok",
    "dbg.chip.muted": "muto",
    "dbg.mic.src": "sorgente: {name}",
    "dbg.mic.hw": "mic {range}",
    "dbg.mic.novol": "volume hardware non leggibile (pactl)",
    "dbg.mic.aec.on": "AEC attivo",
    "dbg.mic.aec.off": "AEC spento",
    "dbg.sil.info": "gate ×{ratio} · passa-alto {hp} · {state}",
    "dbg.sil.inert": "non applicato al flusso",
    "dbg.sil.active": "filtro attivo",
    "dbg.spk.info": "{rate} Hz · uscita: {name}",
    "dbg.spk.default": "predefinita",
    "dbg.spk.muted": "voce disattivata nel footer",
    "dbg.more": "+{n} altri problemi",
    "dbg.fix.raise": "Porta a {pct}%",
    "dbg.fix.lower": "Abbassa a {pct}%",
    "dbg.fix.unmute": "Togli il mute",
    "dbg.fix.restart": "Riavvia il microfono",
    "dbg.fix.micOn": "Accendi il microfono",
    "dbg.fix.voiceOn": "Attiva la voce",
    "dbg.fix.aec": "Attiva AEC",
    "dbg.fix.half": "Attiva half-duplex",
    "dbg.fix.barge": "Disattiva barge-in",
    "dbg.ok": "Tutto nella norma: la voce sta sopra il rumore e il silenzio resta sotto la soglia.",
    "dbg.w.noFrames": "nessun frame dal microfono: riavvialo o controlla il dispositivo",
    "dbg.w.zeros":
      "il microfono manda zeri ({pct}%): sorgente muta o volume basso. Alza il volume o cambia sorgente.",
    "dbg.w.someZeros": "molti frame a zero ({pct}%): alza il volume di cattura",
    "dbg.w.clip": "clipping ({pct}%): abbassa il volume di cattura",
    "dbg.w.volume": "volume di cattura al {pct}% (minimo {min}%): alzalo",
    "dbg.w.mute": "la sorgente audio è muta: togli il mute",
    "dbg.w.floor": "rumore di fondo a {db}: avvicinati al microfono o riduci il rumore",
    "dbg.w.sep": "voce e rumore a {db} di distanza: avvicinati al microfono o riduci il rumore",
    "dbg.w.echo":
      "il microfono sente l'uscita ({db}): Sonia può interrompersi. Attiva AEC o half-duplex.",
    "dbg.w.spk": "l'assistente parla ma il player non è attivo: controlla l'uscita",
    "dbg.w.micOff": "microfono spento: accendilo per calibrare",
    "dbg.w.voiceOff": "voce di Sonia disattivata: attivala per sentirla",
  },
  en: {
    "aec.on": "🔈 system AEC active (fd_ec_source/fd_ec_sink)",
    "aec.missing": "module-echo-cancel not loaded — run scripts/echo-cancel.sh on",
    "aec.off": "system AEC off",
    "aec.speaker": "output: speakers (no AEC target)",
    "gtk.mic.target": "source: {name}",
    "gtk.prefs": "Settings",
    "gtk.about.title": "About",
    "gtk.out": "output ({n} lines)",
    "gtk.noBackend.title": "Backend unreachable",
    "gtk.noBackend.body":
      "Nothing is answering at {url}.\n\nThe client is only a window: llama-server, the audio.cpp servers and the harness must already be running. From a terminal:\n\nbun run start",
    "gtk.close": "Close",
    "dbg.title": "Audio calibration",
    "dbg.sec.mic": "User voice",
    "dbg.sec.silence": "Silence",
    "dbg.sec.voice": "Assistant voice",
    "dbg.refresh": "Re-read volumes and reset the counters",
    "dbg.close": "Close the calibration",
    "dbg.num.db": "rms {rms} · peak {peak}",
    "dbg.num.sil": "noise {floor} · threshold {thr} · {pct}% above",
    "dbg.chip.voice": "voice",
    "dbg.chip.silence": "silence",
    "dbg.chip.off": "off",
    "dbg.chip.zeros": "zeros",
    "dbg.chip.clip": "clipping",
    "dbg.chip.ok": "ok",
    "dbg.chip.muted": "muted",
    "dbg.mic.src": "source: {name}",
    "dbg.mic.hw": "mic {range}",
    "dbg.mic.novol": "hardware volume unreadable (pactl)",
    "dbg.mic.aec.on": "AEC on",
    "dbg.mic.aec.off": "AEC off",
    "dbg.sil.info": "gate ×{ratio} · high-pass {hp} · {state}",
    "dbg.sil.inert": "not applied to the stream",
    "dbg.sil.active": "filter active",
    "dbg.spk.info": "{rate} Hz · output: {name}",
    "dbg.spk.default": "default",
    "dbg.spk.muted": "voice muted in the footer",
    "dbg.more": "+{n} more problems",
    "dbg.fix.raise": "Set to {pct}%",
    "dbg.fix.lower": "Lower to {pct}%",
    "dbg.fix.unmute": "Unmute",
    "dbg.fix.restart": "Restart the microphone",
    "dbg.fix.micOn": "Turn the microphone on",
    "dbg.fix.voiceOn": "Turn the voice on",
    "dbg.fix.aec": "Enable AEC",
    "dbg.fix.half": "Enable half-duplex",
    "dbg.fix.barge": "Disable barge-in",
    "dbg.ok": "All good: your voice sits above the noise and silence stays below the threshold.",
    "dbg.w.noFrames": "no frames from the microphone: restart it or check the device",
    "dbg.w.zeros":
      "the microphone is sending zeros ({pct}%): muted source or low volume. Raise the volume or pick another source.",
    "dbg.w.someZeros": "many all-zero frames ({pct}%): raise the capture volume",
    "dbg.w.clip": "clipping ({pct}%): lower the capture volume",
    "dbg.w.volume": "capture volume at {pct}% (minimum {min}%): raise it",
    "dbg.w.mute": "the audio source is muted: unmute it",
    "dbg.w.floor": "noise floor at {db}: move closer to the microphone or reduce the noise",
    "dbg.w.sep": "voice and noise only {db} apart: move closer or reduce the noise",
    "dbg.w.echo":
      "the microphone hears the output ({db}): Sonia may interrupt herself. Enable AEC or half-duplex.",
    "dbg.w.spk": "the assistant is speaking but the player is not running: check the output",
    "dbg.w.micOff": "microphone off: turn it on to calibrate",
    "dbg.w.voiceOff": "Sonia's voice is muted: turn it on to hear her",
  },
};

/** Merged view for this client; a local enum spread, *not* `Object.assign` on the
 *  imported table — the shared catalogue must stay clean for the other consumers. */
const STRINGS: Record<Locale, Record<string, string>> = {
  it: { ...UI_STRINGS.it, ...GTK_STRINGS.it },
  en: { ...UI_STRINGS.en, ...GTK_STRINGS.en },
};

/** The whole catalogue, keyed by locale — `t()` falls back to `it`, then to the key. */
export function stringsFor(locale: string): Record<string, string> {
  const table = STRINGS as unknown as Record<string, Record<string, string>>;
  return table[locale] ?? table.it;
}

export function resolveLocale(raw: string | undefined): Locale {
  return raw === "en" ? "en" : "it";
}

/** `t(key)` + `tf(key, vars)` bound to one locale; NUM = its number layout. */
export function makeI18n(locale: Locale) {
  const S = stringsFor(locale);
  const fallback = stringsFor("it");
  const t = (key: string): string => S[key] ?? fallback[key] ?? key;
  const tf = (key: string, vars: Record<string, unknown>): string =>
    t(key).replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
  const NUM = locale === "it" ? "it-IT" : "en-US";
  return { t, tf, NUM, locale };
}

export type I18n = ReturnType<typeof makeI18n>;
