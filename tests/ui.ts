/**
 * CDP tests for the browser front-end (headless Chromium + DevTools protocol).
 *
 *   bun run tests/ui.ts check    settings drawer, pi toggle, model list, header badge
 *   bun run tests/ui.ts reasoning  💭 the collapsed reasoning block (one per turn)
 *   bun run tests/ui.ts tool     a real pi tool call → collapsed card
 *   bun run tests/ui.ts model    switch pi's model away and back (RAM-safe 4B)
 *   bun run tests/ui.ts smoke    command cards + a real turn end-to-end
 *   bun run tests/ui.ts rewind   ⟲ a checkpoint cuts the chat here *and* the history there
 *   bun run tests/ui.ts all      everything, in that order (default)
 *
 *   --url http://127.0.0.1:8097/   which harness to drive
 *   --cdp http://127.0.0.1:9222    where Chromium's DevTools port listens
 *   --shot PATH                    screenshot of the expanded tool card ("" = none)
 *
 * Run it through scripts/ui-test.sh: it starts a throwaway harness plus a dedicated
 * headless Chromium, runs this, and cleans up after itself.
 */

import fs from "node:fs";
import WebSocket from "ws";

const PI_SMALL = "llamacpp/FrogNano-4B-2609-Q4_K_M"; // 2.6 GiB (Qwen3.5-4B-MTP is the default now)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Result = [suite: string, label: string, ok: boolean];

class Ctx {
  seq = 0;
  results: Result[] = [];
  current = "?";
  private readonly pending = new Map<number, (v: any) => void>();

  constructor(
    readonly ws: WebSocket,
    readonly url: string,
    readonly shot: string,
  ) {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m.result);
        this.pending.delete(m.id);
      }
    });
  }

  // ── bridge ──

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
    for (let i = 0; i < Math.floor(timeoutS * 4); i++) {
      try {
        if ((await this.js(expr)) === true) return true;
      } catch {
        /* page is mid-navigation, retry */
      }
      await sleep(250);
    }
    this.check(false, `timeout waiting for ${what || expr}`);
    return false;
  }

  check(cond: unknown, label: string): boolean {
    const ok = Boolean(cond);
    console.log((ok ? "  ok   " : "  FAIL ") + label);
    this.results.push([this.current, label, ok]);
    return ok;
  }

  // ── helpers ──

  /** (Re)load the page and get past the mic overlay (headless has no microphone). */
  async open(): Promise<void> {
    await this.call("Page.enable");
    await this.call("Page.navigate", { url: this.url });
    await this.until(
      "document.readyState==='complete' && typeof send==='function' && !!ws && ws.readyState===1",
      "page load + websocket",
      60,
    );
    await this.js("document.getElementById('overlay').style.display='none'");
  }

  /** The tool/model tests exercise the pi leg: switch it on if the harness booted API. */
  async ensurePi(): Promise<void> {
    if (!(await this.js("piChk.checked"))) {
      await this.js("piChk.click()");
      await this.until("piChk.checked && modelSel.value.indexOf('/') >= 0", "pi leg switched on");
    }
  }
}

// ── the tests ───────────────────────────────────────────────────────────────

