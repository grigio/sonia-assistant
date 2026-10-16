/**
 * Sonia — native GTK4 client for the sonia-assistant harness.
 *
 * A port of `static/index.html` (same protocol, same disciplines, same layout):
 * header with the state orb + model picker · task banner · chat with tool/command
 * cards, 💭 reasoning and ⟲ rewind · partial line · footer with mic dot + input.
 *
 * The wire types are imported from the harness itself (`./protocol` → src/events.ts):
 * one contract, two front-ends. The protocol disciplines ported verbatim from the web
 * UI — single-client slot (`session_taken`), reset barrier, rewind-from-the-last-
 * survivor, newest-wins model refresh — keep their original comments where they explain
 * a non-obvious rule.
 */

import fs from "node:fs";
import path from "node:path";
import {
  ColorScheme,
  ComboRow,
  HeaderBar,
  PreferencesGroup,
  PreferencesPage,
  PreferencesWindow,
  StyleManager,
  SwitchRow,
} from "@sigmasd/gtk/adw";
import type { CairoContext } from "@sigmasd/gtk/cairo";
import { EventLoop } from "@sigmasd/gtk/eventloop";
import {
  Align,
  Application,
  ApplicationFlags,
  ApplicationWindow,
  Box,
  Button,
  CssProvider,
  Display,
  DrawingArea,
  Entry,
  Image,
  Label,
  ListBox,
  ListBoxRow,
  MenuButton,
  Orientation,
  PolicyType,
  Popover,
  ProgressBar,
  ScrolledWindow,
  SearchEntry,
  SelectionMode,
  StringList,
  StyleContext,
  StyleProviderPriority,
  ToggleButton,
  type Widget,
} from "@sigmasd/gtk/gtk4";
import { Mic, type MicFrame, Speaker } from "./audio";
import {
  onGtkIdle,
  onGtkIdleOnce,
  parentOf,
  setDefaultIconName,
  setWindowIcon,
  themeRgba,
  vadjustmentOf,
} from "./gtk-raw";
import { type I18n, makeI18n } from "./i18n";
import type {
  ClientCommand,
  HistoryMessage,
  ServerEvent,
  SkillInfo,
  StateName,
  TaskInfo,
} from "./protocol";
import { STALE_ON_RESET } from "./protocol";

export type AppOptions = {
  wsUrl: string;
  locale: string;
  micTarget: string; // plain capture device ("" = PipeWire default)
  spkTarget: string; // plain playback device ("" = default sink)
  aecSource: string; // fd_ec_source when echo-cancel.sh is on
  aecSink: string; // fd_ec_sink
  aecDefault: boolean; // start with the system AEC engaged (when available)
};

/** One row of the chat list — the DOM-node role `static/index.html` keeps in `#log`. */
type ChatNode = {
  row: ListBoxRow;
  cp: number | null; // rewind checkpoint (null ⇔ not stamped yet)
  isMsg: boolean; // a chat line (counts as a "message" for the rewind tally)
  bubble?: Box; // the bubble box (info lines and «interrotto» go inside it)
  body?: Label; // the bubble's text label (streamed answers grow it)
  rew?: Button; // the ⟲ button of this line (history lines only)
  infos: Label[]; // info lines under the body
};

type CmdCard = {
  node: ChatNode;
  head: Label;
  code: Label;
  why: Label | null;
  btns: Box | null;
  status: Label;
  outBtn: ToggleButton | null;
  outLabel: Label | null;
};

type ToolCard = {
  node: ChatNode;
  name: Label;
  sum: Label;
  badge: Label;
  inBlk: Widget;
  inPre: Label;
  outBlk: Widget;
  outPre: Label;
  meta: Label;
  done: boolean;
};

type ThinkBlock = {
  node: ChatNode;
  btn: ToggleButton;
  /** the reasoning as it streamed in (body holds the collapsed, cleaned peek) */
  raw: string;
  body: Label;
};

type TaskChip = {
  id: string;
  kind: "timer" | "command" | "watch";
  label: string;
  due: number | null;
  at: number;
  left: Label;
  chip: Box;
};

/**
 * Ø of the two circles, exactly as the web UI (14px header orb, 13px talk dot).
 * The widgets are bigger than that because the circle *scales up with the level*
 * (up to 1.9×), and a clipped disc would look like a flat top.
 */
const ORB_D = 14;
const MIC_D = 13;
const DOT_BOX = 30;

/**
 * The two level circles are painted in cairo, where no CSS reaches — so their
 * colours come from the same libadwaita named colours the stylesheet uses, read
 * back out of a widget's style context (see `themeRgba` in gtk-raw.ts).
 *
 * Each state gets the semantic colour the HIG would pick for it: green = the
 * mic hears you, accent = Sonia works, warning = something needs a decision,
 * dim = nothing is happening. `null` means "mix the two listed colours", which
 * keeps a few states apart without inventing a private palette.
 */
const ORB_COLOR: Record<string, [string, string?]> = {
  listening: ["success_color"],
  user: ["success_color"],
  thinking: ["accent_color"],
  // half warning, half error → orange: Sonia's voice, neither calm nor alarmed
  speaking: ["warning_color", "error_color"],
  confirm: ["warning_color"],
  paused: ["warning_color"],
  offline: ["insensitive_fg_color"],
  connecting: ["insensitive_fg_color"],
};

/** The footer's own accent — the user's accent colour, not a fixed violet. */
const MIC_COLOR = "accent_color";

/** Last resort if a theme lookup fails: a neutral grey that reads in both modes. */
const OFFLINE_RGB: [number, number, number] = [0.55, 0.55, 0.55];

/**
 * Sonia's stylesheet.
 *
 * Rules of the house, all of them libadwaita/HIG rather than a private look:
 *   • **no hard-coded colours.** Everything is a theme named colour
 *     (`@accent_color`, `@success_color`, `@window_bg_color`, …), so the app
 *     follows the light/dark preference and the user's accent without a line of
 *     TypeScript. Tints that have no named colour of their own are
 *     `@alpha(<colour>, <fraction>)` over the window background.
 *   • **type in `em`, never `px`.** One base size on `window` and every label,
 *     badge and code block is relative to it, so GNOME's text-scaling setting
 *     and our own smaller base both keep working.
 *   • **a 4pt spacing grid**, 6/9/12px radii, 28px controls — the HIG's own
 *     numbers for buttons, entries and cards.
 *   • **one visible focus ring** (`:focus-visible` → accent outline), which the
 *     flat buttons below would otherwise lose.
 */
