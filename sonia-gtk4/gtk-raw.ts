/**
 * jsGTK's `ScrolledWindow.getVadjustment()` is unusable under Bun, so this
 * module hands back the same adjustment through a wrapper that skips jsGTK's
 * buggy constructor.
 *
 * What goes wrong: `getVadjustment()` does `new Adjustment(ptr)`, but the
 * `Adjustment` ctor is ambiguous once the Deno-compat shim hands pointers back
 * as plain **numbers** — `typeof ptr === "number"` is taken for the *value*
 * overload, so it calls `gtk_adjustment_new(pointerAsValue, undefined, …)`,
 * GTK answers with `Gtk-CRITICAL: lower + page_size <= upper` and returns NULL,
 * and every subsequent get/set on that wrapper asserts `GTK_IS_ADJUSTMENT`.
 * That was the whole flood of criticals at startup; GTK itself is fine (a C
 * program gets a valid adjustment out of the very same call).
 *
 * The fix: read the window's `vadjustment` property (GTK owns it, borrowed
 * pointer — no ref dance) and store the raw pointer on a prototype-built
 * `Adjustment`, so `getValue/getPageSize/getUpper/setValue` talk to the real
 * object. No low-level FFI import needed.
 *
 * (Second, unrelated jsGTK/GTK 4.24 trap, handled in app.ts:
 * `GtkSearchEntry` derives from `GtkWidget`, not `GtkEntry`, so the inherited
 * `setPlaceholderText()` asserts `GTK_IS_ENTRY` — set the `placeholder-text`
 * property instead.)
 */

import { dlopen, JSCallback } from "bun:ffi";

import { Adjustment, ScrolledWindow } from "@sigmasd/gtk/gtk4";
import type { Widget } from "@sigmasd/gtk/gtk4";

const gtk = dlopen("libgtk-4.so.1", {
  gtk_widget_get_parent: { args: ["ptr"], returns: "ptr" },
}) as unknown as {
  symbols: { gtk_widget_get_parent: (w: unknown) => unknown };
};

const glib = dlopen("libglib-2.0.so.0", {
  g_idle_add: { args: ["ptr", "ptr"], returns: "u32" },
}) as unknown as {
  symbols: { g_idle_add: (cb: unknown, data: unknown) => number };
};

/** GSourceFunc return value: run once and remove the source. */
const G_SOURCE_REMOVE = 0;

/**
 * `g_idle_add` needs a plain C function pointer. Bun's FFI will not build one for
 * us (`cannot convert argument to 'function'`), but `bun:jsc`'s `JSCallback`
 * does — it is exactly what jsGTK's own Deno-compat shim uses for its signal
 * callbacks. Every trampoline is kept here: a collected JSCallback leaves GLib
 * holding a pointer to freed JSC code, i.e. a jump into the void.
 */
const trampolines = new Map<symbol, JSCallback>();
/** keys with a callback already sitting in the GLib queue (see onGtkIdleOnce). */
const queued = new Set<string>();

/**
 * Run `fn` **inside the GTK main loop** (next idle of the default GMainContext)
 * instead of straight from a JS callback.
 *
 * jsGTK's EventLoop drives `g_main_context_iteration` from Bun's event loop, so
 * anything a WebSocket handler, a child-process stdout callback or a
 * `setInterval` touches the widget tree *between* GTK steps — GLib may be
 * halfway through destroying/relayouting the very widgets we are poking, and GTK
 * answers `GTK_IS_WIDGET (self) failed` on a freed object, then dereferences
 * NULL. Going through `g_idle_add` puts the work back inside the iteration that
 * owns the widgets, where GTK expects it.
 */
export function onGtkIdle(fn: () => void): void {
  const key = Symbol("gtk-idle");
  const cb: JSCallback = new JSCallback(
    () => {
      trampolines.delete(key);
      try {
        fn();
      } catch (err) {
        console.error("gtk idle callback failed:", err);
      }
      // GLib drops its reference after we return; free the trampoline too.
      queueMicrotask(() => cb.close());
      return G_SOURCE_REMOVE;
    },
    { args: ["ptr"], returns: "i32" },
  );
  trampolines.set(key, cb);
  glib.symbols.g_idle_add(cb.ptr, 0);
}

/**
 * Like {@link onGtkIdle}, but at most one callback per `key` is in flight: a new
 * call while one is queued replaces nothing — it is simply dropped, which is
 * what a 50 Hz mic level wants (only the newest value matters, and the queue
 * must not grow into a backlog that makes the UI lag behind reality).
 */
export function onGtkIdleOnce(key: string, fn: () => void): void {
  if (queued.has(key)) return;
  queued.add(key);
  onGtkIdle(() => {
    queued.delete(key);
    fn();
  });
}

/**
 * The widget's parent, or null when it has none. jsGTK has no getParent(), and
 * `Box.remove(child)` on an already-unparented child is a GTK-CRITICAL
 * ("gtk_widget_get_parent (child) == …") — so every detach goes through here.
 */
export function parentOf(w: Widget | null): unknown {
  if (!w) return null;
  return gtk.symbols.gtk_widget_get_parent(w.ptr) ?? null;
}

/** The vertical adjustment of a scrolled window, wrapped without the ctor bug. */
export function vadjustmentOf(sw: ScrolledWindow): Adjustment {
  const raw = sw.getProperty("vadjustment");
  const adj = Object.create(Adjustment.prototype) as Adjustment;
  if (raw) adj.ptr = raw as Adjustment["ptr"];
  return adj;
}