/** Drawer, pi toggle, dynamic model list, badge, other switches. */
async function testCheck(c: Ctx): Promise<void> {
  await c.open();
  c.check(
    await c.until(
      "document.readyState==='complete' && !!document.getElementById('piChk')",
      "settings markup",
    ),
    "page loaded, #piChk present",
  );
  await c.ensurePi();

  c.check(
    await c.js("!document.getElementById('settings').classList.contains('open')"),
    "settings drawer starts closed",
  );
  await c.js("document.getElementById('settingsBtn').click()");
  c.check(
    await c.js("document.getElementById('settings').classList.contains('open')"),
    "settings drawer opens",
  );
  c.check(
    await c.js(
      "['bargeChk','halfChk','aecChk','piChk','cmdSel','decisionSel','voiceSel','voiceMeta','skillsBox','skillList','skillsDir'].every(id => document.getElementById(id))",
    ),
    "all settings controls present",
  );
  c.check(
    await c.js("document.getElementById('settingsBtn').getAttribute('aria-expanded') === 'true'"),
    "aria-expanded follows the drawer",
  );

  // ── skills: the checkbox list is rendered from hello and round-trips through /ws ──
  const skills = JSON.parse(
    await c.js(
      "JSON.stringify({dir: skillsDir.textContent, " +
        "rows: [...document.querySelectorAll('#skillList label')].map(l => " +
        "({n: l.textContent, on: !l.classList.contains('off')}))})",
    ),
  );
  console.log(`  skills: ${skills.rows.length} in ${skills.dir}`);
  c.check(skills.rows.length > 0 && !!skills.dir, "skill list rendered from hello");
  if (skills.rows.length) {
    const off0 = skills.rows.filter((r: { on: boolean }) => !r.on).length;
    const off1 = skills.rows[0].on ? off0 + 1 : off0 - 1;
    await c.js("document.querySelector('#skillList input').click()");
    c.check(
      await c.until(
        `document.querySelectorAll('#skillList label.off').length === ${off1}`,
        "skill toggle echoed by the server",
      ),
      "skill checkbox flips and is echoed back by the server",
    );
    await c.js("document.querySelector('#skillList input').click()"); // restore
    c.check(
      await c.until(
        `document.querySelectorAll('#skillList label.off').length === ${off0}`,
        "skill toggle restored",
      ),
      "skill checkbox restored",
    );
  }

  // ── voce: the TTS voice is a selector, filled from the pack on disk, and it
  //    round-trips through /ws (the server echoes the list back when it accepts) ──
  const voices = JSON.parse(
    await c.js(
      "JSON.stringify({n: voiceSel.options.length, val: voiceSel.value," +
        " meta: voiceMeta.textContent," +
        " list: [...voiceSel.options].map(o => o.value)})",
    ),
  );
  console.log(`  voices: ${voices.n} (${voices.val}) — ${voices.meta}`);
  c.check(voices.n > 1 && !!voices.val, "voice selector filled from the TTS pack");
  c.check(voices.list.includes(voices.val), "the live voice is among the options");
  const otherVoice: string | undefined = voices.list.find((v: string) => v !== voices.val);
  if (otherVoice) {
    await c.js(
      `voiceMeta.textContent = '…in viaggio…'; voiceSel.value = ${JSON.stringify(otherVoice)};`
        + " voiceSel.dispatchEvent(new Event('change'));",
    );
    c.check(
      await c.until(
        `voiceSel.value === ${JSON.stringify(otherVoice)} && voiceMeta.textContent !== '…in viaggio…'`,
        "voice change echoed",
      ),
      `picking ${otherVoice} is accepted and echoed back`,
    );
    await c.js(
      `voiceSel.value = ${JSON.stringify(voices.val)};`
        + " voiceSel.dispatchEvent(new Event('change'));",
    );
    c.check(
      await c.until(`voiceSel.value === ${JSON.stringify(voices.val)}`, "voice restored"),
      "original voice restored",
    );
  }

  const state = JSON.parse(
    await c.js(
      "JSON.stringify({pi: piChk.checked, dis: modelSel.disabled, val: modelSel.value, badge: modeBadge.classList.contains('on')})",
    ),
  );
  console.log(`  initial: ${JSON.stringify(state)}`);
  c.check(state.dis === false, "model select always enabled (model is pickable)");
  c.check(state.pi === state.badge, "checkbox ↔ header badge agree");
  c.check(String(state.val).includes("/"), `pi leg shows a provider/id (${state.val})`);
  const opts: string[] = JSON.parse(
    await c.js(
      "JSON.stringify([...document.querySelectorAll('#modelSel option')].map(o => o.value))",
    ),
  );
  console.log(`  ${opts.length} models, first 3: ${opts.slice(0, 3).join(", ")}`);
  c.check(opts.length > 1, "pi model list comes from `pi --list-models` (not hardcoded)");
  c.check(String(await c.js("modelSel.title")).includes("PI_MODEL"), "title mentions PI_MODEL");

  // ── toggle pi OFF ──
  await c.js("piChk.click()");
  c.check(
    await c.until("!modelSel.disabled && modelSel.value.indexOf('/') < 0", "API model id"),
    "toggle OFF → API model id in the select",
  );
  c.check(await c.until("!modeBadge.classList.contains('on')", "badge off"), "toggle OFF → header badge hidden");
  c.check(await c.until("piChk.checked === false", "checkbox off"), "checkbox unticked");
  c.check(await c.until("!!ws && ws.readyState===1", "socket alive"), "socket still alive after the mode switch");

  // ── toggle pi ON again ──
  await c.js("piChk.click()");
  c.check(
    await c.until("modelSel.value.indexOf('/') >= 0", "pi model id"),
    "toggle ON → provider/id in the select",
  );
  c.check(
    await c.js("document.querySelectorAll('#modelSel option').length > 1"),
    "toggle ON → pi model list restored",
  );
  c.check(await c.until("modeBadge.classList.contains('on')", "badge on"), "toggle ON → header badge visible");
  c.check(await c.until("piChk.checked === true", "checkbox on"), "checkbox ticked");

  // ── contesto: la barra sta accanto al titolo e dice usato / totale ──
  c.check(
    await c.js("!!ctxBox && !!ctxBar && !!ctxFill && !!ctxText"),
    "context meter markup present",
  );
  const ctx0 = JSON.parse(
    await c.js(
      "JSON.stringify({near: ctxBox.parentElement === $('title'), " +
        "hidden: ctxBox.hidden, txt: ctxText.textContent})",
    ),
  );
  c.check(ctx0.near === true, "context meter sits next to «Assistente vocale»");
  c.check(ctx0.hidden === false, "bar visible on load (n_ctx is known)");
  console.log(`  context: ${ctx0.txt}`);
  // the whole point of the meter: the harness must really push it. A stale process (started
  // before the meter existed) answers hello without `context` and never emits the event —
  // the bar then sits at 0 forever, which looks like a broken bar but is a stale server.
  const live = JSON.parse(
    await c.js("JSON.stringify({got: lastCtx, txt: ctxText.textContent})"),
  );
  c.check(
    live.got !== null && live.got.total > 0,
    "a `context` event arrived on this connection (not a stale harness)",
  );
  console.log(`  live: ${JSON.stringify(live.got)}`);
  c.check(/^\S+ \/ \S+$/.test(ctx0.txt), `bar reads «usato / totale» (${ctx0.txt})`);
  // un context event finto: larghezza, colori di soglia, e «totale ignoto» = nascosta
  c.check(
    await c.js("!!ctxLabel && !!ctxPct"),
    "context meter also names itself and shows a percentage",
  );
  for (const [used, cls, pct] of [
    [8200, "", "25%"],
    [24600, "warn", "75%"],
    [31000, "hot", "95%"],
  ] as const) {
    await c.js(`onContext({used: ${used}, total: 32768})`);
    const got = JSON.parse(
      await c.js(
        "JSON.stringify({w: ctxFill.style.width, c: ctxFill.className, t: ctxText.textContent," +
          "p: ctxPct.textContent, label: ctxLabel.textContent})",
      ),
    );
    console.log(`  ${got.t} ${got.p} → ${got.w} (${got.c || "accent"})`);
    c.check(got.c === cls, `${used} tokens → ${cls || "accent"} (70%/90% thresholds)`);
    c.check(got.p === pct, `bar states the share explicitly (${got.p})`);
    c.check(
      Math.abs(parseFloat(got.w) - (used / 32768) * 100) < 0.2,
      `bar width matches ${used}/32768 (${got.w})`,
    );
  }
  await c.js("onContext({used: 1234, total: 0})");
  c.check(
    await c.js("ctxBox.hidden === true"),
    "unknown total (0) hides the bar — a bar without a denominator would lie",
  );
  c.check(await c.until("!!ws && ws.readyState===1", "socket alive"), "socket still alive");

  // ── other settings still round-trip ──
  const before = await c.js("halfChk.checked");
  await c.js("halfChk.click()");
  c.check(
    await c.until(`halfChk.checked === ${String(!before).toLowerCase()}`, "half toggle"),
    "half-duplex toggle works",
  );
  await c.js("halfChk.click()");
  c.check(
    await c.until(`halfChk.checked === ${String(before).toLowerCase()}`, "half toggle back"),
    "half-duplex toggle restored",
  );

  // ── the mic button mutes only the microphone, the speaker button (left of ↻) mutes
  //    only the assistant's voice — both are monochrome icon buttons (inline SVG) ──
  await c.js("document.getElementById('micBtn').click()");
  await sleep(400);
  const muted = JSON.parse(
    await c.js(
      "JSON.stringify({on: micOn, off: $('micBtn').classList.contains('off'),"
        + " glyph: getComputedStyle($('micBtn').querySelector('.i-off')).display !== 'none',"
        + " txt: $('micBtn').textContent,"
        + " g: playerGain && playerGain.gain.value})",
    ),
  );
  console.log(`  muted: ${JSON.stringify(muted)}`);
  c.check(muted.on === false && muted.off && muted.glyph, "the mic icon switches to mic-off");
  c.check(muted.txt.trim() === "", "the button carries an icon, not emoji text");
  c.check(Number(muted.g) > 0.5, "…but leaves the assistant's voice audible");
  await c.js("document.getElementById('micBtn').click()");
  await sleep(400);
  const back = JSON.parse(
    await c.js(
      "JSON.stringify({on: micOn, off: $('micBtn').classList.contains('off'),"
        + " glyph: getComputedStyle($('micBtn').querySelector('.i-on')).display !== 'none',"
        + " g: playerGain && playerGain.gain.value})",
    ),
  );
  c.check(back.on === true && !back.off && back.glyph, "the mic icon comes back");

  // every button is an icon button: one inline SVG, stroked with currentColor (no emoji)
  c.check(
    await c.js(
      "[...document.querySelectorAll('button')].every(b => !!b.querySelector('svg.glyph'))",
    ),
    "all buttons are monochrome icon buttons (inline SVG only)",
  );

  // the assistant-voice mute lives in the header, immediately left of ↻
  c.check(
    await c.js(
      "(()=>{const v=document.getElementById('voiceBtn'),r=document.getElementById('modelRefresh');"
        + "return !!v && v.nextElementSibling === r && r.parentElement.contains(v);})()",
    ),
    "🔊 button sits directly left of the ↻ model reload button",
  );
  await c.js("document.getElementById('voiceBtn').click()");
  await sleep(400);
  const voiceMuted = JSON.parse(
    await c.js(
      "JSON.stringify({v: voiceOn, mic: micOn, off: $('voiceBtn').classList.contains('off'),"
        + " glyph: getComputedStyle($('voiceBtn').querySelector('.i-off')).display !== 'none',"
        + " pressed: $('voiceBtn').getAttribute('aria-pressed'),"
        + " g: playerGain && playerGain.gain.value})",
    ),
  );
  console.log(`  voice muted: ${JSON.stringify(voiceMuted)}`);
  c.check(
    voiceMuted.v === false && voiceMuted.off && voiceMuted.glyph
      && voiceMuted.pressed === "false",
    "the speaker icon switches to muted",
  );
  c.check(Number(voiceMuted.g) < 0.5, "…through the playback gain");
  c.check(voiceMuted.mic === true, "…without touching the microphone");
  await c.js("document.getElementById('voiceBtn').click()");
  await sleep(400);
  const voiceBack = JSON.parse(
    await c.js(
      "JSON.stringify({v: voiceOn, off: $('voiceBtn').classList.contains('off'),"
        + " glyph: getComputedStyle($('voiceBtn').querySelector('.i-on')).display !== 'none',"
        + " g: playerGain && playerGain.gain.value})",
    ),
  );
  c.check(
    voiceBack.v === true && !voiceBack.off && voiceBack.glyph && Number(voiceBack.g) > 0.5,
    "the speaker icon comes back",
  );

  // ── ↻ refresh: the list must be re-read from pi on demand ──
  c.check(await c.js("!!document.getElementById('modelRefresh')"), "↻ refresh button present");
  await c.js("document.getElementById('modelRefresh').click()");
  c.check(
    await c.until(
      "[...document.querySelectorAll('.event')].some(e => e.textContent.indexOf('↻') === 0)",
      "refresh notice",
      60,
    ),
    "↻ answers with a freshly read model list",
  );
  c.check(
    await c.js("document.querySelectorAll('#modelSel option').length > 1"),
    "list still populated after the refresh",
  );
  c.check(
    await c.js("!document.getElementById('modelRefresh').disabled"),
    "button re-enabled once the new list arrived",
  );

  // ── type-to-filter: the filter lives inside the selector, there is no separate box ──
  c.check(
    await c.js("!document.getElementById('modelFilter')"),
    "no separate filter input — the selector itself is the filter",
  );
  const total = await c.js("document.querySelectorAll('#modelSel option').length");
  const here = await c.js("modelSel.value");
  const press = (key: string) =>
    c.js(
      `modelSel.dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(key)}, ` +
        "bubbles: true, cancelable: true}))",
    );
  const type = (s: string) =>
    c.js(
      `[...${JSON.stringify(s)}].forEach(k => ` +
        "modelSel.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true})))",
    );
  await type("gemma");
  const shown = JSON.parse(
    await c.js(
      "JSON.stringify({ value: modelSel.value, head: modelSel.options[0].textContent, " +
        "filtering: modelSel.classList.contains('filtering'), title: modelSel.title, " +
        "opts: [...document.querySelectorAll('#modelSel option')].map(o => o.value) })",
    ),
  );
  const hits: string[] = (shown.opts as string[]).filter((v) => v !== "__filter__");
  console.log(`  filter 'gemma': ${hits.length}/${total} → ${hits.slice(0, 3).join(", ")}`);
  c.check(
    shown.value === "__filter__" && shown.filtering === true,
    "typing into the selector turns it into the query line",
  );
  c.check(
    String(shown.head).includes("«gemma»") && String(shown.head).includes(`di ${total}`),
    "the query line says what you typed and how much it kept",
  );
  c.check(
    String(shown.title).includes("PI_MODEL") && String(shown.title).includes("gemma"),
    "the tooltip keeps PI_MODEL and reports the active filter",
  );
  c.check(hits.length > 0 && hits.length < total, `typing narrows the list (${hits.length}/${total})`);
  c.check(
    hits.every((h) => h === here || h.includes("gemma")),
    "every shown model matches the fragment (active one always kept)",
  );

  const nRot = await c.js(
    "[...document.querySelectorAll('.event')].filter(e => e.textContent.indexOf('↻') === 0).length",
  );
  await c.js("document.getElementById('modelRefresh').click()");
  c.check(
    await c.until(
      `[...document.querySelectorAll('.event')].filter(e => e.textContent.indexOf('↻') === 0).length > ${nRot}`,
      "refresh while filtered",
      60,
    ),
    "↻ refresh answered while a filter is active",
  );
  c.check(
    (await c.js("document.querySelectorAll('#modelSel option').length")) === hits.length + 1,
    "the filter survives a new list arriving (fillModels re-applies it)",
  );

  await press("Escape");
  c.check(
    await c.until(
      `document.querySelectorAll('#modelSel option').length === ${total}`,
      "filter cleared",
    ),
    "Esc clears the query and restores the full list",
  );
  c.check(await c.js(`modelSel.value === ${JSON.stringify(here)}`), "back to the active model");

  // ── 🔄 sits to the left of the selector it reloads (🔊 sits left of 🔄) ──
  c.check(
    await c.js(
      "document.querySelector('#modelBox').firstElementChild.id === 'voiceBtn' && " +
        "document.getElementById('voiceBtn').nextElementSibling.id === 'modelRefresh' && " +
        "document.getElementById('modelRefresh').nextElementSibling.id === 'modelSel'",
    ),
    "↻ refresh button is to the left of the model selector (🔊 leftmost of the three)",
  );

  // ── type a fragment of a model name + Enter → that model, no mouse ──
  const frag = String(
    await c.js(
      "JSON.stringify((() => { const cur = modelSel.value;" +
        " for (let n = 1; n <= cur.length; n++) {" +
        " const f = cur.slice(0, n);" +
        " if (modelList.every(m => m === cur || !m.toLowerCase().includes(f.toLowerCase()))) return f;" +
        " } return ''; })())",
    ),
  );
  await type(frag);
  c.check(
    await c.js("document.querySelectorAll('#modelSel option').length === 2"),
    `a fragment narrows the list to the one model (${frag})`,
  );
  // swallow the `model` message: Enter must be proven to *send* one, without paying for
  // a real switch (llama-server would load another model into RAM)
  await c.js(
    "window.__picked = []; window.__origSend = ws.send.bind(ws);" +
      " ws.send = (d) => { const o = JSON.parse(d);" +
      " if (o.type === 'model') { window.__picked.push(o); return; } window.__origSend(d); };",
  );
  await press("Enter");
  c.check(await c.js(`modelSel.value === ${JSON.stringify(here)}`), "Enter picks what you typed");
  c.check(
    await c.js(
      `document.querySelectorAll('#modelSel option').length === ${total} && ` +
        "!modelSel.classList.contains('filtering')",
    ),
    "Enter ends the filter and gives the full list back",
  );
  c.check(await c.js("window.__picked.length === 0"), "the active model is not re-sent");

  // …and a *different* model reached by typing really is announced to the server
  const other = JSON.parse(
    await c.js(
      "JSON.stringify((() => { const cur = modelSel.value;" +
        " const m = modelList.find(x => x !== cur); if (!m) return null;" +
        " for (let n = 1; n <= m.length; n++) {" +
        " const f = m.slice(0, n);" +
        " if (modelList.every(x => x === m || !x.toLowerCase().includes(f.toLowerCase())))" +
        " return { f, m }; } return { f: m, m }; })())",
    ),
  ) as { f: string; m: string } | null;
  if (other) {
    await type(other.f);
    await press("Enter");
    c.check(
      await c.js(`window.__picked.length === 1 && window.__picked[0].model === ${JSON.stringify(other.m)}`),
      `typing + Enter announces the other model (${other.m})`,
    );
    c.check(await c.js(`modelSel.value === ${JSON.stringify(other.m)}`), "…and shows it selected");
    await c.js("ws.send = window.__origSend; applyModelFilter();");  // un-swallow, back to the real model
    c.check(await c.js(`modelSel.value === ${JSON.stringify(here)}`), "the header still shows the active model");
  } else {
    c.check(false, "a second model exists to be picked by typing");
  }

  // ── 🧹 cleans the chat *and* the tool-calling data it had not saved yet ──
  await c.js(
    "onCommandRequest({id: 900, command: 'echo ciao', reason: 'test'}); " +
      "toolCardFor({id: 't900', tool: 'bash', phase: 'start', summary: 'ancora in corso'}); " +
      "$('partial').textContent = 'trascrizione vecchia';",
  );
  c.check(
    await c.js("!!document.querySelector('.cmd') && !!document.querySelector('.tool')"),
    "a pending command card and a running tool card are on screen",
  );
  // click + a tool event still on the wire, in one synchronous step: the server cannot
  // have acknowledged the reset yet, so this event is old-chat data
  await c.js(
    "document.getElementById('resetBtn').click(); " +
      "ws.onmessage({data: JSON.stringify({type:'tool', phase:'start', id:'t901', " +
      "origin:'pi', tool:'bash', summary:'resto vecchio'})});",
  );
  c.check(
    await c.js("!document.querySelector('.cmd') && !document.querySelector('.tool')"),
    "🧹 drops the command and tool cards, even the one still on the wire",
  );
  c.check(await c.js("$('partial').textContent === ''"), "🧹 empties the live-transcript buffer");
  c.check(
    await c.js("Object.keys(cards).length === 0 && Object.keys(toolCards).length === 0"),
    "🧹 drops the card maps too (no stale card can be reused)",
  );
  c.check(
    // whichever language LOCALE picked for the page
    await c.until("['Nuova conversazione.','New conversation.'].some(w => " +
      "[...document.querySelectorAll('.event')].some(e => e.textContent === w))", "fresh chat line"),
    "the fresh chat announces itself",
  );
  // the server's ack closes the barrier → new tool cards must render again
  await c.js("ws.onmessage({data: JSON.stringify({type:'chat_reset'})})");
  await c.js(
    "ws.onmessage({data: JSON.stringify({type:'tool', phase:'start', id:'t902', " +
      "origin:'pi', tool:'bash', summary:'dopo l ack'})});",
  );
  c.check(
    await c.js("!!document.querySelector('.tool')"),
    "once the reset is acknowledged, new tool cards render again",
  );
}