const CSS = `
  /* ── base ────────────────────────────────────────────────────────────── */
  window {
    background: @window_bg_color;
    color: @theme_fg_color;
    /* the one knob that sets the app's text size: 0.85em of the desktop font,
       i.e. ~13px at 100% scaling — a touch above the 12px floor the HIG sets
       for secondary text, and every other size follows from this one */
    font-size: 0.85em;
  }
  .dim { color: @theme_fg_dim_color; }

  /* ── chat bubbles ────────────────────────────────────────────────────── */
  .bubble-user { background: @accent_bg_color; color: @accent_fg_color;
                 border-radius: 12px; padding: 6px 9px; }
  .bubble-bot  { background: alpha(@theme_fg_color, 0.06); color: @theme_fg_color;
                 border-radius: 12px; padding: 6px 9px; }

  /* secondary text: the HIG's ~85% step down from the base size */
  .info-line     { color: @theme_fg_dim_color; font-size: 0.88em; }
  .info-user     { color: alpha(@accent_fg_color, 0.8); font-size: 0.88em; }
  .event-line    { color: @theme_fg_dim_color; font-size: 0.92em; }
  .partial-line  { color: @accent_color; font-style: italic; }

  /* ── command & tool cards ────────────────────────────────────────────── */
  .card { background: alpha(@theme_fg_color, 0.03);
          border: 1px solid alpha(@theme_fg_color, 0.12);
          border-radius: 12px; padding: 6px 9px; }
  .card-pending { border-color: @warning_color; }
  .tool-card { background: alpha(@theme_fg_color, 0.02);
               border: 1px solid alpha(@theme_fg_color, 0.09);
               border-radius: 12px; padding: 5px 8px; }
  .tool-err    { border-color: @error_color; }
  .tool-blocked{ border-color: @warning_color; }
  .code { font-family: monospace; color: @warning_color; font-size: 0.95em; }
  .pre { font-family: monospace; font-size: 0.9em;
         background: alpha(black, 0.28);
         border: 1px solid alpha(@theme_fg_color, 0.08);
         padding: 5px 7px; border-radius: 6px; color: @theme_fg_color; }
  .think-body { font-family: monospace; font-size: 0.9em;
                background: alpha(black, 0.28);
                border-left: 2px solid @accent_color; border-radius: 6px;
                padding: 5px 7px; color: @theme_fg_dim_color; }
  .tool-name { color: @accent_color; font-weight: bold; }

  /* status badges: the HIG's semantic palette, never a private green/red */
  .badge-run     { color: @theme_fg_dim_color; font-size: 0.88em; }
  .badge-ok      { color: @success_color; font-size: 0.88em; }
  .badge-err     { color: @error_color; font-size: 0.88em; }
  .badge-blocked { color: @warning_color; font-size: 0.88em; }

  /* ── header ──────────────────────────────────────────────────────────── */
  .title-label { font-weight: bold; font-size: 1.05em; }
  .state-label { color: @theme_fg_dim_color; font-size: 0.92em; }
  .badge-pi { color: @success_color; font-size: 0.82em;
              border: 1px solid alpha(@success_color, 0.6);
              border-radius: 999px; padding: 0 6px; }
  /* web #ctxBox: pill with the bar and the numbers side by side, centred */
  .ctx-box { background: alpha(@theme_fg_color, 0.04);
             border: 1px solid alpha(@theme_fg_color, 0.12);
             border-radius: 999px; padding: 2px 8px 2px 7px; }
  .ctx-text { font-size: 0.85em; font-weight: bold; }
  /* Adwaita gives a horizontal progressbar a ~180px minimum, which made the ctx
     pill swallow the header and squeeze the title. Pin it (the trough selector is
     the one that actually carries the width). */
  progressbar.horizontal, progressbar.vertical { min-width: 40px; min-height: 6px; }
  progressbar.horizontal trough, progressbar.vertical trough {
    min-width: 40px; min-height: 6px; background: alpha(black, 0.3);
    border-radius: 999px; box-shadow: inset 0 0 0 1px alpha(@theme_fg_color, 0.15); }
  progressbar progress { background: @success_color; min-height: 6px; border-radius: 999px; }
  progressbar progress.warn { background: @warning_color; }
  progressbar progress.hot  { background: @error_color; }

  /* the model picker: a pill in the header, and in the popover a titled list */
  .model-pop-title { color: @theme_fg_dim_color; font-size: 0.88em; }
  .model-row { border-radius: 8px; padding: 2px 6px; }
  .model-row:hover { background: alpha(@theme_fg_color, 0.06); }
  .model-row-current { background: alpha(@accent_bg_color, 0.2); }
  .model-name { font-family: monospace; font-size: 0.9em; }
  .model-tick { color: @accent_color; font-weight: bold; font-size: 0.95em; }

  /* ── task banner ─────────────────────────────────────────────────────── */
  .task-chip { background: alpha(@theme_fg_color, 0.04);
               border: 1px solid alpha(@theme_fg_color, 0.12);
               border-radius: 999px; padding: 1px 2px 1px 9px; }
  .chip-left { color: @warning_color; font-weight: bold; font-size: 0.9em; }

  /* ── footer ──────────────────────────────────────────────────────────── */
  .footbar { background: alpha(black, 0.16);
             border-top: 1px solid alpha(@theme_fg_color, 0.1); padding: 6px 12px; }
  .hdrbar  { background: alpha(black, 0.16); }
  /* web: the orb is pinned to the title's first line, not centred on the
     two-line block, so it cannot drift when the state label below grows */
  .orb-dot { margin-top: 3px; }

  /* ── controls ────────────────────────────────────────────────────────── */
  /* Adwaita's defaults are sized for touch (46x34); the HIG's desktop minimum is
     28x28 with a 6px radius, which is what the icon rows here want. */
  button, togglebutton { border-radius: 6px; }
  .footbar button, .footbar togglebutton,
  .hdrbar button, .hdrbar togglebutton {
    min-width: 28px; min-height: 28px; padding: 0; margin: 0; border-radius: 6px; }
  .footbar button:hover, .footbar togglebutton:hover,
  .hdrbar button:hover, .hdrbar togglebutton:hover {
    background: alpha(@theme_fg_color, 0.08); }
  .hdrbar button, .hdrbar togglebutton {
    background: alpha(@theme_fg_color, 0.05);
    border: 1px solid alpha(@theme_fg_color, 0.1);
    color: @theme_fg_color; }
  .hdrbar button:disabled, .hdrbar togglebutton:disabled { opacity: 0.4; }

  /* the model picker is a pill: one border, not the double outline a
     GtkMenuButton's linked button+arrow pair would draw */
  .hdrbar .model-btn {
    background: alpha(@theme_fg_color, 0.04); border: 1px solid alpha(@theme_fg_color, 0.1);
    border-radius: 999px; padding: 0; margin: 0 2px; min-width: 0; }
  .hdrbar .model-btn:hover { background: alpha(@theme_fg_color, 0.08); }
  /* the model name is the one thing in the header a user reads on purpose, so
     this pill is a step bigger than the icon buttons beside it: full body size
     (not the shrunken one) and a 32px tall control, still inside the 47px bar */
  .hdrbar .model-btn label { font-size: 1em; }
  .hdrbar .model-btn button {
    background: transparent; border: none; border-radius: 0;
    min-width: 0; min-height: 32px; padding: 0 6px; }
  .hdrbar .model-btn button:first-child { padding-left: 12px; }
  .hdrbar .model-btn button:last-child  { padding-right: 8px; }

  /* compact input: 8px of horizontal padding and a 6px radius, per the HIG */
  entry { background: alpha(black, 0.2);
          border: 1px solid alpha(@theme_fg_color, 0.14);
          border-radius: 6px; padding: 4px 8px; color: @theme_fg_color;
          min-height: 20px; caret-color: @accent_color; }
  entry:focus { border-color: @accent_color; }

  /* ── flat, circular buttons ──────────────────────────────────────────── */
  .btn-flat { background: transparent; border: none; padding: 0; }
  .btn-flat:hover { background: alpha(@theme_fg_color, 0.08); }
  .btn-flat:disabled { opacity: 0.35; }
  .task-chip .btn-flat { min-width: 22px; min-height: 22px; margin: 0 2px;
                         border-radius: 999px; }
  .rew { min-width: 20px; min-height: 20px; padding: 0; margin: 0;
         border-radius: 999px; background: transparent; border: none;
         opacity: 0.4; font-size: 0.95em; }
  .rew:hover { opacity: 1; background: alpha(@theme_fg_color, 0.08); }
  .rew:disabled { opacity: 0.15; }

  /* ── lists ───────────────────────────────────────────────────────────── */
  list, listview, row { background: transparent; }

  /* ── focus ───────────────────────────────────────────────────────────── */
  /* HIG: keyboard focus must be obvious. The flat buttons above drop the
     theme's own ring, so every interactive widget gets the accent one. */
  button:focus, entry:focus, togglebutton:focus,
  listbox:focus, .rew:focus, .btn-flat:focus,
  .model-btn:focus {
    outline: 2px solid @accent_color; outline-offset: -2px; }
  .rew:focus, .btn-flat:focus { outline-offset: 1px; }

  /* ── accents kept as classes for the TypeScript side ─────────────────── */
  .accent { color: @accent_color; }
  .off { color: @warning_color; }
`;

export class SoniaApp {
  readonly i18n: I18n;
  private readonly app: Application;
  private readonly loop: EventLoop;

  // ── window & widgets ──
  private win!: ApplicationWindow;
  private orb!: DrawingArea;
  private stateLabel!: Label;
  private piBadge!: Label;
  private ctxBar!: ProgressBar;
  private ctxText!: Label;
  private ctxBox!: Box;
  private modelBtn!: MenuButton;
  private modelSearch!: SearchEntry;
  private modelPopTitle!: Label;
  private modelList!: ListBox;
  private voiceBtn!: ToggleButton;
  private refreshBtn!: Button;
  private settingsBtn!: Button;
  private taskBar!: Box;
  private chatScroll!: ScrolledWindow;
  private chatList!: ListBox;
  private partial!: Label;
  private textIn!: Entry;
  private sendBtn!: Button;
  private micBtn!: ToggleButton;
  private micDot!: DrawingArea;
  private prefs!: PreferencesWindow;
  private prefsSyncing = false;
  private swBarge!: SwitchRow;
  private swHalf!: SwitchRow;
  private swAec!: SwitchRow;
  private swThink!: SwitchRow;
  private swPi!: SwitchRow;
  private comboCmd!: ComboRow;
  private comboDecision!: ComboRow;
  private comboVoice!: ComboRow;
  private voiceMeta!: Label;
  private skillsGroup!: PreferencesGroup;
  private skillRows: SwitchRow[] = [];
  private skillEmpty: Label | null = null;

  // ── socket & protocol state ──
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private bannerTimer: ReturnType<typeof setInterval> | null = null;
  /** set in shutdown(): the window is gone, its widgets are freed — stop touching them */
  private closed = false;
  private takenOver = false;
  private resetBarrier = 0;
  private rewindPending = false;
  private modelRefreshPending = false;

  // ── chat model ──
  private nodes: ChatNode[] = [];
  private cards = new Map<string, CmdCard>();
  private lastReq: CmdCard | null = null;
  private toolCards = new Map<string, ToolCard>();
  private botBubble: ChatNode | null = null;
  private thinkBlock: ThinkBlock | null = null;
  private widthChars = 62;

  // ── banner ──
  private banner: TaskChip[] = [];

  // ── models/voices/skills ──
  private modelListNames: string[] = [];
  private currentModel = "";
  private viaPi = false;
  private modelQuery = "";
  private voiceList: string[] = [];
  private skills: SkillInfo[] = [];
  private skillsDir = "";

  // ── audio ──
  private readonly mic: Mic;
  private readonly speaker = new Speaker(60);
  private rate = 24000;
  private micOn = true;
  private voiceOn = true;
  private aecOn = false;
  private micPeak = 0;
  private dotLvl = 0;
  private orbLvl = 0;
  /** memoised libadwaita named colours for the two cairo circles */
  private readonly themeCache = new Map<string, [number, number, number]>();
  private themeAge = 0; // ticks since the cache was last dropped (~1s)
  private state: StateName | "connecting" = "connecting";

  constructor(private readonly opts: AppOptions) {
    this.i18n = makeI18n(opts.locale === "en" ? "en" : "it");
    this.mic = new Mic(opts.micTarget);
    // GApplication is single-instance per id on the session D-Bus: a second
    // `bun run gtk4` with this id would only forward its activation to the first
    // window (no window, no socket, no error). SONIA_GTK4_APP_ID lets a test
    // instance run next to the real one.
    this.app = new Application(
      process.env.SONIA_GTK4_APP_ID || "it.sonia.Assistant",
      ApplicationFlags.NONE,
    );
    this.loop = new EventLoop({ pollInterval: 16 });
    this.aecOn = opts.aecDefault && opts.aecSource !== "";
    this.app.onActivate(() => this.buildUI());
  }

  private t = (key: string): string => this.i18n.t(key);
  private tf = (key: string, vars: Record<string, unknown>): string => this.i18n.tf(key, vars);

  async run(): Promise<void> {
    await this.loop.start(this.app);
  }

  stop(): void {
    this.loop.stop();
  }

  // ───────────────────────────── UI construction ─────────────────────────────

