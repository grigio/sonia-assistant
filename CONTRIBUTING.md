# Contributing to Sonia

Thanks for looking. This file covers the mechanics; the *why* of most of the code lives in
the comments next to it (and in the README's architecture and security sections).

## What this project is (and is not)

Sonia is a **fully local** voice assistant: an LLM (an external OpenAI-compatible
`llama-server`), streaming ASR/TTS/turn servers from `audio.cpp`, and a TypeScript hub that
owns the 32 ms frame loop. It targets **no dedicated GPU** and **under ~15 GB of RAM**.

Before proposing a dependency or a service, check it against that: a new cloud call, a
native build step, or a "just use a GPU" assumption is a design change, not a detail.

## Getting set up

```bash
bun install                      # runtime + tests; Bun is pinned in .tool-versions
cp .env.example .env             # edit SKILLS_DIR, LLM_BASE_URL/LLM_MODEL (or LLM_VIA_PI=1)
bun run fetch-and-compile-audio.cpp   # one-time audio.cpp build (vendor/ is git-ignored)
bun run models-download               # ~3.3 GiB of speech models (resumable)
systemctl --user start llama-server   # the LLM leg (external)
bun run runtime-check                 # verify every leg answers
```

`bun run start` serves the browser UI on `http://127.0.0.1:8095/`; `bun run start --cli`
and `--text` are the terminal legs. `bun run status` says what is up.

## The checks CI runs

Run these before opening a PR (the same four are in the workflow):

```bash
bun run typecheck      # tsc --noEmit, strict
bun run lint           # biome check . (format + lint)
bun run test           # unit suite (pretest = typecheck)
bun run test:all       # + the WebSocket suite (needs models/silero)
```

The native client has its own `tsconfig` and deps:

```bash
cd sonia-gtk4 && bun install && ../node_modules/.bin/tsc -p tsconfig.json
```

CI also fetches the Silero VAD (2.3 MB) for the WS suite; the full ~3.3 GiB model plan is
an opt-in job (`WITH_MODELS=true` repo variable).

## Style

- **Formatting and linting are Biome's** (`biome.json`) — run `bun run lint:fix` rather
  than fighting it. Two-space indent, double quotes, semicolons, 100-col.
- **Comments explain *why*.** The codebase's strongest convention: a non-obvious branch,
  a workaround, or a number that came from a measurement gets the reason it exists
  (often with the log line or the upstream issue that produced it). Do not narrate *what*
  the next line does — that is what the code is for.
- **New env knobs** go in `src/config.ts` *and* `.env.example` — `tests/unit/env-example.test.ts`
  fails if the two drift. A numeric knob with a sane range gets an entry in `config.ts`'s
  `RANGES`, so a typo is clamped instead of accepted.
- **New runtime settings** (things the UI drawer can flip) go through `src/settings.ts`,
  which is the only writer that persists them. `.env` stays the startup baseline.
- Keep source files focused; `src/harness/assistant.ts` is large on purpose and is
  actively being split — prefer adding a small module over growing it.

## Tests

`bun test tests/unit` is hermetic: `llama-server` and the `audio.cpp` servers are mocked,
state lives in temp dirs, and the only real file read is the Silero VAD. Add a unit test
next to the module you change; the WebSocket contract (browser ↔ harness) is pinned in
`tests/ws-skills.test.ts` via `startApp()`, which gives each `describe` its own app.

Anything touching the browser UI has a suite too: `scripts/ui-test.sh` (headless Chromium
+ a throwaway harness).

## Commits and releases

Commits follow **[Conventional Commits](https://www.conventionalcommits.org/)**
(`feat:`, `fix:`, `perf:`, `docs:`, `chore:`, …; scopes like `feat(gtk4):` are fine). The
release notes on each tag are generated from the commit range, so the prefix and the
subject matter.

To cut a release:

```bash
bun run release 0.3.0     # bumps package.json, sonia-gtk4/package.json and the PKGBUILD
git commit -am "release: v0.3.0"
git tag v0.3.0
git push && git push --tags
```

`tests/unit/version-sync.test.ts` fails if those three files ever disagree. Pushing a tag
triggers the `pkg-arch` job, which builds the Arch package and attaches it to the GitHub
release.

## Licensing

The project is **GPL-3.0-only**. Third-party components (audio.cpp, llama.cpp, the models,
your skills) keep their own licenses — see the README's license table before adding one.
By contributing you agree your changes are licensed under the same terms.
