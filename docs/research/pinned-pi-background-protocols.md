# Pinned Pi background protocols

## Scope and source grade

This note answers issue #7. It checks the Pi source that this worktree installs. It does not run a model-backed check.

**Fact.** `package.json` requests `@earendil-works/pi-coding-agent` `^0.84.0`. The lock file resolves `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-client`, `pi-protocol`, and `pi-tui` to `0.84.0`. [Primary source: `/Volumes/code/pi-agentic/feat-better-bg-subagents/package.json#L39-L43`; `/Volumes/code/pi-agentic/feat-better-bg-subagents/pnpm-lock.yaml#L145-L171`, `#L1010-L1053`]

**Fact.** The installed package reports version `0.84.0`, requires Node `>=22.19.0`, and uses the Pi repository `earendil-works/pi`, directory `packages/coding-agent`. [Primary source: installed `node_modules/.pnpm/@earendil-works+pi-coding-agent@0.84.0_.../node_modules/@earendil-works/pi-coding-agent/package.json#L1-L8`, `#L92-L100`]

**Observation.** The exact inspected files are the installed `0.84.0` distribution under the path above. The package documentation and the executable code differ in one important detail: the executable converts streaming JSON events before writing them. [Primary source: `dist/modes/print-mode.js#L62-L75`; `dist/modes/rpc/rpc-mode.js#L243-L252`; `dist/modes/json-event.js#L1-L11`]

## Print and JSON mode

**Fact.** `pi --mode json <prompt>` is a one-shot process. It writes the session header, then session events, and then disposes the runtime. JSON records use one JSON object per line. [Primary source: `docs/json.md#L1-L5`; `dist/modes/print-mode.js#L85-L107`, `#L125-L141`]

**Fact.** The JSON header is the session header, normally shaped as `{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}`. [Primary source: `docs/json.md#L35-L45`; `dist/modes/print-mode.js#L85-L88`]

**Fact.** Print mode does not read a control protocol from stdin. It accepts its prompt from CLI arguments and exits after the prompt completes. [Primary source: `dist/modes/print-mode.js#L20-L24`, `#L89-L107`]

**Inference.** A detached child launched with `--mode json` is suitable for read-only observation. It is not suitable for parent-to-child steering without starting a different process or using another control design.

## RPC framing and command results

**Fact.** RPC uses JSON Lines on stdin and stdout. The delimiter is LF (`\n`) only. A client may accept CRLF input by stripping a final `\r`; Unicode line separators are valid JSON-string characters and must not split a record. [Primary source: `docs/rpc.md#L24-L40`; `dist/modes/rpc/jsonl.js#L1-L90`]

**Fact.** Commands are JSON objects with `type` and an optional `id`. Responses have `type: "response"`, `command`, `success`, and optional `data` or `error`. A response keeps the request `id` when one was supplied. [Primary source: `docs/rpc.md#L42-L57`; `dist/modes/rpc/rpc-mode.js#L24-L35`, `#L555-L590`; `dist/modes/rpc/rpc-types.d.ts#L13-L124`]

**Fact.** RPC supports active input and control: `prompt`, `steer`, `follow_up`, `abort`, `abort_bash`, `abort_retry`, model and thinking changes, queue-mode changes, compaction, session switching, fork/clone, and state/message/statistics queries. The exact command union is in the installed type declaration. [Primary source: `dist/modes/rpc/rpc-types.d.ts#L13-L124`; `dist/modes/rpc/rpc-mode.js#L277-L552`]

**Fact.** A prompt accepted while streaming must provide `streamingBehavior: "steer"` or `"followUp"`. `steer` is delivered after the current assistant turn's tool calls and before the next model call. `follow_up` waits until the agent finishes. [Primary source: `docs/rpc.md#L65-L102`; `dist/modes/rpc/rpc-mode.js#L296-L325`]

**Fact.** `abort` returns success after the session abort request is made. It does not promise that an already-running external tool stopped at that exact instant. Tool code must honor its abort signal. [Primary source: `dist/modes/rpc/rpc-mode.js#L337-L340`; installed `pi-agent-core/dist/types.d.ts#L177-L188`, `#L250-L270`]

**Fact.** A malformed input record returns `{"type":"response","command":"parse","success":false,"error":"..."}`. An unknown command returns a failed response. [Primary source: `dist/modes/rpc/rpc-mode.js#L563-L590`; `#L545-L552`]