  private buildUI(): void {
    // no forced dark: every colour below comes from the theme, so following the
    // user's light/dark preference (and their accent) is both correct and free
    StyleManager.getDefault().setColorScheme(ColorScheme.DEFAULT);
    const display = Display.getDefault();
    if (display) {
      const css = new CssProvider();
      css.loadFromData(CSS);
      StyleContext.addProviderForDisplay(display, css, StyleProviderPriority.APPLICATION);
    }

    const win = new ApplicationWindow(this.app);
    this.win = win;
    win.setTitle("Sonia");
    // 560x620 fits a 1366x768 screen (and half of a 1280x800 one) with the
    // panel and taskbar taken, where 720x760 did not: the chat is the only part
    // that grows, and it scrolls. HIG asks for a size that works on the smallest
    // supported screen, not for the biggest that looks good on a large one.
    win.setDefaultSize(560, 620);
    // the 💭 block and the partial line size themselves in chars: on a narrow or
    // resized window a fixed 90-char label is wider than the window and pushes it
    // wider, which is how the reasoning box used to resize the window. Recompute
    // the budget from the real width whenever it changes.
    const remeasure = () => this.applyWidthBudget();
    win.connect("notify::default-width", remeasure);
    win.connect("notify::width", remeasure);
    this.widthChars = this.charsFor(0);
    applyWindowIcon(win);

    const root = new Box(Orientation.VERTICAL, 0);
    win.setChild(root);

    root.append(this.buildHeader());
    this.taskBar = new Box(Orientation.VERTICAL, 6);
    this.taskBar.setMarginStart(14);
    this.taskBar.setMarginEnd(14);
    this.taskBar.setMarginTop(6);
    this.taskBar.setVisible(false);
    root.append(this.taskBar);

    // ── chat ──
    this.chatList = new ListBox();
    this.chatList.setSelectionMode(SelectionMode.NONE);
    this.chatList.addCssClass("chat");
    this.chatScroll = new ScrolledWindow();
    this.chatScroll.setPolicy(PolicyType.NEVER, PolicyType.AUTOMATIC);
    this.chatScroll.setMarginStart(14);
    this.chatScroll.setMarginEnd(14);
    this.chatScroll.setChild(this.chatList);
    this.chatScroll.setVexpand(true);
    root.append(this.chatScroll);

    this.partial = new Label("");
    this.partial.addCssClass("partial-line");
    this.partial.setHalign(Align.START);
    this.partial.setMarginStart(18);
    this.partial.setMarginEnd(18);
    this.partial.setEllipsize(3); // PANGO_ELLIPSIZE_END
    this.partial.setProperty("max-width-chars", this.widthChars);
    root.append(this.partial);

    root.append(this.buildFooter());

    this.prefs = this.buildPrefs();
    // make the drawer a child of the main window: the WM then places it centred
    // on the parent instead of floating wherever it feels like (it used to open
    // off to the right, half off-screen on small desktops)
    this.prefs.setTransientFor(win);

    win.onCloseRequest(() => {
      this.shutdown();
      this.loop.stop();
      return false;
    });

    // levels + banner timers (EventLoop integrates GLib with the JS loop)
    // ~30 fps: a pulsing ring needs a smooth redraw, not a 10 fps step.
    // setInterval fires from Bun's loop, outside GLib's iteration: hop back
    // into the GTK main loop before touching a widget (see onGtkIdle).
    this.levelTimer = setInterval(() => onGtkIdleOnce("levels", () => this.tickLevels()), 33);
    this.bannerTimer = setInterval(() => onGtkIdleOnce("banner", () => this.tickBanner()), 500);

    // the mic's own signals, set once: a stream that ends without stop() is pw-record
    // dying (device gone, PipeWire restarted, bad --target) → say so, then come back.
    // Audio frames arrive on a child-process stdout callback, never inside a GTK
    // step — same hop into the main loop, coalesced (only the newest frame counts).
    this.mic.onFrame = (f) => onGtkIdleOnce("mic", () => this.onMicFrame(f));
    this.mic.onEnd = (err) => {
      this.addEvent(`🎤 ${err}`);
      setTimeout(() => {
        if (this.micOn && !this.takenOver) this.mic.start();
      }, 2000);
    };

    this.applyAudioTargets(false);
    this.win.present();
    this.setState("connecting");
    this.connect();
  }

  private buildHeader(): Widget {
    const bar = new HeaderBar();
    bar.addCssClass("hdrbar");

    // orb + title + state
    const titleBox = new Box(Orientation.VERTICAL, 0);
    const row1 = new Box(Orientation.HORIZONTAL, 8);
    this.orb = new DrawingArea();
    // same footprint as the footer's mic dot: the two circles are meant to read
    // as a pair, one per speaker
    this.orb.addCssClass("orb-dot");
    this.orb.setContentWidth(DOT_BOX);
    this.orb.setContentHeight(DOT_BOX);
    this.orb.setValign(Align.START);
    this.orb.setDrawFunc((_a, cr, w, h) => this.drawOrb(cr, w, h));
    row1.append(this.orb);
    const title = new Label(this.t("ui.title"));
    title.addCssClass("title-label");
    // narrow window: the title gives way (ellipsis) instead of pushing the
    // model pill and the header buttons off the right edge
    title.setEllipsize(3); // PANGO_ELLIPSIZE_END
    title.setHexpand(true);
    title.setSizeRequest(56, -1);
    row1.append(title);
    this.piBadge = new Label("pi CLI");
    this.piBadge.addCssClass("badge-pi");
    this.piBadge.setVisible(false);
    row1.append(this.piBadge);
    this.ctxBox = new Box(Orientation.HORIZONTAL, 7); // web: #ctxBox gap 7px
    this.ctxBox.addCssClass("ctx-box");
    this.ctxBox.setValign(Align.CENTER); // the pill lines up with the title row
    this.ctxBar = new ProgressBar();
    this.ctxBar.setSizeRequest(48, 8); // web: #ctxBar is a short, fixed bar
    this.ctxBar.setHexpand(false);
    this.ctxBar.setValign(Align.CENTER);
    this.ctxText = new Label("");
    this.ctxText.addCssClass("ctx-text");
    this.ctxText.setValign(Align.CENTER);
    this.ctxBox.append(this.ctxBar);
    this.ctxBox.append(this.ctxText);
    this.ctxBox.setVisible(false);
    this.ctxBox.setTooltipText(this.t("ctx.title.short"));
    row1.append(this.ctxBox);
    titleBox.append(row1);

    // The state is the title's *subtitle*: HIG style, one column of text under
    // another, and it keeps the state colour next to the name it describes.
    // Indented by the orb's box + the row gap so it lines up with the title's
    // text, not with the orb's left edge.
    this.stateLabel = new Label("");
    this.stateLabel.addCssClass("state-label");
    this.stateLabel.setHalign(Align.START);
    this.stateLabel.setEllipsize(3); // PANGO_ELLIPSIZE_END
    this.stateLabel.setMarginStart(DOT_BOX + 8);
    titleBox.append(this.stateLabel);
    // `setTitleWidget` cannot pin this to the left: a GtkHeaderBar lays the
    // title widget out in a *centre box*, so a wide window parks the whole block
    // in the middle (halign/hexpand on the widget change nothing). Packing it
    // as a start child puts it on the left edge for good, and the buttons stay
    // on the right.
    bar.packStart(titleBox);
    // the centre slot is free now; without this the window title pops up there
    bar.setProperty("show-title", false);

    // end: model ↻ ⚙ 🔊 — packed last below, so it ends up left of the model pill
    this.voiceBtn = new ToggleButton();
    this.voiceBtn.setIconName("audio-volume-high-symbolic");
    this.voiceBtn.setActive(true);
    this.voiceBtn.setTooltipText(this.t("hdr.voice.title"));
    this.voiceBtn.setValign(Align.CENTER); // square, not stretched by the header height
    this.voiceBtn.onToggled(() => this.setVoiceOn(this.voiceBtn.getActive()));

    this.settingsBtn = new Button();
    this.settingsBtn.setIconName("preferences-system-symbolic"); // ⚙ not ☰ — it opens the preferences
    this.settingsBtn.setTooltipText(this.t("set.title"));
    this.settingsBtn.setValign(Align.CENTER);
    this.settingsBtn.onClick(() => {
      this.send({ type: "models_refresh", force: false });
      this.send({ type: "skills_refresh" });
      // present() lets the WM centre the transient child over the main window;
      // a second click hides it again (close is intercepted in buildPrefs)
      if (this.prefs.getVisible()) {
        this.prefs.setVisible(false);
      } else {
        this.prefs.present();
      }
    });
    bar.packEnd(this.settingsBtn);

    this.refreshBtn = new Button();
    this.refreshBtn.setIconName("view-refresh-symbolic");
    this.refreshBtn.setTooltipText(this.t("hdr.refresh.title"));
    this.refreshBtn.setValign(Align.CENTER);
    this.refreshBtn.onClick(() => {
      if (this.modelRefreshPending) return;
      this.modelRefreshPending = true;
      this.refreshBtn.setSensitive(false);
      this.send({ type: "models_refresh", force: true });
      setTimeout(() => {
        this.modelRefreshPending = false;
        this.refreshBtn.setSensitive(true);
      }, 8000);
    });
    bar.packEnd(this.refreshBtn);

    // the model picker: a button + a searchable popover (the web UI types into the
    // <select>; GTK has no such control, so the filter gets its own search entry)
    this.modelBtn = new MenuButton();
    this.modelBtn.addCssClass("model-btn");
    this.modelBtn.setLabel("…");
    this.modelBtn.setTooltipText(this.t("model.api.title"));
    this.modelBtn.setValign(Align.CENTER);
    const pop = new Popover();
    const popBox = new Box(Orientation.VERTICAL, 6);
    popBox.setMarginTop(8);
    popBox.setMarginBottom(8);
    popBox.setMarginStart(8);
    popBox.setMarginEnd(8);
    popBox.setSizeRequest(380, -1); // model names are long: give them room
    this.modelPopTitle = new Label("");
    this.modelPopTitle.addCssClass("model-pop-title");
    this.modelPopTitle.setHalign(Align.START);
    this.modelPopTitle.setMarginStart(6);
    popBox.append(this.modelPopTitle);
    this.modelSearch = new SearchEntry();
    // GTK 4.24: GtkSearchEntry derives from GtkWidget (only GtkEditable), so
    // Entry's setPlaceholderText() asserts GTK_IS_ENTRY — set the property.
    this.modelSearch.setProperty("placeholder-text", this.t("model.aria"));
    this.modelSearch.onChanged(() => {
      this.modelQuery = this.modelSearch.getText();
      this.rebuildModelRows();
    });
    this.modelSearch.onActivate(() => {
      const first = this.firstModelRow();
      if (first) {
        const name = this.rowLabel(first);
        if (name) this.pickModel(name);
        pop.popdown();
      }
    });
    popBox.append(this.modelSearch);
    const listScroll = new ScrolledWindow();
    listScroll.setPolicy(PolicyType.NEVER, PolicyType.AUTOMATIC);
    listScroll.setMinContentHeight(240);
    this.modelList = new ListBox();
    this.modelList.setSelectionMode(SelectionMode.NONE);
    this.modelList.onRowActivated((row) => {
      const name = this.rowLabel(row);
      if (name) {
        this.pickModel(name);
        pop.popdown();
      }
    });
    listScroll.setChild(this.modelList);
    popBox.append(listScroll);
    pop.setChild(popBox);
    this.modelBtn.setPopover(pop);
    bar.packEnd(this.modelBtn);
    // packed last ⇒ packEnd stacks right-to-left, so the voice toggle ends up
    // immediately to the left of the model pill
    bar.packEnd(this.voiceBtn);

    // AdwHeaderBar draws its own window controls (a close button) at the end of
    // the bar unless you ask it not to — and with our `.hdrbar button` styling it
    // looked exactly like one of ours. The WM already gives us traffic lights.
    bar.setProperty("show-end-title-buttons", false);
    bar.setProperty("show-start-title-buttons", false);

    return bar;
  }

  private firstModelRow(): ListBoxRow | null {
    const first = this.modelList.getFirstChild();
    return first instanceof ListBoxRow ? first : null;
  }

  private rowLabel(row: ListBoxRow): string | null {
    const tag = row.getData("model");
    if (tag) return tag;
    const child = row.getChild();
    return child instanceof Label ? child.getText() : null;
  }