/** pi runs bash → one card, header visible, details collapsed, input/output inside. */
async function testTool(c: Ctx): Promise<void> {
  await c.open();
  await c.ensurePi();
  const n0 = await c.js("document.querySelectorAll('.tool').length");
  await c.js(
    "send({type:'text', text:'Usa il tool bash per eseguire il comando date +%H:%M:%S e dimmi l ora.'})",
  );

  c.check(
    await c.until(`document.querySelectorAll('.tool').length > ${n0}`, "tool card", 240),
    "tool card appeared",
  );
  c.check(
    await c.js("!document.querySelector('.tool details').open"),
    "details collapsed while it runs",
  );
  c.check(
    await c.until(
      "document.querySelector('.tool .badge').textContent.indexOf('esecuzione') < 0",
      "card finishing",
      240,
    ),
    "card left the running state",
  );
  const info = JSON.parse(
    await c.js(
      `JSON.stringify((() => {
        const el = document.querySelector('.tool');
        return { name: el.querySelector('.name').textContent,
                 sum:  el.querySelector('.sum').textContent,
                 badge: el.querySelector('.badge').textContent,
                 meta: el.querySelector('.meta').textContent,
                 inp:  el.querySelector('.in').textContent,
                 out:  el.querySelector('.out').textContent,
                 open: el.querySelector('details').open };
      })())`,
    ),
  );
  console.log("  card: " + JSON.stringify(info).slice(0, 400));
  c.check(info.name === "bash", "tool name is bash");
  c.check(String(info.sum).includes("date"), "header shows the command");
  c.check(
    String(info.inp).includes("date") || String(info.inp).includes("+"),
    "details hold the full input",
  );
  c.check(String(info.out).includes(":"), "details hold the command output");
  c.check(String(info.meta).includes("pi"), "meta line shows the origin");
  c.check(info.open === false, "still collapsed after completion");

  c.check(
    await c.until(
      "document.querySelector('.msg.bot .body') && document.querySelector('.msg.bot .body').textContent.length > 3",
      "assistant reply",
      120,
    ),
    "assistant reply rendered",
  );

  if (c.shot) {
    await c.js("document.querySelector('.tool details').open = true");
    const shot = await c.call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(c.shot, Buffer.from(shot.data, "base64"));
    console.log(`  screenshot: ${c.shot}`);
  }
}

