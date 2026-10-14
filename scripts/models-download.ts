#!/usr/bin/env bun
/**
 * `bun run models-download` — the model files this configuration needs, checked and fetched.
 *
 *   bun run models-download                 download whatever is missing (idempotent, resumable)
 *   bun run models-download --check         only verify: ✓/✗ per file, exit 1 if anything is missing
 *   bun run models-download --only vad      just one package: asr | tts | turn | vad
 *   bun run models-download -h | --help
 *
 * `--only vad` fetches the 2.3 MB Silero file alone — everything the hermetic test suite
 * needs, without the ~3.3 GiB of speech models the servers do.
 *
 * The file list comes from the same `Config` the harness itself reads (.env first, a real
 * environment variable always wins) plus ASR_PRECISION / TTS_PRECISION / ASR_GGUF /
 * TTS_GGUF / TURN_GGUF,
 * so ASR_MODEL / TTS_MODEL / TTS_LANG / TTS_VOICE / MODELS_DIR / VAD_MODEL decide what
 * is needed — an id nobody here can serve is reported instead of silently skipped.
 *
 * The LLM is NOT downloaded: the harness talks to an already-running llama-server and its
 * .gguf belongs to that service (see .env / LLM_BASE_URL); `bun run runtime-check` probes it.
 *
 * Downloads go through `<file>.part` and are renamed in place only once complete, so a
 * half-fetched file is never mistaken for a model and the next run resumes where it stopped.
 */
import fs from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Config, ROOT } from "../src/config";

const HF = "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main";
const SILERO =
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx";

/** The voices of a Pocket TTS pack (`…/<lang>/embeddings/<voice>.safetensors`) — the same
 *  26 ids ship in every language pack, so one list serves `TTS_LANG=italian|english|…`. */
const VOICES = [
  "alba", "anna", "azelma", "bill_boerst", "caro_davy", "charles", "cosette", "eponine",
  "estelle", "eve", "fantine", "george", "giovanni", "jane", "javert", "jean", "juergen",
  "lola", "marius", "mary", "michael", "paul", "peter_yearsley", "rafael", "stuart_bell", "vera",
];

/** One file to have on disk. `url` absent → checkable but not fetchable (say why in `note`).
 *  `pkg` is what `--only <pkg>` selects on — the one file a hermetic test suite needs is
 *  `vad` (2.3 MB), the whole download is ~3.3 GiB. */
type ModelFile = { path: string; url?: string; note?: string; pkg: Pkg };

/** The selectable groups of `--only` (`bun run models-download --only vad`). */
type Pkg = "asr" | "tts" | "turn" | "vad";
const PKGS: Pkg[] = ["asr", "tts", "turn", "vad"];

/** A plan entry nothing can be fetched for (`ASR_MODEL=…`) — same `pkg` as the files. */
type Skip = { pkg: Pkg; msg: string };

/** The Pocket TTS packs published under `PocketTTS-GGUF/<lang>/` on the HF repo. */
const TTS_LANGS = ["english", "german", "italian", "portuguese", "spanish"];

/** The Voxtral packages published under `Voxtral-Mini-4B-Realtime-2602-GGUF/` (`ASR_PRECISION`). */
const ASR_PRECISIONS = ["q4_k", "q8_0", "bf16"];

const tty = Boolean(process.stdout.isTTY);
const paint = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint(32, s);
const red = (s: string) => paint(31, s);
const yellow = (s: string) => paint(33, s);
const dim = (s: string) => paint(2, s);

/** Repo-relative when the path is inside the repo: `models/silero/silero_vad.onnx`. */
function rel(p: string): string {
  return p.startsWith(ROOT + path.sep) ? p.slice(ROOT.length + 1) : p;
}

/** Config paths are used as written; `./models` means the repo root, as in `bun run start`. */
function abs(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

/** Size in bytes, or null when absent/empty (an empty file counts as not downloaded). */
function sizeOf(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0 ? st.size : null;
  } catch {
    return null;
  }
}