  private buildFooter(): Widget {
    const foot = new Box(Orientation.HORIZONTAL, 8); // web: footer grid gap 8px
    foot.addCssClass("footbar");
    this.micDot = new DrawingArea();
    this.micDot.setContentWidth(DOT_BOX);
    this.micDot.setContentHeight(DOT_BOX);
    this.micDot.setValign(Align.CENTER);
    this.micDot.setDrawFunc((_a, cr, w, h) => this.drawDot(cr, w, h));
    foot.append(this.micDot);

    this.textIn = new Entry();
    this.textIn.setPlaceholderText(this.t("ft.input.ph"));
    this.textIn.setHexpand(true);
    this.textIn.onActivate(() => this.sendText());
    foot.append(this.textIn);

    this.sendBtn = new Button();
    this.sendBtn.setIconName("go-next-symbolic"); // ➤ not a paper plane
    this.sendBtn.setTooltipText(this.t("ft.send.title"));
    this.sendBtn.onClick(() => this.sendText());
    this.sendBtn.setValign(Align.CENTER);
    foot.append(this.sendBtn);

    this.micBtn = new ToggleButton();
    this.micBtn.setIconName("microphone-sensitivity-high-symbolic");
    this.micBtn.setActive(true);
    this.micBtn.setTooltipText(this.t("ft.mic.title"));
    this.micBtn.onToggled(() => this.setMicOn(this.micBtn.getActive()));
    this.micBtn.setValign(Align.CENTER);
    foot.append(this.micBtn);

    const stopBtn = new Button();
    stopBtn.setIconName("media-playback-stop-symbolic");
    stopBtn.setTooltipText(this.t("ft.stop.title"));
    stopBtn.onClick(() => this.send({ type: "stop" }));
    stopBtn.setValign(Align.CENTER);
    foot.append(stopBtn);

    const resetBtn = new Button();
    applyIcon(resetBtn, "sonia-sweep-symbolic", "edit-clear-all-symbolic"); // sweep the chat
    resetBtn.setTooltipText(this.t("ft.reset.title"));
    resetBtn.onClick(() => {
      this.send({ type: "reset" });
      this.resetBarrier = Date.now() + 4000; // stale events keep leaking until the ack
      this.clearChat();
      this.addEvent(this.t("msg.newChat"));
    });
    resetBtn.setValign(Align.CENTER);
    foot.append(resetBtn);

    return foot;
  }

  private buildPrefs(): PreferencesWindow {
    const win = new PreferencesWindow();
    win.setTitle(this.t("set.title"));
    // labwc gives a fresh window ~300x290, which clips the page: the groups
    // below "reply" and the skills list end up invisible.
    win.setDefaultSize(460, 660);
    const page = new PreferencesPage();

    // ascolto
    const gListen = new PreferencesGroup();
    gListen.setTitle(this.t("set.grp.listen"));
    this.swBarge = new SwitchRow();
    this.swBarge.setTitle("barge-in");
    this.swBarge.setSubtitle(this.t("set.barge.sub"));
    this.swBarge.setTooltipText(this.t("set.barge.title"));
    this.swBarge.onActiveChanged((v) => {
      if (!this.prefsSyncing) this.send({ type: "config", barge_in: v });
    });
    gListen.add(this.swBarge);
    this.swHalf = new SwitchRow();
    this.swHalf.setTitle("half-duplex");
    this.swHalf.setSubtitle(this.t("set.half.sub"));
    this.swHalf.setTooltipText(this.t("set.half.title"));
    this.swHalf.onActiveChanged((v) => {
      if (!this.prefsSyncing) this.send({ type: "config", half_duplex: v });
    });
    gListen.add(this.swHalf);
    this.swAec = new SwitchRow();
    this.swAec.setTitle("AEC");
    this.swAec.setSubtitle(this.t("set.aec.sub"));
    this.swAec.setTooltipText(this.t("set.aec.title"));
    this.swAec.onActiveChanged((v) => {
      if (this.prefsSyncing) return;
      if (v && this.opts.aecSource === "") {
        this.addEvent(this.t("aec.missing"));
        this.prefsSyncing = true;
        this.swAec.setActive(false);
        this.prefsSyncing = false;
        return;
      }
      this.aecOn = v;
      this.applyAudioTargets(true);
    });
    gListen.add(this.swAec);
    page.add(gListen);

    // voce
    const gVoice = new PreferencesGroup();
    gVoice.setTitle(this.t("set.grp.voice"));
    this.comboVoice = new ComboRow();
    this.comboVoice.setTitle(this.t("set.voice"));
    this.comboVoice.setModel(new StringList());
    this.comboVoice.onSelectedChanged((i) => {
      if (!this.prefsSyncing && this.voiceList[i]) {
        this.send({ type: "config", tts_voice: this.voiceList[i]! });
      }
    });
    gVoice.add(this.comboVoice);
    this.voiceMeta = new Label("");
    this.voiceMeta.addCssClass("dim");
    gVoice.add(this.voiceMeta);
    page.add(gVoice);

    // risposta
    const gReply = new PreferencesGroup();
    gReply.setTitle(this.t("set.grp.reply"));
    this.swThink = new SwitchRow();
    this.swThink.setTitle(this.t("think.label"));
    this.swThink.setSubtitle(this.t("set.think.sub"));
    this.swThink.setTooltipText(this.t("set.think.title"));
    this.swThink.onActiveChanged((v) => {
      if (!this.prefsSyncing) this.send({ type: "config", thinking: v });
    });
    gReply.add(this.swThink);
    this.swPi = new SwitchRow();
    this.swPi.setTitle("pi CLI");
    this.swPi.setSubtitle(this.t("set.pi.sub"));
    this.swPi.setTooltipText(this.t("set.pi.title"));
    this.swPi.onActiveChanged((v) => {
      if (!this.prefsSyncing) this.send({ type: "config", llm_via_pi: v });
    });
    gReply.add(this.swPi);
    page.add(gReply);

    // comandi
    const gCmd = new PreferencesGroup();
    gCmd.setTitle(this.t("set.grp.cmd"));
    this.comboCmd = new ComboRow();
    this.comboCmd.setTitle("bash");
    this.comboCmd.setModel(
      new StringList([this.t("opt.ask"), this.t("opt.auto"), this.t("opt.off")]),
    );
    this.comboCmd.onSelectedChanged((i) => {
      const v = ["ask", "auto", "off"][i];
      if (!this.prefsSyncing && v)
        this.send({ type: "config", cmd_mode: v as "ask" | "auto" | "off" });
    });
    gCmd.add(this.comboCmd);
    this.comboDecision = new ComboRow();
    this.comboDecision.setTitle(this.t("set.turn"));
    this.comboDecision.setModel(
      new StringList([this.t("opt.auto"), this.t("opt.always"), this.t("opt.off")]),
    );
    this.comboDecision.onSelectedChanged((i) => {
      const v = ["auto", "always", "off"][i];
      if (!this.prefsSyncing && v) {
        this.send({
          type: "config",
          decision_mode: v as "auto" | "always" | "off",
        });
      }
    });
    gCmd.add(this.comboDecision);
    page.add(gCmd);

    // skills
    this.skillsGroup = new PreferencesGroup();
    this.skillsGroup.setTitle("skills");
    this.skillsGroup.setDescription(this.t("skills.title"));
    page.add(this.skillsGroup);

    win.add(page);
    // A closed AdwWindow does not come back with present() — the second ⚙ click
    // did nothing at all. Keep the object alive and just unmap it, then the
    // button can always show it again.
    win.onCloseRequest(() => {
      win.setVisible(false);
      return true; // block the default close
    });
    return win;
  }

  /**
   * The two level circles, drawn with the web UI's formula so they look like the
   * same objects in the browser:
   *
   *   diameter = Ø · (1 + level · grow)      opacity = .4 + level · .6
   *   glow     = level-scaled halo around the disc
   *
   * The header one grows like `#orb` (.55) and wears the state colour — it is
   * Sonia's voice; the footer one grows like `#talkDot` (.9) and stays blue —
   * it is your microphone.
   */
  private drawLevelDot(
    cr: CairoContext,
    w: number,
    h: number,
    color: [number, number, number],
    level: number,
    live: boolean,
    grow: number,
    radius: number,
  ): void {
    const [r, g, b] = color;
    const cx = w / 2;
    const cy = h / 2;
    const lvl = live ? Math.min(1, level) : 0;
    const base = radius; // the Ø the web draws, in px
    const rad = base * (1 + lvl * grow); // same scale() as the web
    const alpha = live ? 0.4 + 0.6 * lvl : 0.22;

    // glow: two soft halos, both scaling with the level
    for (let i = 1; i <= 2; i++) {
      const gr = rad * (1 + i * 0.45);
      if (gr > Math.min(w, h) / 2) break;
      cr.setSourceRgba(r, g, b, alpha * 0.18 * lvl * (3 - i));
      cr.arc(cx, cy, gr, 0, 2 * Math.PI);
      cr.fill();
    }
    cr.setSourceRgba(r, g, b, alpha);
    cr.arc(cx, cy, rad, 0, 2 * Math.PI);
    cr.fill();
  }

  /** Header circle: Sonia's voice, coloured by the current state. */
  private drawOrb(cr: CairoContext, w: number, h: number): void {
    const live = this.state === "speaking" || this.state === "listening";
    const spec = ORB_COLOR[this.state] ?? ORB_COLOR.connecting!;
    const rgb = this.themeColor(spec[0], spec[1]) ?? OFFLINE_RGB;
    this.drawLevelDot(cr, w, h, rgb, this.orbLvl, live && this.voiceOn, 0.55, ORB_D / 2);
  }

  /** Footer circle: your microphone, always the accent colour, always the input level. */
  private drawDot(cr: CairoContext, w: number, h: number): void {
    this.drawLevelDot(
      cr,
      w,
      h,
      this.themeColor(MIC_COLOR) ?? OFFLINE_RGB,
      this.dotLvl,
      this.micOn && !this.takenOver,
      0.9,
      MIC_D / 2,
    );
  }

  /**
   * A theme named colour as RGB for cairo, memoised per name and re-read once
   * a second (see `tickLevels`): the circles are redrawn 30×/s and a style-context
   * lookup is far too expensive for that, while the accent colour only changes
   * when the user (or the OS) switches theme or light/dark. Passing a second
   * name mixes the two colours, which is how "speaking" keeps its own hue
   * without the app carrying a palette of its own.
   */
  private themeColor(name: string, mixWith?: string): [number, number, number] | null {
    const hit = this.themeCache.get(name);
    if (hit) return hit;
    const ref = this.orb ?? this.micDot;
    if (!ref) return null;
    const c = themeRgba(ref, name);
    if (!c) return null;
    let rgb: [number, number, number] = [c[0], c[1], c[2]];
    if (mixWith) {
      const m = themeRgba(ref, mixWith);
      if (m)
        rgb = [rgb[0] * 0.5 + m[0] * 0.5, rgb[1] * 0.5 + m[1] * 0.5, rgb[2] * 0.5 + m[2] * 0.5];
    }
    this.themeCache.set(name, rgb);
    return rgb;
  }