/** Pick another model for the pi leg from the dropdown, then go back home. */
async function testModel(c: Ctx): Promise<void> {
  await c.open();
  await c.ensurePi();
  const home = await c.js("modelSel.value");
  const opts: string[] = JSON.parse(
    await c.js(
      "JSON.stringify([...document.querySelectorAll('#modelSel option')].map(o => o.value))",
    ),
  );
  console.log(`  ${opts.length} models, first 3: ${opts.slice(0, 3).join(", ")}`);
  c.check(opts.length > 1, "more than one model offered");
  c.check(opts.every((o) => o.includes("/")), "every option is a provider/id");
  c.check(opts.includes(PI_SMALL), `${PI_SMALL} is in the list (from pi, not hardcoded)`);

  // ── switch to the small model ──
  const n0 = await c.js("document.querySelectorAll('.event').length");
  await c.js(
    `modelSel.value = ${JSON.stringify(PI_SMALL)}; modelSel.dispatchEvent(new Event('change'))`,
  );
  c.check(
    await c.until(`modelSel.value === ${JSON.stringify(PI_SMALL)} && !modelSel.disabled`, "value updated"),
    "select keeps the new model, re-enabled",
  );
  c.check(
    await c.until(`document.querySelectorAll('.event').length > ${n0}`, "status event"),
    "status line emitted",
  );
  const ev = await c.js(
    "[...document.querySelectorAll('.event')].map(e => e.textContent).slice(-2).join(' | ')",
  );
  console.log(`  events: ${ev}`);
  c.check(
    // whichever language LOCALE gave the page ("carico il modello" / "loading model")
    ["pronto", "ready", "carico", "loading"].some((w) => String(ev).includes(w)),
    "loading → ready notice shown",
  );

  // ── it really answers through that model ──
  const n1 = await c.js("document.querySelectorAll('.msg.bot').length");
  await c.js("send({type:'text', text:'Rispondi con una sola parola: ciliegia'})");
  c.check(
    await c.until(`document.querySelectorAll('.msg.bot').length > ${n1}`, "reply", 180),
    "turn answered after the switch",
  );

  // ── back to the model we started with ──
  await c.js(`modelSel.value = ${JSON.stringify(home)}; modelSel.dispatchEvent(new Event('change'))`);
  c.check(
    await c.until(`modelSel.value === ${JSON.stringify(home)} && !modelSel.disabled`, `back to ${home}`, 240),
    `switched back to ${home}`,
  );
}

