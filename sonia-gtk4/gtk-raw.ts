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
  gtk_window_set_icon_name: { args: ["ptr", "ptr"], returns: "void" },
  gtk_window_set_default_icon_name: { args: ["ptr"], returns: "void" },
  // GTK 4.10+: the same named colours the stylesheet writes as @accent_color &
  // friends are readable back out of a widget's style context.
  gtk_style_context_lookup_color: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
}) as unknown as {
  symbols: {
    gtk_widget_get_parent: (w: unknown) => unknown;
    gtk_window_set_icon_name: (w: unknown, name: unknown) => void;
    gtk_window_set_default_icon_name: (name: unknown) => void;
    gtk_style_context_lookup_color: (
      ctx: unknown,
      name: unknown,
      rgba: unknown,
    ) => number;
  };
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

/**
 * The icon of a window (the task switcher, Alt-Tab, the WM's title bar).
 *
 * jsGTK binds neither `gtk_window_set_icon` nor `..._set_default_icon_name`, and
 * a window with no icon of its own is the generic blank block everyone recognises
 * from a half-finished app — so the one symbol we need goes through FFI, same
 * libgtk-4 the widgets themselves come from.
 *
 * Returns false when the symbol is not there, so the caller can stay quiet rather
 * than pretend the icon worked.
 */
export function setWindowIcon(w: Widget, iconName: string): boolean {
  try {
    if (typeof gtk.symbols.gtk_window_set_icon_name !== "function") return false;
    gtk.symbols.gtk_window_set_icon_name(w.ptr, iconName);
    return true;
  } catch {
    return false;
  }
}

/**
 * One of libadwaita's named colours (`accent_color`, `success_color`,
 * `window_fg_color`, …) as straight RGBA in 0..1, or null when this GTK has no
 * such colour — the caller then keeps whatever it drew before.
 *
 * The two cairo circles (the header orb, the footer's mic dot) are painted on a
 * `CairoContext`, where no CSS rule reaches, and hard-coding their hexes there
 * would pin the app to one palette: no light mode, no user accent. A
 * `GtkWidget` has to be passed in only to reach its style context — the colour
 * is a theme-wide constant, so any visible widget answers the same.
 *
 * jsGTK binds no `GtkStyleContext.getColor()`, hence the two extra FFI lines.
 * The output is a `GdkRGBA`, i.e. **four floats** — reading it as doubles (the
 * obvious `Float64Array`) returns plausible-looking nonsense.
 */
export function themeRgba(w: Widget, name: string): [number, number, number, number] | null {
  try {
    const ctx = (w as unknown as { getStyleContext(): { ptr: unknown } }).getStyleContext();
    const rgba = new Float32Array(4);
    const found = gtk.symbols.gtk_style_context_lookup_color(
      ctx.ptr,
      Buffer.from(name + "\0", "utf8"),
      rgba,
    );
    if (!found) return null;
    const [r, g, b, a] = rgba;
    // a lookup on a widget whose style context has not been realised yet can
    // answer with uninitialised floats; clamp rather than paint garbage
    if (![r, g, b, a].every((v) => Number.isFinite(v))) return null;
    return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
  } catch {
    return null;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Icon for every window that has none of its own (main + preferences). */
export function setDefaultIconName(iconName: string): boolean {
  try {
    if (typeof gtk.symbols.gtk_window_set_default_icon_name !== "function") return false;
    gtk.symbols.gtk_window_set_default_icon_name(iconName);
    return true;
  } catch {
    return false;
  }
}