  /** Fast attack / slow release, same shape as the web UI's rAF loop. */
  private tickLevels(): void {
    if (this.closed) return;
    this.micPeak *= 0.85; // decays between two capture frames
    this.dotLvl =
      this.micOn && !this.takenOver && this.micPeak > this.dotLvl
        ? this.micPeak
        : this.dotLvl * 0.82;
    const bot = this.voiceOn ? this.speaker.lastRms : 0;
    this.speaker.lastRms *= 0.6;
    this.orbLvl = bot > this.orbLvl ? bot : this.orbLvl * 0.82;
    // the cached theme colours age out on their own: a light/dark flip or an
    // accent change must not leave the circles painted in the old palette
    if (++this.themeAge >= 30) {
      this.themeAge = 0;
      this.themeCache.clear();
    }
    // both dots are level-driven (mic down, voice up) and the header one also
    // follows the state colour, so redraw them on every tick
    this.micDot.queueDraw();
    this.orb.queueDraw();
  }

  // ───────────────────────────── chat rendering ─────────────────────────────

  private appendRow(row: ListBoxRow): void {
    this.chatList.append(row);
    this.scrollToBottom();
  }

  private scrollToBottom(force = false): void {
    // jsGTK's `getVadjustment()` is broken under Bun (numeric pointers read as
    // adjustment *values*) — see gtk-raw.ts; use the raw wrapper there instead.
    const adj = vadjustmentOf(this.chatScroll);
    const near = adj.getValue() + adj.getPageSize() >= adj.getUpper() - 120;
    if (force || near) adj.setValue(adj.getUpper());
  }

  private addMsg(kind: "user" | "bot", text: string, info?: string, cp?: number): ChatNode {
    const row = new ListBoxRow();
    const outer = new Box(Orientation.HORIZONTAL, 4);
    outer.setMarginTop(5);
    outer.setMarginBottom(5);
    const bubble = new Box(Orientation.VERTICAL, 2);
    bubble.addCssClass(kind === "user" ? "bubble-user" : "bubble-bot");
    const body = sel(new Label(text));
    body.setWrap(true);
    body.setXalign(0);
    // web: .msg max-width 78% — GTK4 has no percentage for that, so the wrap
    // width is capped on the label (only GtkLabel has this property: setting it
    // on the Box asserted "object class 'GtkBox' has no property named …")
    body.setProperty("max-width-chars", 62);
    bubble.append(body);
    const node: ChatNode = {
      row,
      cp: cp ?? null,
      isMsg: true,
      bubble,
      body,
      infos: [],
    };
    // The ⟲ always sits immediately left of the bubble — for the user's line too, so
    // the control never jumps sides as the conversation goes back and forth. Only the
    // group's alignment changes (user right, bot left); the order never does.
    node.rew = this.rewindBtn(node);
    outer.append(node.rew);
    outer.append(bubble);
    if (kind === "user") {
      outer.setHalign(Align.END);
      outer.setHexpand(true);
    } else {
      outer.setHalign(Align.START);
    }
    row.setChild(outer);
    if (info) this.infoLine(node, info, kind);
    if (cp !== undefined && cp !== null) this.stampLine(node, cp);
    this.nodes.push(node);
    this.appendRow(row);
    return node;
  }

  private infoLine(node: ChatNode, text: string, kind: "user" | "bot" = "bot"): Label {
    const l = sel(new Label(text));
    l.addCssClass(kind === "user" ? "info-user" : "info-line");
    l.setHalign(Align.START);
    l.setWrap(true);
    node.infos.push(l);
    node.bubble?.append(l); // the info line lives under the bubble's body
    return l;
  }

  /** The ⟲ button: one per history line; disabled while a rewind is in flight. */
  private rewindBtn(owner: ChatNode): Button {
    const b = new Button("⟲");
    b.addCssClass("rew");
    b.setTooltipText(this.t("msg.rew.title"));
    b.setSensitive(!this.rewindPending);
    b.onClick(() => {
      if (this.rewindPending) return;
      const cp = owner.cp;
      if (cp === null) return;
      if (!this.send({ type: "rewind", id: cp })) return;
      this.setRewindEnabled(false);
      setTimeout(() => {
        if (this.rewindPending) this.setRewindEnabled(true); // no ack: buttons come back
      }, 4000);
    });
    return b;
  }

  private stampLine(node: ChatNode, cp: number): void {
    node.cp = cp;
  }

  private addEvent(text: string): void {
    if (this.closed) return;
    const row = new ListBoxRow();
    const l = sel(new Label(text));
    l.addCssClass("event-line");
    l.setWrap(true);
    l.setHalign(Align.CENTER);
    row.setChild(l);
    this.nodes.push({ row, cp: null, isMsg: false, infos: [] });
    this.appendRow(row);
  }

  private botAppend(sentence: string): void {
    if (!this.botBubble?.body) {
      this.botBubble = this.addMsg("bot", "");
    }
    const cur = this.botBubble.body!.getText();
    this.botBubble.body!.setText(`${cur} ${sentence}`.trim());
    this.scrollToBottom();
  }

  private botInfo(text: string): void {
    if (!this.botBubble) {
      this.addEvent(text);
      return;
    }
    this.infoLine(this.botBubble, text);
    this.scrollToBottom();
  }

  // ── ⟲ rewind — ported from the web UI, rule for rule ──

  private setRewindEnabled(on: boolean): void {
    this.rewindPending = !on;
    // GTK has no :hover affordance: every ⟲ button shows its state directly
    for (const n of this.nodes) n.rew?.setSensitive(on);
  }

  private onRewound(ev: Extract<ServerEvent, { type: "chat_rewound" }>): void {
    this.setRewindEnabled(true);
    if (!ev.ok) {
      this.addEvent(this.t("msg.rew.lost"));
      return;
    }
    const alive = new Set(
      (ev.history || [])
        .filter((m) => m.id !== undefined && m.id !== null)
        .map((m) => Number(m.id)),
    );
    const cp = (n: ChatNode) => (n.cp !== null ? Number(n.cp) : null);
    // first line the server dropped — without it nothing shown here was cut at all
    const dead = this.nodes.findIndex((n) => cp(n) !== null && !alive.has(cp(n)!));
    if (dead < 0) {
      this.addEvent(this.tf("msg.rew.done", { n: 0 }));
      return;
    }
    // …but the cut goes *after the last line the server kept*: the drop is a suffix of
    // the transcript, while a line can be dead for another reason too — cutting at the
    // first dead line would take kept turns with it.
    let lastAlive = -1;
    this.nodes.forEach((n, i) => {
      const id = cp(n);
      if (id !== null && alive.has(id)) lastAlive = i;
    });
    const cut = Math.max(dead, lastAlive + 1);
    let dropped = 0;
    for (let i = this.nodes.length - 1; i >= cut; i--) {
      const n = this.nodes[i]!;
      if (n.isMsg) dropped++;
      detach(this.chatList, n.row);
      this.nodes.pop();
    }
    // the card maps would keep handing back unmounted entries: drop the dead keys
    for (const [k, c] of this.cards) if (!this.nodes.includes(c.node)) this.cards.delete(k);
    for (const [k, c] of this.toolCards) if (!this.nodes.includes(c.node)) this.toolCards.delete(k);
    if (this.botBubble && !this.nodes.includes(this.botBubble)) this.botBubble = null;
    if (this.thinkBlock && !this.nodes.includes(this.thinkBlock.node)) this.thinkBlock = null;
    this.addEvent(this.tf("msg.rew.done", { n: dropped }));
  }

  // ── 💭 reasoning ──

  private onReasoning(text: string): void {
    if (!this.thinkBlock) {
      const row = new ListBoxRow();
      const box = new Box(Orientation.VERTICAL, 2);
      const btn = new ToggleButton();
      btn.addCssClass("btn-flat");
      btn.setHalign(Align.START);
      // the button label stays short (a GtkButton label does not wrap, and a long
      // one makes the window wider); the peek lives in the clamped body below
      const body = sel(new Label(""));
      body.addCssClass("think-body");
      body.setWrap(true);
      body.setXalign(0);
      body.setVisible(false);
      body.setProperty("max-width-chars", this.widthChars);
      btn.onToggled(() => {
        body.setVisible(btn.getActive());
        this.updateThinkLabel(this.thinkBlock!);
      });
      box.append(btn);
      box.append(body);
      row.setChild(box);
      this.thinkBlock = {
        node: { row, cp: null, isMsg: false, infos: [] },
        btn,
        raw: "",
        body,
      };
      this.nodes.push(this.thinkBlock.node);
      this.appendRow(row);
    }
    const tb = this.thinkBlock;
    tb.raw += text;
    this.updateThinkLabel(tb);
    this.scrollToBottom();
  }

  private updateThinkLabel(tb: NonNullable<ThinkBlock>): void {
    const full = tb.raw;
    // short on the button (a GtkButton label does not wrap, so a long peek would
    // make the window wider); the full text lives in the body, which wraps and
    // is clamped to the window width
    tb.btn.setLabel(`💭 ${this.t("think.label")} ${this.tf("think.chars", { n: full.length })}`);
    tb.body.setText(full.trimStart());
  }

  /** chars that fit the window, minus margins + an ellipsize margin */
  private charsFor(width: number): number {
    const w = width > 100 ? width : 560;
    return Math.max(28, Math.min(90, Math.floor((w - 60) / 7.2)));
  }

  /** re-clamp every width-driven label after a window resize */
  private applyWidthBudget(): void {
    const w = Number(this.win.getProperty("width") ?? 0);
    this.widthChars = this.charsFor(w);
    this.partial.setProperty("max-width-chars", this.widthChars);
    const tb = this.thinkBlock;
    if (tb) {
      tb.body.setProperty("max-width-chars", this.widthChars);
      this.updateThinkLabel(tb);
    }
  }

  // ───────────────────────────── banner (tasks) ─────────────────────────────

  private onTasks(list: readonly TaskInfo[] | undefined): void {
    const arr = Array.isArray(list) ? list : [];
    // rebuild the whole banner: the server sends it whole, on every change
    for (const chip of this.banner) detach(this.taskBar, chip.chip);
    this.banner = arr.map((task) => {
      const chip = new Box(Orientation.HORIZONTAL, 8);
      chip.addCssClass("task-chip");
      chip.setHalign(Align.START);
      chip.setHexpand(false); // the chip hugs its content, it is not a banner bar
      ico(chip, task.kind === "timer" ? "⏳" : task.kind === "watch" ? "🔁" : "💻");
      const lbl = new Label(String(task.label ?? ""));
      lbl.setEllipsize(3);
      lbl.setProperty("max-width-chars", 46);
      lbl.setTooltipText(String(task.label ?? ""));
      chip.append(lbl);
      const left = new Label("");
      left.addCssClass("chip-left");
      chip.append(left);
      const x = new Button("✕");
      x.addCssClass("btn-flat");
      x.setTooltipText(this.tf("tasks.cancelAria", { label: task.label ?? "" }));
      x.onClick(() => {
        x.setSensitive(false);
        this.send({ type: "task_cancel", id: String(task.id) });
        setTimeout(() => x.setSensitive(true), 2500); // no ack → another try, not a dead ✕
      });
      chip.append(x);
      this.taskBar.append(chip);
      const due =
        task.due_in_ms === undefined || task.due_in_ms === null ? null : Number(task.due_in_ms);
      return {
        id: String(task.id),
        kind: task.kind === "command" || task.kind === "watch" ? task.kind : "timer",
        label: String(task.label ?? ""),
        due,
        at: Date.now(),
        left,
        chip,
      };
    });
    this.taskBar.setVisible(this.banner.length > 0);
    this.tickBanner();
  }