## Event framing and exact shapes

**Fact.** Both JSON mode and RPC call `toJsonEvent` before writing session events. For `message_update`, the wire event contains only `type` and `assistantMessageEvent`. The outer cumulative `message` field is removed. If the assistant event has `partial`, that cumulative `partial` field is also removed. The final `message_end` still contains the authoritative full message. [Primary source: installed `dist/modes/json-event.js#L1-L11`; its source map `dist/modes/json-event.js.map` contains the exact `src/modes/json-event.ts` source; `dist/modes/print-mode.js#L68-L75`; `dist/modes/rpc/rpc-mode.js#L243-L252`]

**Fact.** The session event union includes the core agent events plus `agent_settled`, `queue_update`, `compaction_start/end`, `entry_appended`, `session_info_changed`, `thinking_level_changed`, retry events, summarization retry events, and `bash_execution_update`. `agent_end` includes `messages` and `willRetry`. [Primary source: `dist/core/agent-session.d.ts#L40-L106`]

**Fact.** A normal event sequence includes `agent_start`, `turn_start`, message events, tool events when tools run, `turn_end`, `agent_end`, and then `agent_settled` when the session has settled. `agent_end` is not the same as settlement. [Primary source: installed `pi-agent-core/dist/types.d.ts#L177-L225`; `dist/core/agent-session.d.ts#L40-L52`; `dist/modes/rpc/rpc-mode.js#L243-L252`]

### Partial text and thinking

**Fact.** Assistant stream events have these exact forms: `text_start`/`thinking_start` with `contentIndex`; `text_delta` with `contentIndex` and `delta`; `thinking_delta` with `contentIndex` and `delta`; and `text_end`/`thinking_end` with `contentIndex` and complete `content`. Start and delta events also have an internal cumulative `partial`, but the JSON/RPC wire conversion removes it. [Primary source: installed `pi-ai/dist/types.d.ts#L383-L414`; `dist/modes/json-event.js#L5-L11`]

**Fact.** A successful assistant stream ends with `{"type":"done","reason":"stop"|"length"|"toolUse"|"deferred","message":<AssistantMessage>}`. An error stream ends with `{"type":"error","reason":"aborted"|"error","error":<AssistantMessage>}`. [Primary source: installed `pi-ai/dist/types.d.ts#L415-L434`]

### Tools

**Fact.** Tool activity uses `tool_execution_start` with `toolCallId`, `toolName`, and `args`; zero or more `tool_execution_update` records with the same identity and cumulative `partialResult`; and `tool_execution_end` with `toolCallId`, `toolName`, `result`, and `isError`. [Primary source: installed `pi-agent-core/dist/types.d.ts#L177-L225`; `docs/rpc.md#L1010-L1080`]

**Fact.** Tool calls in assistant message content use `{type:"toolCall",id,name,arguments}`. Tool result messages use `{role:"toolResult",toolCallId,toolName,content,details?,usage?,isError,timestamp}`. [Primary source: installed `pi-ai/dist/types.d.ts#L245-L266`, `#L290-L317`]

### Usage, errors, and settlement

**Fact.** Usage is part of the final `AssistantMessage`, not a separate usage event. Its shape has `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and a nested `cost` object. Optional fields include `cacheWrite1h` and `reasoning`. Tool results can also carry optional tool usage. [Primary source: installed `pi-ai/dist/types.d.ts#L253-L267`, `#L290-L317`]

**Fact.** Provider errors are represented in the final assistant message with `stopReason: "error"` or `"aborted"` and `errorMessage`. The stream error event carries the same final assistant message in its `error` field. Retry and compaction errors have their own session events. [Primary source: installed `pi-ai/dist/types.d.ts#L280-L288`, `#L425-L434`; `dist/core/agent-session.d.ts#L65-L106`]

**Fact.** Settlement is explicit in the session event union as `{type:"agent_settled"}`. The RPC implementation watches that event for shutdown requests, but it does not exit merely because the agent settled. [Primary source: `dist/core/agent-session.d.ts#L40-L52`; `dist/modes/rpc/rpc-mode.js#L249-L252`, `#L535-L552`]

## Partial records and schema stability

**Fact.** JSONL records are independently framed. A reader can process complete lines while a producer is still running. [Primary source: `docs/rpc.md#L24-L40`; `dist/modes/rpc/jsonl.js#L1-L90`]

