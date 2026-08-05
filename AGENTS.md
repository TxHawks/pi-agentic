# AGENTS.md

Read `README.md` before doing anything. It documents the model, frontmatter, placement policies, and env vars this package exposes.

ALWAYS talk and write in STE style: short sentences, one instruction per sentence, active voice, imperative for instructions, one meaning per term. The STE writing rules apply; the approved-word dictionary does not. Always read `CONTEXT.md` files, and use their ubiquitous language. Always use jargon-free language in your writing. Only use language a common person would understand.

## Package facts

- This is a Pi package extension. The extension entrypoint is `src/index.ts`.
- Tests run on plain `node --test` (see `package.json` scripts). `npm test` and `bun test` both work.
- One-off checks (`tsc`, `biome`, `knip`) run through `bunx`, so no extra deps are declared.

## Project structure contract

Ownership organizes the repository: each file lives in the domain that owns its behavior.

Source layout:

- `src/subagents.ts` — extension wiring only: event hooks, tool registration, and thin glue.
- `src/agents/` — agent definitions, catalog messaging, and titles.
- `src/launch/` — child launch preparation, launch policy, child command construction, resume args, prompt artifacts, runtime path resolution, and session seeding.
- `src/runtime/` — running state, wait/join, shutdown, background/interactive watchers, result routing, and widgets.
- `src/session/` — JSONL session helpers and trimmed fork-session logic.
- `src/tools/` — Pi tool/command implementations and tool policy.
- `src/mux/` — multiplexer internals; `src/mux.ts` is the public barrel.
- `src/artifact-storage.ts` — artifact storage roots and paths. `src/launch/prompt-artifacts.ts` — writes launch prompt/task artifact files. Keep these two names distinct.
- `src/types.ts` — shared runtime type surface only.

Test layout:

- Tests live in `test/`; the `node --test` scripts already target it.
- Mirror source ownership in tests. Each domain suite must be imported by `test/test.ts`, or `npm test` will not run it.
- `test/support/` is split by ownership. Check its current files with `ls` rather than assuming.
- When a test probes a dynamic result shape, use a local cast at that assertion. `// @ts-nocheck` is banned.

## Naming rules

- Names encode ownership, not implementation history. Name a file after the behavior it owns. Banned shapes: history names (`new-runtime.ts`, `helpers2.ts`), split names (`part-*`, `chunk-*`), and catch-alls (`src/subagents/`, `test/parts/`, a fat `test/support.ts`, `shared.ts`).
- A generic `shared/`, `utils/`, `helpers/`, or `common/` directory needs multiple clear consumers and no better domain name.
- Barrels are public/domain entrypoints only; every re-export must have a consumer.

## File size and split rules

- Source files: split by ownership before a file passes ~600 LOC.
- Test files: ~600 LOC target, ~1000 LOC hard ceiling. Split tests along real domains only; an artificial bucket is worse than a long file.

## Validation gates

For ordinary code changes, run:

```bash
bunx tsc --noEmit
pnpm test
```

For structure/cleanup changes, also run the one-off checks, and verify file sizes before handoff:

```bash
bunx biome check .
bunx knip
node scripts/check-file-sizes.mjs
```

The size script enforces the file-size ceilings and exits non-zero on the first violation.

## Live behavior validation

Unit tests use fake mux backends. A fake pass is not proof of runtime behavior. Run a live repro before you hand off a change to:

- detached/background launches
- blocking, wait, join, or detach semantics
- prompt/runtime coordination
- frontmatter or env-var runtime branches
- session, steer, or resume behavior
- mux or pane lifecycle behavior

`docs/agents/live-testing.md` owns the live-test procedure: model selection, temporary agents, session inspection, outcome classification, and cleanup. Read it before you start a live repro.

Model and provider refs are per-user Pi config: ask the user which refs to use, and never hardcode or assume a ref in this file, in tests, or in scripts.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `TxHawks/pi-agentic`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical default labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.
