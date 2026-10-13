/**
 * dbg-tools.ts — why are some tool calls missing from the chat?
 *
 * Drives the live UI over CDP, records EVERY /ws event the page receives, and
 * compares it with what actually landed in the DOM (`.tool` cards, `.cmd` cards,
 * `.event` lines). Any page-side exception is captured too.
 *
 *   bun run tests/dbg-tools.ts --url http://127.0.0.1:PORT/ --cdp http://127.0.0.1:CDP
 */

import WebSocket from "ws";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Args = { url: string; cdp: string; only: string };
function parseArgs(argv: string[]): Args {
  const args: Args = { url: "http://127.0.0.1:8095/", cdp: "http://127.0.0.1:9222", only: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--url") args.url = argv[++i]!;
    else if (a === "--cdp") args.cdp = argv[++i]!;
    else if (a === "--only") args.only = argv[++i]!.toUpperCase();
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

class Ctx {
  seq = 0;
  private readonly pending = new Map<number, (v: any) => void>();
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m.result);
        this.pending.delete(m.id);
      }
    });
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.seq;
    const p = new Promise<any>((res) => this.pending.set(id, res));
    this.ws.send(JSON.stringify({ id, method, params }));
    return await p;
  }
  async js(expr: string): Promise<any> {
    const r = await this.call("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  }
  async until(expr: string, what = "", timeoutS = 120): Promise<boolean> {
    const ok = await this.waitFor(expr, timeoutS);
    if (!ok) console.log(`  TIMEOUT waiting for ${what || expr}`);
    return ok;
  }
  /** Same as until(), but silent (for the optional "did the turn start yet" probe). */
  async waitFor(expr: string, timeoutS = 120): Promise<boolean> {
    for (let i = 0; i < Math.floor(timeoutS * 4); i++) {
      try {
        if ((await this.js(expr)) === true) return true;
      } catch {
        /* mid-navigation */
      }
      await sleep(250);
    }
    return false;
  }
}

const RECORDER = `
(() => {
  if (window.__rec) return "already";
  window.__ev = []; window.__err = [];
  window.addEventListener("error", (e) => window.__err.push(String(e.message) + " @ " + e.filename + ":" + e.lineno));
  window.addEventListener("unhandledrejection", (e) => window.__err.push("rejection: " + String(e.reason)));
  const w = (typeof ws !== "undefined") ? ws : null;
  if (!w) return "no ws";
  const orig = w.onmessage;
  w.onmessage = (e) => {
    if (typeof e.data === "string") { try { window.__ev.push(JSON.parse(e.data)); } catch (err) { window.__err.push("parse: " + err); } }
    try { return orig.call(w, e); } catch (err) { window.__err.push("handler: " + ((err && err.stack) || err)); }
  };
  window.__rec = true;
  return "ok";
})()`;

const DUMP = `
(() => {
  const tc = (typeof toolCards !== "undefined") ? toolCards : {};
  const cards = [...document.querySelectorAll("#log > .tool")].map(c => ({
    key: Object.keys(tc).find(k => tc[k] === c) || "?",
    name: c.querySelector(".name")?.textContent || "",
    sum: c.querySelector(".sum")?.textContent || "",
    badge: c.querySelector(".badge")?.textContent || "",
    out: (c.querySelector(".out")?.textContent || "").slice(0, 60),
  }));
  const cmds = [...document.querySelectorAll("#log > .cmd")].map(c => ({
    head: c.querySelector(".head")?.textContent || "",
    code: (c.querySelector("code")?.textContent || "").slice(0, 60),
    status: [...c.querySelectorAll(":scope > .status")].map(s => s.textContent).join("|"),
  }));
  const events = [...document.querySelectorAll("#log > .event")].map(e => e.textContent);
  const msgs = [...document.querySelectorAll("#log > .msg")].map(m =>
    m.className.replace("msg ", "") + ": " + (m.querySelector(".body")?.textContent || "").slice(0, 70));
  return { cards, cmds, events, msgs, ev: window.__ev || [], err: window.__err || [] };
})()`;

function toolEvents(ev: any[]): any[] {
  return ev.filter((e) => e && (e.type === "tool" || String(e.type).startsWith("command_")));
}

async function scenario(label: string, c: Ctx, text: string, extra?: () => Promise<void>): Promise<void> {
  console.log(`\n── ${label} ─────────────────────────────────────`);
  const before = (await c.js("window.__ev.length")) as number;
  await c.js(`send({type:'text', text:${JSON.stringify(text)}})`);
  // the turn must first leave "listening" (otherwise we would sample the idle state too early)
  await c.waitFor(`orb.className !== 'listening'`, 40);
  // thinking/speaking/user → idle (or "confirm" while an approval is pending)
  const idle = `['listening','confirm'].includes(orb.className)`;
  await c.until(idle, `idle after «${text}»`, 240);
  if (extra) {
    await extra();
    await sleep(1000);
    await c.until("orb.className === 'listening'", "idle after approval", 240);
  }
  await sleep(1500);
  const d: any = (await c.js(DUMP)) || { ev: [], cards: [], cmds: [], msgs: [], err: [] };
  const sent = toolEvents(d.ev.slice(before));
  console.log(`  events received after the turn: ${d.ev.slice(before).map((e: any) => e.type).join(",")}`);
  console.log(`  tool/command events sent: ${sent.length}`);
  for (const e of sent) console.log(`    → ${JSON.stringify(e).slice(0, 220)}`);
  console.log(`  DOM .tool cards: ${d.cards.length}`);
  for (const k of d.cards) console.log(`    ← ${JSON.stringify(k)}`);
  console.log(`  DOM .cmd cards: ${d.cmds.length}`);
  for (const k of d.cmds) console.log(`    ← ${JSON.stringify(k)}`);
  console.log(`  page errors: ${d.err.length ? JSON.stringify(d.err) : "none"}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  let pages: { webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${args.cdp.replace(/\/+$/, "")}/json/list`);
      if (r.ok) {
        const list = (await r.json()) as { type?: string; webSocketDebuggerUrl?: string }[];
        pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl)
          .map((t) => ({ webSocketDebuggerUrl: t.webSocketDebuggerUrl! }));
        if (pages.length) break;
      }
    } catch {
      /* not up */
    }
    await sleep(300);
  }
  if (!pages.length) {
    console.log(`no CDP page target at ${args.cdp}`);
    return 1;
  }
  const ws = new WebSocket(pages[0]!.webSocketDebuggerUrl, { maxPayload: 64 << 20 });
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const c = new Ctx(ws);
  await c.call("Runtime.enable");
  await c.call("Page.enable");
  await c.call("Page.navigate", { url: args.url });
  await c.until(
    "document.readyState==='complete' && typeof send==='function' && !!ws && ws.readyState===1",
    "page load + websocket",
    60,
  );
  await c.js("document.getElementById('overlay').style.display='none'");
  console.log("recorder:", await c.js(RECORDER));

  // A: harness (API-leg) tool — get_datetime
  const want = (l: string) => !args.only || args.only.includes(l);
  if (want("A")) {
    await c.js("if (piChk.checked) piChk.click()");
    await c.until("!piChk.checked", "api leg");
    await scenario("A · API leg, get_datetime", c, "Che ore sono adesso? (usa lo strumento)");
  }

  // B: harness run_command with the approval card
  if (want("B")) {
    await c.js("if (piChk.checked) piChk.click()");
    await c.until("!piChk.checked", "api leg");
    await scenario("B · API leg, run_command + approval", c, "Esegui il comando: date +%H:%M:%S", async () => {
      const got = await c.until("!!document.querySelector('.cmd .btns button.ok')", "approval button", 90);
      if (got) await c.js("document.querySelector('.cmd .btns button.ok').click()");
      else
        console.log(
          "  (no approval card — commands are not in `ask` mode, run_command executed immediately)",
        );
    });
  }

  // C: pi leg tool
  if (want("C")) {
    await c.js("if (!piChk.checked) piChk.click()");
    await c.until("piChk.checked", "pi leg");
    await scenario("C · pi leg, bash", c, "Esegui il comando: date +%H:%M:%S");
  }

  // E: two API-leg turns, one tool call each → does the second card reuse/clobber the first?
  if (want("E")) {
    await c.js("if (piChk.checked) piChk.click()");
    await c.until("!piChk.checked", "api leg");
    await scenario("E1 · API leg, get_datetime", c, "Che ore sono? Usa lo strumento get_datetime.");
    await scenario("E2 · API leg, get_datetime again", c, "Dimmi di nuovo l'ora, con lo strumento get_datetime.");
  }
  if (want("D")) {
    await c.js("if (!piChk.checked) piChk.click()");
    await c.until("piChk.checked", "pi leg");
    await scenario(
      "D · pi leg, three bash calls in one turn",
      c,
      "Usa il tool bash ed esegui tre comandi, uno alla volta: date +%H:%M:%S, uptime, whoami. Poi riporta i tre risultati.",
    );
  }

  const d: any = await c.js(DUMP);
  console.log("\n" + "=".repeat(60));
  console.log(`totals: tool events ${toolEvents(d.ev).length}, .tool cards ${d.cards.length}, .cmd cards ${d.cmds.length}`);
  console.log(`page errors: ${d.err.length ? JSON.stringify(d.err, null, 2) : "none"}`);
  ws.close();
  return 0;
}

process.exit(await main());
