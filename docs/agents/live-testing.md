# Live testing: subagent runtime behavior

How to run a live repro for changes to subagent runtime behavior. `AGENTS.md` names the triggers; this file owns the procedure, the outcome classification, and the cleanup.

## Model refs are per-user

Model and provider refs are part of each user's own Pi config. Another contributor's Pi will not have the same providers.

- Ask the user which model to use for any live Pi run (`PI_SUBAGENT_LIVE_MODEL=provider/model[:thinking]` for the Herdr smokes).
- Prefer `thinking high` for non-trivial orchestration changes.
- A single-model pass is not proof. Test with at least two models from different families the user has available.

## Load-bearing live probes

The launch wrapper's real signal behavior is proven only by the Tier B live
probes: the wrapper's TERM trap, the Pi child's clean SIGTERM exit (wait
status 143), and the exit-record write after a parent death. The unit tests
run on the scripted fake launcher and on plain `sh` children; they cannot
prove Pi's signal handling. The Tier B probes are load-bearing and must
never be weakened.

## Temporary live-test agents

This repo does not commit fixed smoke agents (`.pi/` is gitignored). For each live repro, create a temporary agent file shaped for the behavior under test, either under `.pi/agents/` or under a temp root pointed at by `PI_CODING_AGENT_DIR`. Remove it (or set `enabled: false`) once the repro is done.

## Standard procedure

- Prefer `pi -p` for deterministic repros.
- Use a temporary `--session-dir`.
- Inspect session JSONL when behavior is subtle.
- Check both parent and child sessions.
- For env-var or frontmatter branches, test both the enabled and the disabled state.

## Classify parent/child outcomes

Classify each outcome:

- `duplicate` — parent and child did the same work.
- `auxiliary` — child did work that did not advance the parent's goal.
- `clean_yield` — child did the delegated work and the parent surfaced it.

For guard or coordination changes, verify three things: direct parent tools were blocked when expected, allowed when opt-out was enabled, and the behavior held for the full parent response rather than one internal continuation step.

## Cleanup

- Restore or delete temporary agent files created for the repro.
- Remove temporary session dirs that are no longer needed.
- Clear test-only environment variables.
