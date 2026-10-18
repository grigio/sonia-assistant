/**
 * The preflight dialog: shown when `HARNESS_URL` answers nothing.
 *
 * The client is only a window and must never start the backends itself, but it
 * can at least *say* they are missing. `main.ts` already writes the same thing
 * to stderr, yet a desktop launch (`sonia-gtk4.desktop`, the app menu) has no
 * terminal to read it in — without this the process just exits and nothing
 * appears at all.
 *
 * It runs as its own GTK application with a distinct id: the real
 * `it.sonia.Assistant` may already be owned by a running (or stale) instance,
 * and a second app under that id would be "remote" — it would never get its
 * `activate` signal, so the dialog would never be built.
 */

import { MessageDialog, ResponseAppearance } from "@sigmasd/gtk/adw";
import { EventLoop } from "@sigmasd/gtk/eventloop";
import { Application, ApplicationFlags } from "@sigmasd/gtk/gtk4";
import { setDefaultIconName } from "./gtk-raw";
import { makeI18n } from "./i18n";

/** Best effort: a missing icon (or a missing display) must not stop the message. */
const ICON_NAME = "sonia-gtk4";
const APP_ID = "it.sonia.Assistant.Error";

export async function showBackendUnreachable(opts: { url: string; locale: string }): Promise<void> {
  const i18n = makeI18n(opts.locale === "en" ? "en" : "it");
  const app = new Application(APP_ID, ApplicationFlags.NONE);
  const loop = new EventLoop({ pollInterval: 16 });

  // Keep the dialog referenced for as long as it is on screen: libadwaita owns
  // the GObject, but not the JS wrapper, and a collected wrapper means a signal
  // callback into freed memory.
  const dialogs: MessageDialog[] = [];

  app.onActivate(() => {
    try {
      setDefaultIconName(ICON_NAME);
      const dialog = new MessageDialog(
        null,
        i18n.t("gtk.noBackend.title"),
        i18n.tf("gtk.noBackend.body", { url: opts.url }),
      );
      dialog.addResponse("close", i18n.t("gtk.close"));
      dialog.setResponseAppearance("close", ResponseAppearance.SUGGESTED);
      dialog.setDefaultResponse("close");
      dialog.setCloseResponse("close");
      dialog.onResponse(() => {
        dialog.close();
        loop.stop();
      });
      dialogs.push(dialog);
      dialog.present();
    } catch (err) {
      // No display / no libadwaita: the stderr line is all we have left.
      console.error("could not show the backend dialog:", err);
      loop.stop();
    }
  });

  await loop.start(app);
}