  private tickBanner(): void {
    if (this.closed) return;
    for (const task of this.banner) {
      if (task.due === null) {
        task.left.setText("");
        continue;
      }
      task.left.setText(fmtLeft(task.due - (Date.now() - task.at)));
    }
  }

  // ─────────────────────── command cards (approval + result) ───────────────────────

  private cmdCard(key: string, command: string): CmdCard {
    const existing = this.cards.get(key);
    if (existing) return existing;
    const row = new ListBoxRow();
    const box = new Box(Orientation.VERTICAL, 4);
    box.addCssClass("card");
    const head = sel(new Label(this.t("cmd.head")));
    head.setHalign(Align.START);
    box.append(head);
    const code = sel(new Label(`$ ${command}`));
    code.addCssClass("code");
    code.setWrap(true);
    code.setXalign(0);
    box.append(code);
    const status = new Label("");
    status.addCssClass("info-line");
    status.setHalign(Align.START);
    box.append(status);
    row.setChild(box);
    const card: CmdCard = {
      node: { row, cp: null, isMsg: false, infos: [] },
      head,
      code,
      why: null,
      btns: null,
      status,
      outBtn: null,
      outLabel: null,
    };
    this.nodes.push(card.node);
    this.cards.set(key, card);
    this.botBubble = null;
    this.appendRow(row);
    return card;
  }

  private cardStatus(c: CmdCard, text: string): void {
    c.status.setText(text);
    this.scrollToBottom();
  }

  private onCommandRequest(ev: Extract<ServerEvent, { type: "command_request" }>): void {
    const c = this.cmdCard(`req${ev.id}`, ev.command);
    c.node.row.getChild()?.addCssClass("card-pending");
    c.head.setText(this.t("cmd.wants"));
    if (ev.reason && !c.why) {
      const w = sel(new Label(ev.reason)); // added after the row landed
      w.addCssClass("info-line");
      w.setHalign(Align.START);
      w.setWrap(true);
      // GTK4 Box has no insert-at-index wrapper: append is fine — the why line sits
      // under the command, above the buttons (which are appended after it)
      (c.node.row.getChild() as Box).append(w);
      c.why = w;
    }
    if (!c.btns) {
      const b = new Box(Orientation.HORIZONTAL, 8);
      const yes = new Button(`✓ ${this.t("cmd.yes")}`);
      yes.onClick(() => this.send({ type: "approve", id: ev.id, ok: true }));
      const no = new Button(`✕ ${this.t("cmd.no")}`);
      no.onClick(() => this.send({ type: "approve", id: ev.id, ok: false }));
      b.append(yes);
      b.append(no);
      const hint = new Label(this.t("cmd.voiceHint"));
      hint.addCssClass("info-line");
      b.append(hint);
      (c.node.row.getChild() as Box).append(b);
      c.btns = b;
    }
    this.lastReq = c;
    this.scrollToBottom();
  }

  private onCommandResolved(): void {
    const c = this.lastReq;
    if (!c) return;
    c.node.row.getChild()?.removeCssClass("card-pending");
    if (c.btns) {
      detach(c.node.row.getChild() as Box, c.btns);
      c.btns = null;
    }
  }

  private onCommandStart(ev: Extract<ServerEvent, { type: "command_start" }>): void {
    const wanted = `$ ${ev.command}`;
    let c = this.cards.get(`run${ev.id}`);
    if (!c && this.lastReq && this.lastReq.code.getText() === wanted) c = this.lastReq;
    if (!c) c = this.cmdCard(`run${ev.id}`, ev.command);
    this.cards.set(`run${ev.id}`, c);
    this.lastReq = null;
    c.node.row.getChild()?.removeCssClass("card-pending");
    if (c.btns) {
      detach(c.node.row.getChild() as Box, c.btns);
      c.btns = null;
    }
    c.head.setText(ev.auto ? this.t("cmd.runAuto") : this.t("cmd.run"));
    this.cardStatus(c, this.t("cmd.running"));
  }

  private onCommandResult(ev: Extract<ServerEvent, { type: "command_result" }>): void {
    const c =
      this.cards.get(`run${ev.id}`) ?? this.lastReq ?? this.cmdCard(`run${ev.id}`, ev.command);
    this.lastReq = null;
    if (ev.status === "denied") {
      this.cardStatus(c, this.t("cmd.denied"));
      return;
    }
    if (ev.status === "cancelled") {
      this.cardStatus(c, this.t("cmd.stopped"));
      return;
    }
    this.cardStatus(c, (ev.status === "exit 0" ? "✅ " : "⚠ ") + ev.status);
    if (ev.output && !c.outLabel) {
      const box = c.node.row.getChild() as Box;
      const outLabel = sel(new Label(ev.output)); // same: appended to an existing card
      outLabel.addCssClass("pre");
      outLabel.setWrap(true);
      outLabel.setXalign(0);
      outLabel.setVisible(false);
      outLabel.setProperty("max-width-chars", 90);
      // jsGTK's ToggleButton ctor takes a *pointer*, not a label: passing a string
      // falls through to Button's label overload and silently yields a plain
      // GtkButton (no `toggled` signal, click does nothing). Label it after.
      const btn = new ToggleButton();
      btn.setLabel(this.tf("gtk.out", { n: ev.output.split("\n").length }));
      btn.addCssClass("btn-flat");
      btn.setHalign(Align.START);
      btn.onToggled(() => outLabel.setVisible(btn.getActive()));
      box.append(btn);
      box.append(outLabel);
      c.outBtn = btn;
      c.outLabel = outLabel;
    }
  }

  // ─────────────────────────── tool-call cards ───────────────────────────

  private pretty(v: unknown): string {
    let val = v;
    if (typeof val === "string") {
      try {
        val = JSON.parse(val);
      } catch {
        return String(v);
      }
    }
    const one = JSON.stringify(val);
    return one && one.length <= 140 ? one : JSON.stringify(val, null, 2);
  }

  private toolCardFor(ev: ToolEventLike): ToolCard {
    const base = ev.id || `${ev.tool}·${ev.summary || ""}`;
    let key = base;
    let c = this.toolCards.get(key);
    let n = 1;
    while (c && ev.phase === "start" && c.done) {
      // same id reused next turn: the old card stays, the new one gets a #n key
      key = `${base}#${++n}`;
      c = this.toolCards.get(key);
    }
    if (c) return c;
    const row = new ListBoxRow();
    const box = new Box(Orientation.VERTICAL, 4);
    box.addCssClass("tool-card");
    const head = new Box(Orientation.HORIZONTAL, 7);
    const name = sel(new Label(`🔧 ${ev.tool || "?"}`));
    name.addCssClass("tool-name");
    head.append(name);
    const sum = sel(new Label(ev.summary ?? ""));
    sum.addCssClass("dim");
    sum.setEllipsize(3);
    sum.setHexpand(true);
    head.append(sum);
    const badge = new Label(this.t("tool.running"));
    badge.addCssClass("badge-run");
    head.append(badge);
    box.append(head);
    const detail = new Box(Orientation.VERTICAL, 4);
    detail.setVisible(false);
    const inBlk = new Box(Orientation.VERTICAL, 0);
    const inLbl = new Label("input");
    inLbl.addCssClass("dim");
    inBlk.append(inLbl);
    const inPre = sel(new Label(""));
    inPre.addCssClass("pre");
    inPre.setWrap(true);
    inPre.setXalign(0);
    inPre.setProperty("max-width-chars", 90);
    inBlk.append(inPre);
    detail.append(inBlk);
    const outBlk = new Box(Orientation.VERTICAL, 0);
    const outLbl = new Label("output");
    outLbl.addCssClass("dim");
    outBlk.append(outLbl);
    const outPre = sel(new Label(""));
    outPre.addCssClass("pre");
    outPre.setWrap(true);
    outPre.setXalign(0);
    outPre.setProperty("max-width-chars", 90);
    outBlk.append(outPre);
    detail.append(outBlk);
    const meta = sel(new Label(""));
    meta.addCssClass("dim");
    detail.append(meta);
    const toggle = new ToggleButton();
    toggle.setLabel(`▸ ${this.t("tool.details")}`);
    toggle.addCssClass("btn-flat");
    toggle.setHalign(Align.START);
    toggle.onToggled(() => detail.setVisible(toggle.getActive()));
    box.append(toggle);
    box.append(detail);
    row.setChild(box);
    const card: ToolCard = {
      node: { row, cp: null, isMsg: false, infos: [] },
      name,
      sum,
      badge,
      inBlk,
      inPre,
      outBlk,
      outPre,
      meta,
      done: false,
    };
    this.nodes.push(card.node);
    this.toolCards.set(key, card);
    this.botBubble = null;
    this.appendRow(row);
    return card;
  }

  private onTool(ev: ToolEventLike): void {
    const c = this.toolCardFor(ev);
    c.name.setText(`🔧 ${ev.tool || "?"}`);
    if (ev.summary) c.sum.setText(ev.summary); // "end" has no summary
    const box = c.node.row.getChild()!;
    if (ev.phase === "start") {
      c.done = false;
      box.removeCssClass("tool-err");
      box.removeCssClass("tool-blocked");
      c.badge.setText(this.t("tool.running"));
      const hasIn = ev.args !== undefined && ev.args !== null && ev.args !== "" && ev.args !== "{}";
      c.inBlk.setVisible(hasIn);
      if (hasIn) c.inPre.setText(this.pretty(ev.args));
    } else {
      c.done = true;
      for (const cls of ["badge-run", "badge-ok", "badge-err", "badge-blocked"]) {
        c.badge.removeCssClass(cls);
      }
      if (ev.error) {
        box.addCssClass("tool-err");
        c.badge.addCssClass("badge-err");
        c.badge.setText(this.t("tool.error"));
      } else if (ev.blocked) {
        box.addCssClass("tool-blocked");
        c.badge.addCssClass("badge-blocked");
        c.badge.setText(this.t("tool.blocked"));
      } else {
        c.badge.addCssClass("badge-ok");
        c.badge.setText("✅ ok");
      }
      c.outBlk.setVisible(true);
      c.outPre.setText(ev.result || this.t("tool.noOutput"));
      c.meta.setText([ev.origin, ev.info || ""].filter(Boolean).join(" · "));
    }
    this.scrollToBottom();
  }