/** Command cards (driven directly) + a real turn with its latency line. */
async function testSmoke(c: Ctx): Promise<void> {
  await c.open();
  // ── command cards ──
  await c.js("cmdCard && onCommandRequest({id: 77, command: 'echo hi', reason: 'test'})");
  c.check(
    await c.js("!!document.querySelector('.cmd.pending .btns')"),
    "approval card renders with buttons",
  );
  await c.js("onCommandStart({id: 77, command: 'echo hi', auto: true})");
  c.check(await c.js("!document.querySelector('.cmd.pending')"), "card leaves the pending state");
  await c.js(
    "onCommandResult({id: 77, command: 'echo hi', status: 'exit 0', output: 'ciao\\n'})",
  );
  c.check(await c.js("!!document.querySelector('.cmd details pre')"), "output block renders");
  await c.js("document.querySelectorAll('.cmd').forEach(el => el.remove())");

  // ── a real turn, through the UI ──
  const n = await c.js("document.querySelectorAll('.msg.bot').length");
  await c.js("send({type:'text', text:'Rispondi con una sola parola: pinecone'})");
  c.check(
    await c.until(`document.querySelectorAll('.msg.bot').length > ${n}`, "assistant bubble", 180),
    "assistant bubble appeared",
  );
  c.check(
    await c.until("!!document.querySelector('.msg.bot .info')", "latency info", 120),
    "latency info line rendered",
  );
  c.check(
    await c.until("document.querySelector('.msg.bot .body').textContent.length > 0", "text", 60),
    "bubble has text",
  );
  c.check(await c.until("orb.className !== 'thinking'", "state", 120), "state left 'thinking'");
  const text = await c.js(
    "[...document.querySelectorAll('.msg.bot .body')].map(el => el.textContent).join(' | ')",
  );
  console.log(`  bubble: ${String(text).slice(0, 200)}`);

  // ── 🧹 in the middle of a turn: the half-spoken answer must not reach the new chat ──
  await c.js(
    "send({type:'text', text:'Rispondi con una frase lunga e dettagliata: descrivi un viaggio in treno'})",
  );
  await sleep(1500); // the turn is running, tokens are on their way
  await c.js("document.getElementById('resetBtn').click()");
  await sleep(12_000); // time for the old turn to finish — and, if buggy, to resurface
  await c.open(); // reload: hello.history is what the server really kept
  const left = await c.js("document.querySelectorAll('.msg').length");
  console.log(`  messages left after a mid-turn 🧹: ${left}`);
  c.check(left === 0, `a turn cut by 🧹 leaves nothing in history (${left} messages)`);
}

