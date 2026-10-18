# Pull request

## What this changes

<!-- One paragraph. Link the issue it closes, if there is one. -->

## Why

<!-- The problem, not the patch. What was wrong / missing before this? -->

## How it was tested

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run test` (unit; add `bun run test:all` for the WebSocket suite)
- [ ] the GTK4 client still type-checks: `cd sonia-gtk4 && bun install && ../node_modules/.bin/tsc -p tsconfig.json`
- [ ] manual check (describe it below — voice/UI changes need one)

<!-- Anything not covered above: the command you ran, the env, what you saw. -->

## Notes for the reviewer

<!-- Trade-offs, follow-ups, things you deliberately did not touch. -->

---

<sub>Please use [Conventional Commits](https://www.conventionalcommits.org/) — the release
notes are generated from them (see `CONTRIBUTING.md`). Keep the diff focused; a refactor
and a behaviour change are two PRs.</sub>