  // ───────────────────────────── context meter ─────────────────────────────

  private onContext(ev: { used: number; total: number }): void {
    const total = Math.max(0, Math.round(ev.total || 0));
    const used = Math.max(0, Math.round(ev.used || 0));
    if (!total) {
      this.ctxBox.setVisible(false);
      return;
    }
    const pct = Math.min(100, (used / total) * 100);
    this.ctxBox.setVisible(true);
    this.ctxBar.setFraction(pct / 100);
    // the bar already shows the percentage — repeating it in the label only
    // steals room from the model pill in a narrow window
    this.ctxText.setText(`${this.tok(used)}/${this.tok(total)}`);
    this.ctxBox.setTooltipText(
      `${this.t("ctx.title")}: ${this.tok(used)} / ${this.tok(total)} · ${pct.toFixed(0)}%`,
    );
    const bar = this.ctxBar;
    for (const cls of ["warn", "hot"]) bar.removeCssClass(cls);
    if (pct >= 90) bar.addCssClass("hot");
    else if (pct >= 70) bar.addCssClass("warn");
  }

  private tok(n: number): string {
    if (n < 1e3) return String(n);
    const [v, k] = n >= 1e6 ? [n / 1e6, "M"] : [n / 1e3, "k"];
    const [whole, frac] = v.toFixed(1).split(".");
    return whole + (frac === "0" ? "" : (this.i18n.locale === "it" ? "," : ".") + frac) + k;
  }

  // ───────────────────────── models / voices / skills ─────────────────────────

  private fillModels(models: string[], current: string, usePi: boolean): void {
    if (usePi !== this.viaPi) this.modelQuery = "";
    this.currentModel = current;
    this.viaPi = usePi;
    this.modelListNames = models.slice();
    this.rebuildModelRows();
    this.modelBtn.setLabel(shortModel(current));
    this.modelBtn.setTooltipText(
      current ? `${this.t("model.api.title")}: ${current}` : this.t("model.api.title"),
    );
    this.piBadge.setVisible(this.viaPi);
    this.modelBtn.setSensitive(true);
  }

  private rebuildModelRows(): void {
    this.modelList.removeAll();
    const q = this.modelQuery.trim().toLowerCase();
    const hits = q
      ? this.modelListNames.filter((m) => m.toLowerCase().includes(q))
      : this.modelListNames.slice();
    for (const m of hits) {
      const row = new ListBoxRow();
      row.addCssClass("model-row");
      const current = m === this.currentModel;
      if (current) row.addCssClass("model-row-current");
      const box = new Box(Orientation.HORIZONTAL, 8);
      box.setMarginStart(8);
      box.setMarginEnd(8);
      box.setMarginTop(5);
      box.setMarginBottom(5);
      const tick = new Label(current ? "✓" : " ");
      tick.addCssClass("model-tick");
      box.append(tick);
      const l = new Label(m);
      l.addCssClass("model-name");
      l.setHalign(Align.START);
      l.setHexpand(true);
      l.setEllipsize(3); // PANGO_ELLIPSIZE_END
      box.append(l);
      row.setChild(box);
      row.setData("model", m); // the row now holds a box, not a plain label
      this.modelList.append(row);
    }
    const n = hits.length;
    this.modelPopTitle.setText(
      this.modelQuery
        ? `${n} ${this.tf("model.pop.matches", { n })}`
        : this.tf("model.pop.title", { n }),
    );
  }

  /** The user picked a model (a row of the popover, or Enter after typing a fragment). */
  private pickModel(picked: string): void {
    if (!picked) return;
    if (this.modelQuery) {
      this.modelQuery = "";
      this.modelSearch.setText("");
      this.rebuildModelRows();
    }
    if (picked !== this.currentModel) {
      this.modelBtn.setLabel(picked);
      this.send({ type: "model", model: picked });
    }
  }

  private fillVoices(voices: string[], current: string, hz?: number): void {
    const list = voices?.length ? voices : [current || "giovanni"];
    this.voiceList = list;
    const model = new StringList(list);
    const idx = Math.max(0, list.indexOf(current));
    // setModel() *resets* the dropdown to row 0 and emits notify::selected: outside
    // this guard the handler would immediately send back voice[0] and the server
    // would undo the pick we just made (the voice flip-flops, nothing changes).
    this.prefsSyncing = true;
    this.comboVoice.setModel(model);
    this.comboVoice.setSelected(idx);
    this.prefsSyncing = false;
    this.voiceMeta.setText(this.tf("voice.meta", { hz: hz || this.rate, n: list.length }));
  }

  /**
   * Rebuild the skills list **in place**: rows are reused (title/subtitle/switch
   * refreshed) and only ever *appended* when the list grows; surplus rows are
   * hidden.
   *
   * Why not unparent + re-add: AdwPreferencesGroup keeps its last row in a
   * private field, so once its rows are unparented `adw_preferences_group_add()`
   * passes a stale previous sibling and GTK drops the insert
   * ("gtk_widget_insert_after: assertion 'previous_sibling == NULL || …'") —
   * the list then renders empty, with no error anywhere else.
   */
  private fillSkills(list: SkillInfo[], dir?: string): void {
    this.skills = list || [];
    if (dir !== undefined && dir !== null) this.skillsDir = dir || "";

    const emptyText = this.skillsDir
      ? this.tf("skills.empty.in", { dir: this.skillsDir })
      : this.t("skills.empty");
    if (!this.skills.length) {
      for (const row of this.skillRows) row.setVisible(false);
      if (!this.skillEmpty) {
        this.skillEmpty = new Label(emptyText);
        this.skillEmpty.addCssClass("dim");
        this.skillsGroup.add(this.skillEmpty);
      } else {
        this.skillEmpty.setText(emptyText);
      }
      this.skillEmpty.setVisible(true);
      return;
    }
    if (this.skillEmpty) this.skillEmpty.setVisible(false);

    for (let i = 0; i < this.skills.length; i++) {
      const s = this.skills[i]!;
      let row = this.skillRows[i];
      if (!row) {
        row = new SwitchRow();
        row.onActiveChanged((v) => {
          const cur = this.skills[i];
          if (!cur || this.prefsSyncing) return;
          cur.active = v;
          this.send({
            type: "skills_set",
            active: this.skills.filter((x) => x.active).map((x) => x.name),
          });
        });
        this.skillsGroup.add(row);
        this.skillRows.push(row);
      }
      row.setTitle(s.name);
      row.setSubtitle(s.description || "");
      this.prefsSyncing = true;
      row.setActive(!!s.active);
      this.prefsSyncing = false;
      row.setVisible(true);
    }
    for (let i = this.skills.length; i < this.skillRows.length; i++) {
      this.skillRows[i]!.setVisible(false);
    }
  }

  // ───────────────────────────── state / session ─────────────────────────────

  private setState(s: StateName | "connecting"): void {
    // the socket can close right after the window did — the labels are gone then
    if (this.closed) return;
    this.state = s;
    this.stateLabel.setText(this.t(`state.${s}`) !== `state.${s}` ? this.t(`state.${s}`) : s);
    this.orb.queueDraw();
  }

  private clearChat(): void {
    this.chatList.removeAll();
    this.nodes = [];
    this.cards.clear();
    this.toolCards.clear();
    this.botBubble = null;
    this.thinkBlock = null;
    this.lastReq = null;
    this.partial.setText("");
  }

  /**
   * Another window took the client slot (`session_taken`, or the close that follows it).
   * The chat stays readable, but the window must stop *looking* interactive: a text box
   * whose every line is silently dropped is worse than one that says it is off.
   */
  private onSessionTaken(): void {
    if (this.takenOver) return;
    this.takenOver = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.setState("offline");
    this.addEvent(this.t("msg.replaced"));
    this.textIn.setSensitive(false);
    this.sendBtn.setSensitive(false);
    // a window that is no longer being fed must stop capturing the mic
    if (this.micOn) this.setMicOn(false);
  }

  private setMicOn(on: boolean): void {
    this.micOn = on;
    this.micBtn.setActive(on);
    this.micBtn.setIconName(
      on ? "microphone-sensitivity-high-symbolic" : "microphone-disabled-symbolic",
    );
    this.micBtn[on ? "removeCssClass" : "addCssClass"]("off");
    if (!on) this.micPeak = 0;
  }

  private setVoiceOn(on: boolean): void {
    this.voiceOn = on;
    this.voiceBtn.setActive(on);
    this.voiceBtn.setIconName(on ? "audio-volume-high-symbolic" : "audio-volume-muted-symbolic");
  }

  // ───────────────────────────── audio wiring ─────────────────────────────

  /**
   * Point the capture/playback at the AEC nodes (or the plain devices). With the
   * system AEC engaged the mic never hears the assistant — the native counterpart of
   * the browser's echo canceller, done entirely by PipeWire's module-echo-cancel.
   */
  private applyAudioTargets(announce: boolean): void {
    const useAec = this.aecOn && this.opts.aecSource !== "";
    this.mic.target = useAec ? this.opts.aecSource : this.opts.micTarget;
    const spkTarget = useAec ? this.opts.aecSink : this.opts.spkTarget;
    if (this.micOn && !this.takenOver) {
      this.mic.stop();
      this.mic.start();
    }
    this.speaker.ensure(this.rate, spkTarget);
    if (announce) {
      this.addEvent(this.t(useAec ? "aec.on" : this.opts.spkTarget ? "aec.speaker" : "aec.off"));
    }
  }

  private onMicFrame(f: MicFrame): void {
    if (this.closed) return; // one last frame can land after the window is gone
    this.micPeak = this.micOn && !this.takenOver ? Math.min(1, f.peak * 1.4) : 0;
    if (this.micOn && !this.takenOver) this.sendBinary(f.pcm);
  }

  // ───────────────────────────── websocket ─────────────────────────────