function human(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1);
  return `${num} ${units[i]}`;
}

/**
 * The files this configuration needs. A `*_GGUF` override only moves the target: its
 * download URL is kept just when the path is still the default one, so a hand-picked
 * file is never overwritten with ours.
 */
function plan(cfg: Config): { files: ModelFile[]; skipped: Skip[]; modelsDir: string } {
  const files: ModelFile[] = [];
  const skipped: Skip[] = [];
  const modelsDir = abs(cfg.modelsDir);
  const skip = (pkg: Pkg, msg: string) => skipped.push({ pkg, msg });

  /** `key` is the env var that moved the target (ASR_GGUF / TTS_GGUF / TURN_GGUF). */
  const add = (pkg: Pkg, key: string, override: string | undefined, def: string, url: string) => {
    const target = override ? abs(override) : def;
    if (path.resolve(target) === path.resolve(def)) files.push({ path: target, url, pkg });
    else
      files.push({
        path: target,
        pkg,
        note: `${key} points elsewhere — no download source, place the file there yourself`,
      });
  };

  // ASR — Voxtral Mini 4B Realtime (streaming), `ASR_PRECISION` picks the package
  const asrPrecision = (process.env.ASR_PRECISION ?? "q4_k").trim() || "q4_k";
  const asrName = `voxtral-mini-4b-realtime-2602-${asrPrecision}.gguf`;
  const asrDef = path.join(modelsDir, "Voxtral-Mini-4B-Realtime-2602-GGUF", asrName);
  if (cfg.asrModel !== "voxtral") {
    skip("asr", `ASR_MODEL=${cfg.asrModel} — no download source known for it (add one in scripts/models-download.ts)`);
  } else if (ASR_PRECISIONS.includes(asrPrecision)) {
    add("asr", "ASR_GGUF", process.env.ASR_GGUF, asrDef,
      `${HF}/Voxtral-Mini-4B-Realtime-2602-GGUF/${asrName}`);
  } else {
    // still tracked (so `--check` fails instead of passing on an unservable path), but
    // without a URL: only the packages above are published on the mirror
    files.push({
      path: asrDef,
      pkg: "asr",
      note: `ASR_PRECISION=${asrPrecision} — not a published Voxtral package (known: ${ASR_PRECISIONS.join(" | ")})`,
    });
  }

  // TTS — Pocket TTS (`TTS_LANG` picks the pack: english | german | italian | …) + its voices
  const lang = cfg.ttsLang.trim().toLowerCase();
  if (cfg.ttsModel !== "pocket-it") {
    skip("tts", `TTS_MODEL=${cfg.ttsModel} — no download source known for it (add one in scripts/models-download.ts)`);
  } else if (!TTS_LANGS.includes(lang)) {
    skip("tts", `TTS_LANG=${cfg.ttsLang} — not a published Pocket TTS pack (known: ${TTS_LANGS.join(" | ")})`);
  } else {
    const precision = (process.env.TTS_PRECISION ?? "bf16").trim() || "bf16";
    const packDir = path.join(modelsDir, "PocketTTS-GGUF", lang);
    add("tts", "TTS_GGUF", process.env.TTS_GGUF, path.join(packDir, `pocket-tts-${lang}-${precision}.gguf`),
      `${HF}/PocketTTS-GGUF/${lang}/pocket-tts-${lang}-${precision}.gguf`);

    const voicesDir = abs(cfg.ttsVoicesDir);
    if (path.resolve(voicesDir) === path.resolve(path.join(packDir, "embeddings"))) {
      for (const v of VOICES) {
        files.push({
          path: path.join(voicesDir, `${v}.safetensors`),
          pkg: "tts",
          url: `${HF}/PocketTTS-GGUF/${lang}/embeddings/${v}.safetensors`,
        });
      }
      if (!VOICES.includes(cfg.ttsVoice)) {
        skip("tts", `TTS_VOICE=${cfg.ttsVoice} — not one of the ${VOICES.length} voices of the pack; set TTS_VOICE_DIR to your own dir of <voice>.safetensors`);
      }
    } else {
      // a custom voice dir (TTS_VOICE_DIR): only the selected voice can be checked here
      files.push({
        path: path.join(voicesDir, `${cfg.ttsVoice}.safetensors`),
        pkg: "tts",
        note: "custom TTS_VOICE_DIR — no download source, place the file there yourself",
      });
    }
  }

  // turn — Smart Turn v3.2 (end-of-turn classifier)
  const turnDef = path.join(modelsDir, "Smart-Turn-v3-GGUF", "smart-turn-v3.2-f32.gguf");
  if (cfg.turnModel === "smart-turn") {
    add("turn", "TURN_GGUF", process.env.TURN_GGUF, turnDef, `${HF}/Smart-Turn-v3-GGUF/smart-turn-v3.2-f32.gguf`);
  } else {
    skip("turn", `TURN_MODEL=${cfg.turnModel} — no download source known for it (add one in scripts/models-download.ts)`);
  }

  // VAD — Silero v5, ONNX, in-process (always needed, whatever the servers do)
  files.push({ path: abs(cfg.vadModel), url: SILERO, pkg: "vad" });

  return { files, skipped, modelsDir };
}

