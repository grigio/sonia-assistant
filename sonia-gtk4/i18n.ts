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
