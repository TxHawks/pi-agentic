# Recorded Pi sessions

These are raw session JSONL files from real Pi 0.85.0 children. They are not
stdout event streams. The recorder copies each SessionManager file without
changes. Each `.meta.json` file records its SHA-256, model ref, source, and
observed values. The tests must use literal expected values, not calculate
those values with the helper under test.

## Source and limits

`scripts/record-pi-session-fixtures.mjs` runs `pi -p --mode json` with a private
Pi home, work directory, and session directory. It reads the saved session
file, not stdout. It removes these temporary directories on success or failure.
Auth and provider config copies stay in the private home, never in a fixture.
The `/private/tmp/` paths in the headers are the original anonymous work paths.
Thinking signatures and provider message IDs are unchanged.

A small temporary extension supplies `caller_ping`. This tool records the
model's real `{message}` arguments and allows a final model reply. It does not
contact a parent. The extension uses `pi.appendEntry` after `agent_settled` to
save `pi-subagent-completion`. Each successful session includes a
`pi-session-fixture-origin` entry that states this source.

The `context-pressure` scenario forces that marker reason. It does **not**
fill the model's context window. These files prove the saved shapes used by
the extractors, not the live context-floor policy or parent result delivery.
They are local smoke evidence, not a release-gate pass receipt.

`provider-error.jsonl` uses Pi's real OpenAI-compatible provider against a
closed local port (`127.0.0.1:9`). It has no user provider extension and no fake
model output. Pi records the failed request and two retries.

## Recorded values

Paths below are relative to this directory.

| File | Assistant output records | Total | Completion reason |
| --- | --- | ---: | --- |
| `claude-bridge/claude-haiku-4-5/tool-ping.jsonl` | 168, 163, 111 | 442 | `normal` |
| `claude-bridge/claude-haiku-4-5/context-pressure.jsonl` | 49 | 49 | `context-pressure` |
| `openai-codex/gpt-5.3-codex-spark/tool-ping.jsonl` | 88, 39, 45 | 172 | `normal` |
| `openai-codex/gpt-5.3-codex-spark/context-pressure.jsonl` | 58 | 58 | `context-pressure` |
| `provider-error.jsonl` | 0, 0, 0 | 0 | none |

Both tool-ping sessions contain this exact call argument:

```json
{"message":"Fixture help: confirm the next step."}
```

The last assistant message in each successful session has `stopReason: "stop"`.
All three assistant messages in the error session have `stopReason: "error"`
and `errorMessage: "Connection error."`. That session has no completion marker.

## Local commands and results

These refs were approved by the recording user. They are not default refs for
other users. Ask which refs to use before another live run. The local Pi CLI
resolved them as follows:

- `claude-bridge/haiku-4-5` → `claude-bridge/claude-haiku-4-5`
- `gpt-5.3-codex-spark` → `openai-codex/gpt-5.3-codex-spark`

Both model families passed the tool-ping and context-pressure session checks.
Both tool-ping recordings have three assistant usage records, a successful
`read` result, and a successful `caller_ping` result. The error check passed
without a model service. All final recorded commands exited with code 0.

Commands used from the repository root on 2026-09-05:

```sh
TMPDIR=/tmp node scripts/record-pi-session-fixtures.mjs \
  --scenario tool-ping --model claude-bridge/haiku-4-5 \
  --extension .pi/npm/node_modules/pi-claude-bridge/src/index.ts \
  --copy claude-bridge.json

TMPDIR=/tmp node scripts/record-pi-session-fixtures.mjs \
  --scenario context-pressure --model claude-bridge/haiku-4-5 \
  --extension .pi/npm/node_modules/pi-claude-bridge/src/index.ts \
  --copy claude-bridge.json

TMPDIR=/tmp node scripts/record-pi-session-fixtures.mjs \
  --model gpt-5.3-codex-spark
```

The Claude bridge extension was the local `pi-claude-bridge` 0.7.0 install.
Each related meta file includes the extension entry file's SHA-256. Extension
paths and config file names are user-owned; use the local installed paths on
another machine. `--extension` accepts a file path, not a package source.

An initial Haiku tool-ping attempt used a terminating tool result. That run
reached the 180-second limit. A separate text-only Haiku run passed. Removing
`terminate: true` from the temporary tool allowed the tool-ping run to finish.
The failed attempt was not saved as a passing fixture. This was not a fix to
the bridge or to the real caller_ping tool.

Temporary Pi homes and sessions were removed. The four Claude Code project
session directories created by these Haiku attempts were also removed. The
recorder does not delete session files owned by provider extensions outside
its temporary root; check those locations when using an extension provider.