**Fact.** Partial assistant records are deltas. They do not carry a full partial assistant snapshot on the JSON/RPC wire in 0.84.0. Reconstruct text and thinking by applying deltas by `contentIndex`; use `message_end` or the `done` event for the final authoritative message. [Primary source: `dist/modes/json-event.js#L1-L11`; installed `pi-ai/dist/types.d.ts#L383-L434`]

**Observation.** The public docs show a `message_update.message` and `assistantMessageEvent.partial` in examples, but the installed conversion code removes both for events that contain `partial`. Treat the installed executable as higher-grade evidence than the example. [Primary source: `docs/rpc.md#L925-L980`; `dist/modes/json-event.js#L5-L11`]

**Unknown.** The package does not state a cross-version schema-compatibility promise. Consumers must pin the package and test the concrete version. The `AgentSessionEvent` union already expanded beyond the short event list in the JSON guide, so consumers should ignore unknown event types and preserve unknown fields. [Primary source: `dist/core/agent-session.d.ts#L40-L106`; `docs/json.md#L8-L31`]

## Input, control, resume, and hibernation

**Fact.** RPC supports prompt input, mid-run steering, queued follow-up input, abort, and explicit session controls. It also supports `switch_session`, `fork`, and `clone`. [Primary source: `dist/modes/rpc/rpc-types.d.ts#L13-L124`; `docs/rpc.md#L65-L102`, `#L700-L900`]

**Fact.** RPC has no hibernation command and no automatic hibernation after `agent_settled`. Its implementation returns a never-resolving promise and stays alive until stdin ends or a termination signal arrives. [Primary source: `dist/modes/rpc/rpc-mode.js#L535-L552`, `#L643-L653`]

**Inference.** A parent can resume a persisted session by starting another Pi process with that session or by using `switch_session`, but this is session switching, not a hibernated RPC child that wakes on a later message. [Primary source: `docs/rpc.md#L700-L840`; `dist/modes/rpc/rpc-mode.js#L403-L415`]

**Fact.** Extension UI is a bridge, not a full TUI. Dialogs (`select`, `confirm`, `input`, `editor`) use request/response records. Notifications, status, widgets, title, and editor text are fire-and-forget. Custom components, custom TUI, footer/header components, themes, raw terminal input, and tool expansion are unsupported or degraded. [Primary source: `docs/rpc.md#L1180-L1370`; `dist/modes/rpc/rpc-mode.js#L72-L212`]

## Parent exit and platform limits

**Fact.** RPC shuts down on stdin `end`. It also handles `SIGTERM`; it handles `SIGHUP` only when `process.platform !== "win32"`. It exits with 143 for SIGTERM and 129 for SIGHUP. [Primary source: `dist/modes/rpc/rpc-mode.js#L271-L275`, `#L353-L373`, `#L555-L653`]

**Inference.** A directly parent-owned RPC child is not parent-exit independent: closing the parent's RPC pipe gives the child stdin EOF, which invokes shutdown. A detached design needs a separate owner of the RPC stdin/stdout pipes. This is an integration inference, not a claim that Pi itself supplies a supervisor. [Primary source: `dist/modes/rpc/rpc-mode.js#L643-L653`; `docs/rpc.md#L24-L57`]

**Fact.** Print/JSON mode handles SIGTERM and non-Windows SIGHUP, and disposes its runtime before exit. [Primary source: `dist/modes/print-mode.js#L30-L50`, `#L125-L141`]

**Fact.** Windows Pi requires a Bash shell. The documented search order is configured `shellPath`, Git Bash, then `bash.exe` on PATH. [Primary source: installed `docs/windows.md#L1-L15`]

**Fact.** The package requires Node `>=22.19.0`. [Primary source: installed `package.json#L92-L100`]

**Unknown.** The inspected Pi source does not define a portable process-group or parent-death policy for background children. It defines stdin EOF and signal handling only. Do not infer parent-survival, process-group killing, or hibernation from `--mode json` or `--mode rpc` alone.

## Resolution

For a headless background child, `--mode json` gives a one-way, line-framed event stream with text, thinking, tool, error, usage, and settlement evidence. RPC adds a two-way command channel and limited extension UI requests. RPC supports steering and abort, but it does not hibernate, and a directly parent-owned RPC pipe ends the child when stdin closes. A background supervisor would be required for parent-independent RPC control. The source does not support generic TUI interaction or a built-in parent-exit continuation policy.