/** 💭 reasoning: a collapsed block that grows live and starts fresh on every turn. */
async function testReasoning(c: Ctx): Promise<void> {
  await c.open();
  await c.js("clearChat()");
  c.check(await c.js("!!document.getElementById('thinkChk')"), "ragionamento toggle present");
  c.check(
    await c.js("typeof onReasoning === 'function' && typeof onReasoningDone === 'function'"),
    "reasoning handlers defined",
  );

  // ── two deltas of one turn ──
  await c.js("onReasoning('L utente chiede 17 per 23: ')");
  await c.js("onReasoning('rispondo 391.')");
  const s = JSON.parse(
    await c.js(
      "JSON.stringify((() => { const t = document.querySelector('.think'); return {" +
        " exists: !!t, open: t && t.open, busy: t && t.classList.contains('busy')," +
        " body: t && t.querySelector('.body').textContent," +
        " cnt: t && t.querySelector('.cnt').textContent," +
        " peek: t && t.querySelector('.peek').textContent," +
        " blocks: document.querySelectorAll('.think').length }; })())",
    ),
  );
  console.log(`  ${JSON.stringify(s)}`);
  c.check(s.exists === true, "a reasoning block appears");
  c.check(s.blocks === 1, "exactly one block for the turn");
  c.check(s.open === false, "…collapsed by default");
  c.check(s.busy === true, "…and blinking while it grows");
  c.check(s.body === "L utente chiede 17 per 23: rispondo 391.", "the deltas stream into the body");
  c.check(/\u00b7 \d+ car/.test(String(s.cnt)), `the summary counts the characters (${s.cnt})`);
  c.check(
    String(s.peek).startsWith("L utente chiede"),
    "the collapsed line previews the beginning of the reasoning",
  );

  await c.js("document.querySelector('.think summary').click()");
  c.check(
    await c.js("document.querySelector('.think').open === true"),
    "clicking the summary expands it",
  );
  await c.js("onReasoningDone()");
  c.check(
    await c.js("!document.querySelector('.think').classList.contains('busy')"),
    "the busy flag clears once the answer starts",
  );

  // ── a new turn gets a block of its own (the `user` event resets it) ──
  const before = await c.js("document.querySelectorAll('.think').length");
  await c.js("send({type:'text', text:'ciao'})");
  c.check(await c.until("!!document.querySelector('.msg.user')", "user message", 30), "a turn starts");
  await c.js("onReasoning('ragionamento del turno dopo.')");
  c.check(
    (await c.js("document.querySelectorAll('.think').length")) === (before as number) + 1,
    "the next turn starts a fresh block (no appending to the old one)",
  );

  // ── the toggle exists and flips ──
  const wasOn = await c.js("thinkChk.checked");
  await c.js("thinkChk.click()");
  c.check((await c.js("thinkChk.checked")) === !wasOn, "ragionamento checkbox flips");
  await c.js("thinkChk.click()");
  c.check((await c.js("thinkChk.checked")) === wasOn, "…and flips back");

  // ── 🧹 takes the reasoning blocks with the rest of the chat ──
  await c.js("document.getElementById('resetBtn').click()");
  c.check(
    await c.until("document.querySelectorAll('.think').length === 0", "reasoning blocks wiped", 30),
    "🧹 wipes the reasoning blocks too",
  );
}