/** ✓/✗ per file. Returns 1 when something is missing. */
function check(files: ModelFile[], skipped: Skip[], modelsDir: string, mode: Mode): number {
  let missing = 0;
  let onDisk = 0;
  const label = (f: ModelFile) => rel(f.path).padEnd(84);

  for (const f of files) {
    const size = sizeOf(f.path);
    if (size !== null) {
      onDisk += size;
      console.log(`${green("✓")} ${label(f)} ${dim(human(size))}`);
      continue;
    }
    const partial = sizeOf(`${f.path}.part`);
    const why = partial
      ? dim(`partial ${human(partial)} — resumes on the next run`)
      : f.note
        ? dim(`MISSING — ${f.note}`)
        : "MISSING";
    console.log(`${red("✗")} ${label(f)} ${why}`);
    missing++;
  }

  console.log();
  for (const s of skipped) console.log(`${yellow("?")} ${s.msg}`);
  if (skipped.length) console.log();

  if (missing) {
    console.log(`${missing} of ${files.length} model files missing` +
      (mode === "check" ? " → run: bun run models-download" : ""));
    console.log(dim(`(on disk: ${human(onDisk)} in ${rel(modelsDir)})`));
  } else {
    console.log(`all ${files.length} model files present (${human(onDisk)})`);
  }
  console.log(dim("the LLM is not downloaded here — `bun run runtime-check` probes llama-server"));
  return missing ? 1 : 0;
}

/** Byte total of the response, if the server says it. */
function totalOf(res: Response, start: number): number {
  const range = res.headers.get("content-range"); // "bytes 1024-4095/4096"
  const at = range && /\/(\d+)\s*$/.exec(range);
  if (at?.[1]) return Number(at[1]);
  const len = res.headers.get("content-length");
  return len ? start + Number(len) : 0;
}

const progressOn = (got: number, total: number) => {
  const pct = total ? Math.min(100, Math.floor((got / total) * 100)) : 0;
  const bar = total && tty ? ` (${pct}%)` : "";
  process.stdout.write(`\r\x1b[K  ${human(got)}${total ? ` / ${human(total)}` : ""}${bar}`);
};
const progressOff = () => tty && process.stdout.write("\r\x1b[K");