  private send(obj: ClientCommand): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  private sendBinary(bytes: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(bytes);
    } catch {
      /* connection went away mid-send */
    }
  }

  private connect(): void {
    if (this.takenOver) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    };
    ws.onclose = (e: CloseEvent) =>
      onGtkIdle(() => {
        this.setState("offline");
        // The server closes the losing side with 1000 "replaced by a new client" when a
        // second window opens (only one client is fed). Reconnecting would kick *that*
        // one back and the two would ping-pong forever — so the kicked client stays put.
        if (this.takenOver) return;
        if (e.code === 1000 && String(e.reason ?? "").startsWith("replaced")) {
          this.onSessionTaken();
          return;
        }
        this.scheduleReconnect();
      });
    ws.onmessage = (e: MessageEvent) => {
      // WebSocket data lands between GTK steps, never inside one: everything
      // below writes to widgets, so hand it to the GLib main loop first.
      onGtkIdle(() => this.handleMessage(e));
    };
  }

  /** The body of the socket handler — always called inside the GTK main loop. */
  private handleMessage(e: MessageEvent): void {
    if (typeof e.data !== "string") {
      // binary = TTS PCM at `rate`, already paced server-side
      if (this.voiceOn) {
        const bytes =
          e.data instanceof ArrayBuffer
            ? new Uint8Array(e.data)
            : new Uint8Array(e.data as ArrayBuffer);
        this.speaker.write(bytes);
      }
      return;
    }
    let ev: ServerEvent;
    try {
      ev = JSON.parse(e.data) as ServerEvent;
    } catch {
      return;
    }
    // 🧹 ack discipline: everything the server sent before acknowledging the reset
    // belongs to the chat we just erased — drop it (4 s safety net for a lost ack).
    if (this.resetBarrier) {
      if (ev.type === "chat_reset" || Date.now() >= this.resetBarrier) this.resetBarrier = 0;
      else if ((STALE_ON_RESET as readonly string[]).includes(ev.type)) return;
    }
    this.onEvent(ev);
  }

  private scheduleReconnect(): void {
    if (this.takenOver || this.closed) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 1500);
  }

  private onEvent(ev: ServerEvent): void {
    if (this.closed) return;
    switch (ev.type) {
      case "session_taken":
        this.onSessionTaken();
        return;
      case "hello": {
        this.fillVoices(ev.voices, ev.voice, ev.rate);
        this.fillModels(ev.models || [], ev.model, ev.config.llm_via_pi);
        this.prefsSyncing = true;
        this.swPi.setActive(!!ev.config.llm_via_pi);
        this.comboCmd.setSelected(
          Math.max(0, ["ask", "auto", "off"].indexOf(ev.config.cmd_mode || "auto")),
        );
        this.swBarge.setActive(ev.config.barge_in);
        this.swHalf.setActive(ev.config.half_duplex);
        this.swThink.setActive(!!ev.config.thinking);
        this.comboDecision.setSelected(
          Math.max(0, ["auto", "always", "off"].indexOf(ev.config.decision_mode || "auto")),
        );
        this.swAec.setActive(this.aecOn);
        this.prefsSyncing = false;
        if (ev.rate !== this.rate) {
          this.rate = ev.rate;
          this.speaker.ensure(this.rate, this.aecOn ? this.opts.aecSink : this.opts.spkTarget);
        }
        if (!this.nodes.length) {
          for (const m of ev.history as HistoryMessage[]) {
            this.addMsg(m.role === "user" ? "user" : "bot", m.content, undefined, m.id);
          }
          if (!ev.history.length) this.addEvent(this.t("msg.ready"));
        }
        if (ev.pending_command) {
          this.onCommandRequest({
            ...ev.pending_command,
            type: "command_request",
          });
        }
        this.onTasks(ev.tasks || []);
        this.fillSkills(ev.skills || [], ev.skills_dir);
        this.setState(ev.state);
        if (ev.context) this.onContext(ev.context);
        if (this.micOn && !this.takenOver && !this.mic.running) this.mic.start();
        return;
      }
      case "state":
        this.setState(ev.state);
        return;
      case "partial":
        this.partial.setText(ev.text ? `🎤 ${ev.text}` : "");
        return;
      case "user":
        this.partial.setText("");
        this.botBubble = null;
        this.thinkBlock = null;
        this.addMsg("user", ev.text, ev.info, ev.id);
        return;
      case "reasoning":
        this.onReasoning(ev.text);
        return;
      case "assistant":
        this.botAppend(ev.text);
        return;
      case "assistant_done":
        // the line is in the history now: stamp its checkpoint — what ⟲ sends back
        if (this.botBubble && ev.id !== undefined && ev.id !== null)
          this.stampLine(this.botBubble, ev.id);
        this.botBubble = null;
        return;
      case "assistant_cancel":
        if (this.botBubble) {
          const cut = sel(new Label(`✂ ${this.t("msg.cut")}`));
          cut.addCssClass("chip-left");
          this.botBubble.bubble?.append(cut);
        }
        this.botBubble = null;
        return;
      case "latency":
        this.botInfo(this.tf("ev.latency", { a: ev.first_token_ms, b: ev.first_audio_ms }));
        return;
      case "flush":
        this.speaker.flush();
        return;
      case "context":
        this.onContext(ev);
        return;
      case "event":
        this.addEvent(ev.text);
        return;
      case "chat_rewound":
        this.onRewound(ev);
        return;
      case "tasks":
        this.onTasks(ev.tasks);
        return;
      case "tool":
        this.onTool(ev);
        return;
      case "command_request":
        this.onCommandRequest(ev);
        return;
      case "command_resolved":
        this.onCommandResolved();
        return;
      case "command_start":
        this.onCommandStart(ev);
        return;
      case "command_result":
        this.onCommandResult(ev);
        return;
      case "models": {
        this.fillModels(ev.models, ev.current, !!ev.via_pi);
        if (ev.via_pi !== undefined) {
          this.prefsSyncing = true;
          this.swPi.setActive(!!ev.via_pi);
          this.prefsSyncing = false;
        }
        if (this.modelRefreshPending) {
          // our ↻ got an answer: say so, then stop spinning
          this.modelRefreshPending = false;
          this.refreshBtn.setSensitive(true);
          this.addEvent(this.tf("ev.models", { n: ev.models.length }));
        }
        return;
      }
      case "skills":
        this.fillSkills(ev.skills, ev.dir);
        return;
      case "voices":
        this.fillVoices(ev.voices, ev.current, ev.rate || this.rate);
        return;
      case "model_loading":
        this.modelBtn.setSensitive(false);
        this.addEvent(this.tf("ev.loading", { m: ev.model }));
        return;
      case "model_ready":
        this.currentModel = ev.model;
        this.modelBtn.setSensitive(true);
        this.modelBtn.setLabel(ev.model);
        this.addEvent(this.tf("ev.ready", { m: ev.model, s: ev.seconds }));
        return;
      case "model_error":
        this.modelBtn.setSensitive(true);
        this.currentModel = ev.current;
        this.modelBtn.setLabel(ev.current);
        this.addEvent(this.tf("ev.modelError", { m: ev.model, e: ev.error }));
        return;
    }
  }

  private sendText(): void {
    if (this.takenOver) return; // no socket: typing here would go nowhere, and say nothing
    const text = this.textIn.getText().trim();
    if (text) {
      if (this.send({ type: "text", text })) this.textIn.setText("");
    }
  }

  private shutdown(): void {
    // Closing the window frees every widget; without stopping the tickers the
    // next queue_draw()/setSensitive() lands on freed pointers (a flood of
    // GTK-CRITICALs) and the process never exits. One flag + two timers.
    this.closed = true;
    if (this.levelTimer) clearInterval(this.levelTimer);
    if (this.bannerTimer) clearInterval(this.bannerTimer);
    this.mic.stop();
    this.speaker.close();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

// ── local helpers ──────────────────────────────────────────────────────────

/**
 * Detach `child` from `box`, but only if it is still in there: removing it twice
 * (a command card rebuilt by both `command_resolved` and `command_start`, a task
 * banner refreshed twice) makes GTK assert
 * `gtk_widget_get_parent (child) == …` — and jsGTK has no getParent() to ask.
 */
/**
 * A chat label the user can select and copy (the web UI allows it; in GTK4 a
 * GtkLabel is inert — no cursor, no selection — unless `selectable` is set).
 *
 * Marked here at creation rather than by walking the tree afterwards: jsGTK's
 * `getFirstChild()` hands back a `GObject` wrapper, which has neither
 * `getNextSibling` nor the subclass methods, so a walk both crashes and cannot
 * recognise a Label through `instanceof`.
 */
/**
 * The header has room for ~20 characters: a full quantised model name would push
 * the header buttons off the edge of a narrow window. The whole name stays in
 * the tooltip and in the popover list.
 */
function shortModel(name: string): string {
  if (!name) return "…";
  return name.length <= 14 ? name : `${name.slice(0, 13)}…`;
}

const ICON_DIR = path.join(import.meta.dir, "icons");

/**
 * Window icon.
 *
 * The packaged client installs `sonia-gtk4.png` into the hicolor theme — that is
 * what the .desktop entry's `Icon=` resolves and the name the theme can look up —
 * so it is applied by *name* through `gtk_window_set_icon_name`, and as the
 * default for every window that has none of its own. A window with no icon shows
 * up as the generic blank block in the task switcher and Alt-Tab.
 */
const APP_ICON_NAME = "sonia-gtk4";

/** Best effort: a missing icon must never keep the window from opening. */
export function applyWindowIcon(win: ApplicationWindow): boolean {
  try {
    setDefaultIconName(APP_ICON_NAME);
    return setWindowIcon(win, APP_ICON_NAME);
  } catch (e) {
    console.log("[ui] window icon unavailable:", e);
    return false;
  }
}

/**
 * Icon on a button: our own SVG (`sonia-gtk4/icons/*.svg`) when it is there,
 * the stock Adwaita glyph otherwise.
 *
 * The SVG goes in as a *file* rather than by name: through the icon theme GTK
 * rendered it at a fraction of the requested size (a dot next to the mic), and a
 * file gives a deterministic pixel size. The stroke is already the UI text
 * colour, since a file is not recoloured like a symbolic theme icon.
 */
function applyIcon(btn: Button, name: string, fallbackIcon: string): void {
  const file = path.join(ICON_DIR, `${name}.svg`);
  try {
    if (!fs.existsSync(file)) throw new Error("missing");
    const img = new Image();
    img.setFile(file);
    btn.setProperty("child", img); // GtkButton:child replaces the label
    return;
  } catch (e) {
    // no custom glyph here (partial checkout) or the loader refused it — stock one,
    // but say so, a silent fallback is how a 6px "dot icon" hides for hours
    if (!(e instanceof Error && e.message === "missing")) {
      console.log(`[ui] custom icon ${name} unavailable:`, e);
    }
  }
  btn.setIconName(fallbackIcon);
}

function sel(l: Label): Label {
  l.setSelectable(true);
  return l;
}

function detach(box: Box | ListBox, child: Widget | null): void {
  if (!child || !parentOf(child)) return;
  box.remove(child);
}

/** 42 000 → «0:42»; a passed deadline shows «0:00», never a negative. */
function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The tiny leading icon of a task chip. */
function ico(parent: Box, glyph: string): void {
  const l = new Label(glyph);
  parent.append(l);
}

/** The subset of ToolEvent this client renders (mirrors src/events.ts ToolEvent). */
type ToolEventLike = {
  type: "tool";
  phase: "start" | "end";
  origin: string;
  id: string;
  tool: string;
  summary?: string;
  args?: unknown;
  result?: string;
  info?: string;
  error?: boolean;
  blocked?: boolean;
};
