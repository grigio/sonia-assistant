# Sonia Personal Assistant

**Sonia** — an LLM + STT + TTS voice assistant that needs **no dedicated GPU** and runs
in **less than 15 GB of RAM**, entirely on a local computer.
Multilingual and full-duplex: the mic stays open while the assistant talks — interrupt
it (barge-in) and it pauses, resumes or cancels accordingly. It mirrors whichever
language you speak (English/Italian tested).

<p align="center">
  <img src="./sonia.png" alt="Sonia web UI: live transcript, timer/watch banner and settings drawer" width="700">
</p>

<p align="center">
  ▶️ <a href="https://www.youtube.com/watch?v=1WmvMO-f-24"><b>Sonia demo video</b></a>
</p>

Everything is local. The only external piece is an **OpenAI-compatible endpoint** (an
already-running `llama-server` — which can also be local, but is managed outside this
project like a runtime dependency). Experimentally and optionally, an existing `pi`
executable can be used instead of that endpoint (see *AI models used*).

**Contents** — [Features](#main-features) · [Architecture](#architecture) ·
[Models](#ai-models-used) · [Installation](#installation) · [Security](#security) ·
[Inspiration](#inspiration) · [License](#license)

---

## Main features

1. **True full-duplex listening** — the mic never closes; answers can be interrupted mid-sentence.
2. **Barge-in with echo awareness** — stricter VAD while speaking: backchannels/echo resume, real speech (≥3 words) cancels the reply and keeps the spoken part in history.
3. **Streaming ASR** — partial transcripts drive the live `🎤 …` line while you speak.
4. **Layered turn detection** — Silero VAD + silence gaps + Smart Turn classifier + a 4-token `LISTEN`/`REPLY` LLM prompt when the pause is ambiguous.
5. **Bilingual IT/EN** — the model mirrors the user's language per turn; `LOCALE=it|en` localizes the whole UI, the spoken sentences and tool results. A timer rings (and its ✕ chip is cancelled) in the language of the request that set it, not in the UI's.
6. **Function-calling tools** — `get_datetime`, `set_timer`, `start_watch`/`stop_watch`, notes (`add`/`list`/`remove`/`clear`), `list_skills`, `read_skill`, `run_command`, with 6 tool rounds per turn.
7. **Tool gate** — a cheap judge model re-checks each proposed tool against the user's actual words, so a 4B model can't run spurious calls on vague follow-ups.
8. **Shell approval policy** — `CMD_MODE=off|ask|auto`: risky commands stop at a spoken/clickable confirmation, safe and skill-directory commands run hands-free.
9. **Externally managed skills** — `SKILL.md` packages are *not* owned by this project: point `SKILLS_DIR` at the directory you already use — the `pi` coding agent's skills path, the one used by **opencode**, or any other agent harness's — and activate each skill per-turn from the UI settings drawer.
10. **Two interchangeable LLM legs** — OpenAI-compatible endpoint (default) or, **optionally and experimentally**, an existing `pi` executable (`LLM_VIA_PI=1`, toggled at runtime via a checkbox); plus a browser app-window UI and `--cli`/`--text` terminal modes.
11. **A banner over the chat** — every timer still to ring, every command still running and every watch still checking is listed at the top of the conversation with its own countdown and a ✕ that stops *that* task alone (the ring is silenced, the shell process group is killed, the loop ends) without touching the rest.
12. **Watches** — `start_watch` repeats a read-only command at an interval (≥ 5 s) for as long as the user leaves it: with `match` it stays quiet until the output starts containing that text and tells the user once ("avvisami quando il download è finito"), without it it reports the value at every check ("controlla la batteria ogni mezz'ora"). Stopped by its chip's ✕ or by `stop_watch`; 🧹 leaves it alone, like a timer.
13. **⟲ rewind to a checkpoint** — every chat line carries a ⟲ button (on hover): the line it sits on and everything before it stay — the clicked line is *never* dropped, not even an unanswered question of your own (the transcript keeps it, with its own checkpoint; only the request to the model glues the next question onto it, to keep the strict alternation the template wants) — and everything after it goes: the later turns *and* the context they take up, in the transcript and in the model's history alike, on both LLM legs. 🧹 erases the whole chat, this erases only the part you are sorry about: a line whose own tool results the cut took keeps its text (those calls go with their answers), a checkpoint that is no longer there is refused (and says so) instead of cutting at a wrong index, and pending timers/watches stay, as they do after 🧹.
14. **The conversation survives a restart** — the transcript, the model's own history and the checkpoint id of every line (⟲ included) are written to `data/chat.json` as they change, and the next start picks up exactly where the last one stopped — 🧹 and ⟲ included, since they rewrite the file too. `CHAT_PERSIST=0` keeps the old always-start-empty behaviour.

---

## Architecture

One TypeScript hub process owns the 32 ms frame loop, the queues and the state machine;
four models talk to it. The speech stack is three `audio.cpp` servers, the LLM is an
external `llama-server`, VAD runs in-process.

```
 mic (32 ms frames)
   │
   ├─► Silero VAD (in-process, ONNX)                    [src/vad.ts]
   ▼
 audio.cpp :8091  streaming ASR  ── partial + final transcript
   ▼
 HARNESS  src/harness/harness.ts — turn-end decision:
   │   pause ≥200ms → Smart Turn (:8093) ≥0.5 ⇒ end · pause ≥900ms + "not finished"
   │   → 4-token LLM prompt LISTEN/REPLY (prompts/decision.txt)
   ▼
 LLM leg  (src/clients/llm.ts / pi.ts — one interface, two backends)
   │   A) llama-server :8080 (OpenAI API)   B) `pi -c` CLI (experimental, optional)
   │   + tools: get_datetime, set_timer, start_watch/stop_watch, notes, skills, run_command
   │   + tool gate (prompts/tool-gate.txt) filters each round
   ▼
 streamed text → SentenceSplitter → sentences
   ▼
 audio.cpp :8092  TTS ── SSE PCM16 → paced Player (20 ms slices)
   ▲ barge-in: pause / resume / flush within ~one buffer
```

### Services & ports

| Port | Service | Started by |
|---|---|---|
| `:8080` | `llama-server` — OpenAI-compatible LLM (external) | *you*: `systemctl --user start llama-server` |
| `:8091` | audio.cpp **ASR** (Vulkan, iGPU) | `scripts/start-audio-servers.sh start` |
| `:8092` | audio.cpp **TTS** (CPU) | idem |
| `:8093` | audio.cpp **Smart Turn** (CPU) | idem |
| `:8095` | harness web UI — `GET /`, `GET /ws` (JSON events + binary PCM both ways) | `bun run start` (`scripts/run.ts`) |

### Code layout (`src/`, ~6.5k LOC, Bun + TypeScript)

| Area | Files |
|---|---|
| Entry points | `cli.ts` (`--web` / `--cli` / `--text` / offline WAV), `web.ts` (node:http + `ws`), `config.ts` (every knob = env var), `i18n.ts` |
| Event loop | `harness/harness.ts` (frame loop, barge-in, cancellation), `harness/assistant.ts` (state, history, system prompt, health), `harness/{turn,barge-in,sentences,queues,text}.ts` |
| Model clients | `clients/audiocpp.ts` (full-duplex raw-socket ASR + SSE TTS + Smart Turn), `clients/llm.ts` / `pi.ts` / `sse.ts` / `think.ts` |
| Capabilities | `tools.ts` + `command-policy.ts` + `shell-runner.ts`, `skills.ts`, `vad.ts` |
| Audio & UI | `audio/{mic,player,wav}.ts`, `static/index.html` (single-file vanilla UI, localized) |
| Prompts | `prompts/system.txt` (persona), `prompts/decision.txt` (turn judge), `prompts/tool-gate.txt` |

Entry-point glue: [`scripts/run.ts`](scripts/run.ts), [`scripts/stop.ts`](scripts/stop.ts)
(Bun, formerly `run.sh`/`stop.sh`); shell glue: `scripts/start-audio-servers.sh`.
Deps: `onnxruntime-node`, `ws`.

---

## AI models used

| Model | Role | Served by / device | Size |
|---|---|---|---|
| **Qwen3.5-4B-MTP** (`Q4_K_M`) | main LLM: replies, tools, turn judge, tool gate | external `llama-server` `:8080`, Vulkan | 2.7 GiB (not fetched by this repo) |
| **Voxtral Mini 4B Realtime 2602** (`q4_k`) | streaming ASR | audio.cpp `:8091`, Vulkan (B390 iGPU) | 2.9 GB |
| **Pocket TTS** (`bf16`, 5 language packs, 26 voices) | streaming TTS | audio.cpp `:8092`, CPU | ~209 MiB/pack |
| **Smart Turn v3.2** (`f32`) | end-of-turn classifier | audio.cpp `:8093`, CPU | 31 MB |
| **Silero VAD v5** (`onnx`) | voice activity detection | in-process, CPU | 2.3 MB |
| *experimental + optional*: any `pi --list-models` id | alternative LLM leg (`LLM_VIA_PI=1`) — an already-installed `pi` executable is spawned instead of the OpenAI-compatible endpoint; harness tools are off in this mode | `pi` CLI subprocess | — |

Speech models are downloaded to `models/` by `bun run models-download` (~3.3 GiB total,
idempotent/resumable) from the [audio.cpp GGUF mirror](https://huggingface.co/audio-cpp/audio.cpp-gguf).
The **LLM `.gguf` is never downloaded here** — it belongs to your external llama-server.

**Hardware footprint** — no dedicated GPU is required: ASR runs on whatever Vulkan device
is available (an iGPU is fine) or set `ASR_BACKEND=cpu`; TTS, Smart Turn and the VAD are
CPU-only, and the LLM is a 4-bit quant. Total working set stays **under 15 GB of RAM**.

---

## Installation

### Prerequisites

| What | Why |
|---|---|
| **Bun ≥ 1.x** | runtime + tests (no build step) |
| **`llama-server` on `:8080`** | the LLM leg — *not* started by this repo, must answer `/health` |
| **cmake + Ninja + Vulkan SDK** | one-time build of the vendored `vendor/audio.cpp` (no Vulkan device? build with `-DENGINE_ENABLE_VULKAN=OFF` and `ASR_BACKEND=cpu`) |
| **Chromium** in `PATH` | browser UI (optional: `--no-browser` + any browser) |
| **PipeWire** | mic/speaker in `--cli` mode (browser mode uses the tab's audio) |

### Steps

```bash
# 1. dependencies
bun install

# 2. configuration
cp .env.example .env        # git-ignored; keys mirror src/config.ts fields
#   …set SKILLS_DIR to the skills folder you already use (see "Skills" below)
#   …set LLM_BASE_URL / LLM_MODEL, or LLM_VIA_PI=1 to use an existing `pi` executable

# 3. fetch + compile the latest audio.cpp release (one step)
bun run fetch-and-compile-audio.cpp        # vendor/audio.cpp is git-ignored; re-runs are incremental
#   …same by hand:
#   git clone --depth 1 --branch <tag> https://github.com/0xShug0/audio.cpp vendor/audio.cpp
#   cmake -S vendor/audio.cpp -B vendor/audio.cpp/build -G Ninja \
#         -DCMAKE_BUILD_TYPE=Release -DENGINE_ENABLE_VULKAN=ON
#   cmake --build vendor/audio.cpp/build --target audiocpp_server
#   …or point AUDIOCPP_SERVER=/path/to/audiocpp_server at an existing binary
```

> **Why compile instead of using the official prebuilt binaries?**
> Upstream ([`0xShug0/audio.cpp`](https://github.com/0xShug0/audio.cpp)) ships Ubuntu/macOS/Windows
> binaries with every release, but they are built with `ENGINE_ENABLE_NATIVE_CPU=ON`
> (i.e. `-march=native`) on AVX-512 CI runners, so the AVX-512 instructions end up in
> `ggml_cpu_init` itself. On CPUs without AVX-512 (all Intel 12th-gen+) the process dies
> with `SIGILL` right after Vulkan init — with **both**
> `backend: vulkan` and `backend: cpu`, since the CPU backend is always registered.
> Verified against release `v0.9.1` (gdb: `ggml_cpu_init+607: vpbroadcastd %edx,%ymm17`,
> an AVX-512VL instruction). A local build works because `-march=native` then means
> plain AVX2/AVX-VNNI. *(Not a Mesa/driver issue: neither binary bundles a driver — both
> link only `libvulkan.so.1` and use the host's ICD, and the official one did enumerate
> the iGPU correctly before crashing.)*
> Revisit once upstream releases baseline-ISA binaries (e.g. `GGML_NATIVE=OFF` or
> `-DENGINE_ENABLE_CPU_ALL_VARIANTS=ON`): then `AUDIOCPP_SERVER=` can just point at the
> downloaded release and the `vendor/audio.cpp` clone (1.2 GB) can go away.

```bash
# 4. fetch the speech models (~3.3 GiB, resumable)
bun run models-download
bun run models-download --check     # verify only: ✓/✗ per file, exit 1 if missing

# 5. start the LLM (external, your own unit/config)
systemctl --user start llama-server

# 6. verify everything answers
bun run runtime-check
```

### Run

```bash
bun run start              # scripts/run.ts — prints the audio.cpp version, then starts the three
#   audio servers + the harness → ✅ ready → http://127.0.0.1:8095/ (browser UI)
bun run stop               # scripts/stop.ts --audio — harness + its window + the audio servers
bun run start --no-browser # same as start, print the URL only
bun run start --cli        # terminal through PipeWire mic/speaker
bun run start --text       # typed input
bun run scripts/stop.ts    # …only the harness + its Chromium window
bun run stop --all         # …plus llama-server (the systemd unit)
bun run stop --status      # what is running right now
```

`scripts/run.ts` checks `llama-server`, starts the three audio.cpp servers (waiting on
`/health`, printing the audio.cpp version it runs), then starts the harness (`src/cli.ts`;
it is the child's pid that lands in `data/run/harness.pid`) — which warms up
(LLM + TTS rate + ASR Vulkan graph) before it prints `ready`, so a cold model load can take
minutes. Everything private or regeneratable lives in `data/` (git-ignored): pid files and
server configs + the browser profile in `data/run/`, all logs in `data/logs/*.log`, the
notes/skills/voice choices, the conversation itself (`chat.json`, see feature 14) and the
`pi/` conversations next to them.

### Development

```bash
bun run test              # 301 tests (pretest = tsc --noEmit, strict)
bun run typecheck
bun run runtime-check     # are llama-server + ASR + TTS + turn + harness up?
scripts/ui-test.sh        # browser-UI suite (headless Chromium)
bun run stop --status     # what is running right now
```

CI (`.github/workflows/ci.yml`) runs the type check plus `bun test tests/unit` — the
hermetic half of the suite, which needs neither the speech models nor a running
llama-server; the model-dependent WebSocket suite is a second job you switch on with the
repository variable `WITH_MODELS=true`.

Full environment-variable reference: [`.env.example`](.env.example) (defaults in
[`src/config.ts`](src/config.ts)); the UI's ⚙ drawer overrides some at runtime.

### Skills

Skills are plain `SKILL.md` packages (instructions + `scripts/`) read from a single
directory — **Sonia owns none of them**. Set `SKILLS_DIR` in `.env` to whichever folder
your other tooling already uses:

| | path |
|---|---|
| `pi` coding agent | `~/.pi/agent/skills` (the default) |
| **opencode** | your opencode skills/plugins directory |
| any other agent harness | any dir with `<name>/SKILL.md` |

Which skills are *active* is chosen per-session in the UI settings drawer (persisted in
`data/skills.json`), not in `.env`. Inactive skills are never put in the prompt and
`read_skill` refuses them.

---

## Security

Everything is **localhost by design** — no login, no TLS: do not pass a non-loopback
`--host` without your own protection in front of it. `run_command` spawns `bash -c` **as
your user** with no sandbox; the policy in [`src/command-policy.ts`](src/command-policy.ts)
classes read-only commands as safe, while shell metacharacters and sensitive paths
(`.ssh`, keys, `.env`) always stop at the approval prompt in `CMD_MODE=ask`.

The `/ws` WebSocket — the control channel of the whole app — accepts a connection **only
from this server's own origin** (`originAllowed` in [`src/web.ts`](src/web.ts)): browsers
do *not* apply the same-origin policy to WebSockets, so without that check any page you
visit could open `ws://127.0.0.1:8095/ws`, read the transcript and push commands at it.
A page served elsewhere is refused at the upgrade (logged as `⛔ ws refused`); a second
window of your own takes the single client slot over, and tells the first one with a
`session_taken` event instead of leaving it a text box that quietly goes nowhere.

**Skills are out of this project's scope — verifying them is yours.** Skills come from an
external directory you point `SKILLS_DIR` at, and commands *inside that directory* are
implicitly trusted: they skip both the whitelist and the approval prompt, so they run
hands-free as your user. Before activating a skill, **you** must check what its
`SKILL.md` instructs the model to do and **which CLI commands it calls** (and via which
helper scripts) — Sonia only relays them. Treat an unreviewed skill exactly like an
unreviewed shell script, and prefer `CMD_MODE=ask` while trying new ones.

---

## Inspiration

This project answers **[Speakrail](https://github.com/speakrail/speakrail)** — a
low-latency, fully-local voice assistant that listens while it talks but it requires CUDA/Nvidia hardware and more resources.

---

## License

Released under the **[GNU General Public License v3.0](LICENSE)** (`GPL-3.0-only`).

Copyright (C) 2025 the fullduplex-assistant authors. You may redistribute it and/or
modify it under the terms of the GPLv3 as published by the Free Software Foundation.

### Third-party components are **not** covered by this license

This repository only holds *our own* source code (`src/`, `scripts/`, `prompts/`,
`static/`). Everything it pulls in or talks to ships under its **own, separate terms** —
none of them are GPL, and none of them are re-licensed by this project:

| Component | Where it lives | License |
|---|---|---|
| [`audio.cpp`](https://github.com/0xShug0/audio.cpp) (ASR/TTS/turn/VAD servers) | fetched into `vendor/` by `scripts/fetch-and-compile-audio-cpp.ts` | Apache-2.0 |
| [`llama-server`](https://github.com/ggml-org/llama.cpp) (main LLM leg) | external, you run it yourself | MIT |
| `onnxruntime-node`, `ws` (runtime deps) | `node_modules/` via `package.json` | MIT |
| `typescript`, `@types/*`, transitive deps (dev) | `node_modules/` | Apache-2.0 (typescript), MIT, ISC, BSD-3-Clause, CC0-1.0 |
| **Voxtral Mini 4B Realtime 2602** (ASR) | `models/` via `bun run models-download` | Apache-2.0 (Mistral AI) |
| **Pocket TTS** (TTS, voice packs) | `models/` | MIT ([kyutai-labs/pocket-tts](https://github.com/kyutai-labs/pocket-tts)) |
| **Smart Turn v3.2** (turn classifier) | `models/` | BSD-2-Clause (pipecat-ai) |
| **Silero VAD v5** (voice activity detection) | `models/` | MIT ([snakers4/silero-vad](https://github.com/snakers4/silero-vad)) |
| **Qwen3.5-4B-MTP** (main LLM `.gguf`) | *never fetched by this repo* — external `llama-server` | see its own model card |
| `pi` CLI (`LLM_VIA_PI=1` mode) | external executable | see the `pi` project |
| **Skills** you point `SKILLS_DIR` at | outside this repo | each skill's own terms |

The model licenses above are the **upstream** ones; the `.gguf` files under `models/`
are redistributed mirrors of those models — check both the model card *and* the mirror
before you redistribute them. To list every installed npm package with its SPDX license
locally, run:

```sh
find node_modules -maxdepth 3 -name package.json -not -path '*/node_modules/*/node_modules/*' \
  -exec node -e 'const p=require(require("path").resolve(process.argv[1]));console.log((p.license||"?").padEnd(18),p.name+"@"+p.version)' {} \; | sort -u
```

If a dependency's license conflicts with GPLv3 for your use case, that component — not
this project — is the one to review or replace.