/** Fetch `url` into `f.path` via a resumable `.part`, renamed only when complete. */
async function fetchInto(f: ModelFile): Promise<number> {
  const part = `${f.path}.part`;
  fs.mkdirSync(path.dirname(f.path), { recursive: true });
  let start = sizeOf(part) ?? 0; // what a previous run left behind

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(f.url!, {
        headers: start > 0 ? { Range: `bytes=${start}-` } : {},
      });
      if (res.status === 416 && start > 0) {
        // the partial already covers the whole file (server refused a further range)
        fs.renameSync(part, f.path);
        return sizeOf(f.path) ?? start;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const append = res.status === 206 && start > 0;
      if (!append) start = 0; // 200 → start over, whatever the .part held
      const total = totalOf(res, start);

      const ws = fs.createWriteStream(part, { flags: append ? "a" : "w" });
      const reader = res.body.getReader();
      let got = start;
      let painted = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.byteLength;
          if (!ws.write(value)) await once(ws, "drain");
          if (tty && Date.now() - painted > 120) {
            painted = Date.now();
            progressOn(got, total);
          }
        }
      } finally {
        await new Promise<void>((resolve) => ws.end(() => resolve()));
      }
      progressOff();

      if (total && got < total) throw new Error(`truncated at ${human(got)} of ${human(total)}`);
      fs.renameSync(part, f.path); // complete → now it is a model file
      return sizeOf(f.path) ?? got;
    } catch (err) {
      progressOff();
      if (attempt >= 3) throw err;
      start = sizeOf(part) ?? 0; // whatever landed on disk is worth keeping
      await Bun.sleep(1000 * attempt);
    }
  }
}

async function download(files: ModelFile[], modelsDir: string): Promise<number> {
  fs.mkdirSync(modelsDir, { recursive: true });
  let failed = 0;
  let fetched = 0;

  for (const f of files) {
    if (sizeOf(f.path) !== null) {
      console.log(`${green("✓")} ${rel(f.path)}`);
      continue;
    }
    if (!f.url) {
      console.log(`${red("✗")} ${rel(f.path)} ${dim(`MISSING — ${f.note ?? "no download source"}`)}`);
      failed++;
      continue;
    }
    console.log(`${yellow("↓")} ${rel(f.path)}`);
    try {
      const bytes = await fetchInto(f);
      fetched++;
      console.log(`  ${dim(`→ ${human(bytes)}`)}`);
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      const partial = sizeOf(`${f.path}.part`);
      console.log(`  ${red(`failed: ${reason}`)}` +
        (partial ? dim(` — ${human(partial)} kept, resumes on the next run`) : ""));
    }
  }

  if (fetched || failed) console.log();
  if (fetched) console.log(dim(`${fetched} file(s) fetched → ${rel(modelsDir)}`));
  return failed;
}

function usage(): void {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const doc = /\/\*\*([\s\S]*?)\*\//.exec(src)?.[1] ?? "";
  console.log(
    doc
      .split("\n")
      .map((l) => l.replace(/^\s*\* ?/, ""))
      .join("\n")
      .trim(),
  );
}

type Mode = "download" | "check";

async function main(): Promise<number> {
  let mode: Mode = "download";
  let only: Pkg | null = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--check" || arg === "check") mode = "check";
    else if (arg === "-h" || arg === "--help") {
      usage();
      return 0;
    } else if (arg === "--only" || arg.startsWith("--only=")) {
      const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      const pkg = PKGS.find((p) => p === raw);
      if (!pkg) {
        console.error(`--only: '${raw ?? ""}' is not a package (known: ${PKGS.join(", ")})`);
        return 2;
      }
      only = pkg;
    } else {
      console.error(`unknown option: ${arg} (try --help)`);
      return 2;
    }
  }

  const cfg = Config.fromEnv(); // .env first, a real environment variable wins
  const { files, skipped, modelsDir } = plan(cfg);
  // `--only` selects one package; the others are not this run's business (their *missing*
  // files must not make `--check` fail here, and their skips must not clutter the output)
  const chosen = only ? files.filter((f) => f.pkg === only) : files;
  const chosenSkips = only ? skipped.filter((s) => s.pkg === only) : skipped;
  if (only)
    console.log(dim(`--only ${only}: ${chosen.length} of ${files.length} file(s)`));
  if (mode === "check") return check(chosen, chosenSkips, modelsDir, mode);

  const failed = await download(chosen, modelsDir);
  const missing = check(chosen, chosenSkips, modelsDir, mode);
  return failed || missing ? 1 : 0;
}

process.exit(await main());