/**
 * ⟲ rewind to a checkpoint: every chat line the server put in its history carries a
 * hidden button; pressing it must cut the DOM *and* the server's history at that line,
 * announce itself, and — for a checkpoint that is no longer there — change nothing.
 */
async function testRewind(c: Ctx): Promise<void> {
  await c.open();
  // 🧹 first: this suite starts from an empty conversation, whatever the others left
  await c.js("document.getElementById('resetBtn').click()");
  c.check(
    await c.until("document.querySelectorAll('.msg').length === 0", "clean slate", 30),
    "🧹 leaves an empty chat to start from",
  );

  /** One real turn: a user bubble and an answer, both stamped with a checkpoint id. */
  const ask = async (text: string): Promise<void> => {
    const n = Number(await c.js("document.querySelectorAll('.msg[data-cp]').length"));
    await c.js(`send({type:'text', text:${JSON.stringify(text)}})`);
    c.check(
      await c.until(
        `document.querySelectorAll('.msg[data-cp]').length >= ${n + 2}`,
        "a turn with both lines checkpointed",
        240,
      ),
      `turn rendered with its checkpoint (${text.slice(0, 20)}… )`,
    );
  };

  await ask("Rispondi con una sola parola: albero");
  await ask("Rispondi con una sola parola: cactus");
  c.check(
    (await c.js("document.querySelectorAll('.msg[data-cp]').length")) === 4,
    "four checkpointed lines (2 questions, 2 answers)",
  );
  c.check(
    await c.js(
      "[...document.querySelectorAll('.msg[data-cp] .rew')].every(b => " +
        "!!b.title && b.textContent.trim() === '⟲')",
    ),
    "each of them carries a ⟲ button with its tooltip",
  );
  const ids: number[] = JSON.parse(
    await c.js("JSON.stringify([...document.querySelectorAll('.msg[data-cp]')].map(m => +m.dataset.cp))"),
  );
  console.log(`  checkpoints: ${ids.join(", ")}`);
  c.check(new Set(ids).size === ids.length, "one checkpoint id per line");

  // a line the server does not have (a turn `fitHistory` shed while this page was open):
  // it is "dead" like a dropped line, but it must not drag the cut backwards past the
  // turns the server really kept
  await c.js(
    "(() => { const g = addMsg('user', 'riga fantasma'); " +
      "g.dataset.cp = '999999'; $('log').prepend(g); })()",
  );
  c.check(
    await c.js("document.querySelectorAll('.msg')[0].textContent.indexOf('riga fantasma') >= 0"),
    "a line only this page knows is on screen",
  );

  // ⟲ on the first answer → the second question and its answer go, here and on the server
  await c.js("document.querySelectorAll('.msg')[2].querySelector('.rew').click()");
  c.check(
    await c.until("document.querySelectorAll('.msg').length === 3", "chat cut", 60),
    "the page cuts the chat from the checkpoint on (the kept lines stay)",
  );
  c.check(
    await c.until(
      "[...document.querySelectorAll('.event')].some(e => e.textContent.indexOf('⟲') >= 0)",
      "rewind notice",
      30,
    ),
    "the rewind announces itself in the chat",
  );
  c.check(
    await c.js("!document.getElementById('log').querySelector('.rew:disabled')"),
    "the buttons are usable again once the ack arrived",
  );

  await c.open(); // reload: hello.history is what the server really kept
  c.check(
    await c.until("document.querySelectorAll('.msg[data-cp]').length === 2", "history", 30),
    "the server kept exactly the lines before the checkpoint",
  );
  const kept: number[] = JSON.parse(
    await c.js("JSON.stringify([...document.querySelectorAll('.msg[data-cp]')].map(m => +m.dataset.cp))"),
  );
  c.check(
    JSON.stringify(kept) === JSON.stringify(ids.slice(0, 2)),
    "what survived kept its own ids (a second ⟲ further back is still possible)",
  );

  // ── a checkpoint that is no longer there: refused, and nothing moves ──
  await c.js("send({type:'rewind', id: 999999})");
  c.check(
    await c.until(
      "[...document.querySelectorAll('.event')].some(e => " +
        "e.textContent.toLowerCase().indexOf('checkpoint') >= 0)",
      "stale checkpoint refused",
      30,
    ),
    "a stale checkpoint says so instead of cutting anything",
  );
  c.check(
    (await c.js("document.querySelectorAll('.msg').length")) === 2,
    "…and the chat is untouched",
  );
}

const TESTS: Record<string, (c: Ctx) => Promise<void>> = {
  check: testCheck,
  reasoning: testReasoning,
  tool: testTool,
  model: testModel,
  smoke: testSmoke,
  rewind: testRewind,
};
const ORDER = ["check", "reasoning", "tool", "model", "smoke", "rewind"];

function parseArgs(argv: string[]) {
  const args = {
    tests: [] as string[],
    url: "http://127.0.0.1:8097/",
    cdp: "http://127.0.0.1:9222",
    shot: "/tmp/ui-tool-card.png",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--url") args.url = argv[++i]!;
    else if (a === "--cdp") args.cdp = argv[++i]!;
    else if (a === "--shot") args.shot = argv[++i]!;
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else args.tests.push(a);
  }
  if (!args.tests.length || args.tests.includes("all")) args.tests = [...ORDER];
  const unknown = args.tests.filter((t) => !(t in TESTS));
  if (unknown.length) {
    console.error(`unknown test(s): ${unknown.join(", ")} — choose from ${ORDER.join(", ")}, all`);
    process.exit(2);
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // wait for Chromium to expose a page
  let pages: { webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${args.cdp.replace(/\/+$/, "")}/json/list`);
      if (r.ok) {
        const list = (await r.json()) as { type?: string; webSocketDebuggerUrl?: string }[];
        pages = list
          .filter((t) => t.type === "page" && t.webSocketDebuggerUrl)
          .map((t) => ({ webSocketDebuggerUrl: t.webSocketDebuggerUrl! }));
        if (pages.length) break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  if (!pages.length) {
    console.log(
      `FAIL: no CDP page target at ${args.cdp} — is Chromium running with --remote-debugging-port?`,
    );
    return 1;
  }

  const ws = new WebSocket(pages[0]!.webSocketDebuggerUrl, { maxPayload: 64 << 20 });
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const c = new Ctx(ws, args.url, args.shot);
  await c.call("Runtime.enable");

  for (const name of args.tests) {
    c.current = name;
    console.log(`\n── ${name} ${"─".repeat(Math.max(4, 56 - name.length))}`);
    try {
      await TESTS[name]!(c);
    } catch (e) {
      c.check(false, `${name} raised: ${e instanceof Error ? e.name : "?"}: ${e}`);
    }
  }
  ws.close();

  const bad = c.results.filter((r) => !r[2]);
  console.log("\n" + "=".repeat(60));
  for (const name of args.tests) {
    const rows = c.results.filter((r) => r[0] === name);
    console.log(`  ${name.padEnd(7)} ${String(rows.filter((r) => r[2]).length).padStart(2)}/${rows.length} ok`);
  }
  console.log(
    `RESULT: ${bad.length ? "FAIL" : "PASS"} (${c.results.length} checks, ${bad.length} failures)`,
  );
  return bad.length ? 1 : 0;
}

process.exit(await main());
