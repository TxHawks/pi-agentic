# pi-peer and intra-agent communication

## What pi-peer is

This report uses the repository at <https://github.com/shift-labs-ai/pi-peer>,
cloned at commit `7e1bf270246f2f170c9dfd63ff2d2b3e42e7ddf7` (the shallow clone's HEAD was `7e1bf27`; the repository reports
version `0.1.0` in `package.json`). It is a Pi extension for messaging between
Pi sessions on one machine. It is not a child-process supervisor. It gives each
session `list_peers`, `message_peer`, and `/peers`.

The design uses a shared directory under `~/.pi/agent/peers` by default. Each
session has a record and an inbox. A sender writes a JSON letter into the target
inbox. There is no daemon, socket, HTTP server, MCP transport, or standing
connection. The README states this directly in `README.md:95-100`; the shape and
file layout are in `ARCHITECTURE.md:3-17`.

## Facts

### Transport and message model

- Transport is a shared filesystem directory. `src/peer/mailbox.ts:64-75`
  writes a temporary file and renames it to a `.json` file. The rename prevents
  a reader from seeing a partial letter.
- A letter is plain text plus sender id, sender name, sender working directory,
  and send time. `src/peer/mailbox.ts:17-25`. Text is capped at 32 KiB,
  including room for the JSON envelope (`mailbox.ts:27-31,64-74`). The README
  says it sends text, not history or files (`README.md:17-22`).
- The receiver drains `.json` files in sorted filename order and removes each
  file before handing the parsed letter to Pi (`mailbox.ts:111-139`). The
  architecture calls this oldest-first and describes the same sequence
  (`ARCHITECTURE.md:19-33`). This gives an intended order for a burst, but there
  is no global ordering across senders or a durable sequence number.
- A live sender waits up to 1.5 seconds for its letter file to disappear. The
  disappearance is reported as `delivered`; a file still present is `queued`
  (`mailbox.ts:30-34,78-93`; `extension/index.ts:236-245`). This is a receipt for
  mailbox consumption, not proof that the Pi model has processed the message.
- `fs.watch` gives prompt notification. A 3-second poll is the backstop when a
  filesystem event is missed (`mailbox.ts:157-199`; `ARCHITECTURE.md:138-151`).
  The watch is debounced, and a startup drain collects mail already waiting.
- The inbound guard can accept, ask the user, refuse, or drop mail. It drops
  identical repeats within 10 seconds, limits a sender to eight messages per 30
  seconds, and caps pending letters at 50 (`src/peer/policy.ts:11-36,67-95`).

### Discovery and identity

- A session writes a record with name, working directory, Pi session id, session
  file, pid, heartbeat time, and idle/working state (`src/peer/registry.ts:24-50`).
- The mailbox id is a hash of working directory plus Pi session id. It therefore
  follows a saved conversation across restarts and separates two sessions in
  one directory (`registry.ts:85-101`; `ARCHITECTURE.md:39-42`). Names are for
  people and can be ambiguous; resolution refuses to guess and lists candidates
  (`registry.ts:259-310`; `extension/index.ts:212-227`).
- Presence is inferred from pid existence and a heartbeat. A missing pid is
  offline; an old heartbeat is stalled; a fresh heartbeat is live
  (`registry.ts:44-61,189-205`). The README says the directory and files are
  mode `0700`/`0600` (`README.md:60-63`), and the code creates those modes
  (`registry.ts:75-83,108-114`).

### Delivery, crash, and disconnect behavior

- If the target is not running, the letter remains in its inbox and is read when
  the saved session resumes. A clean shutdown removes the pid but keeps the
  record and inbox (`registry.ts:117-129`; `extension/index.ts:160-175`). The
  exchange test covers offline delivery and later resume (`test/exchange.test.ts`,
  section `a session that is not running`).
- If a target is wedged, its stale record says `stalled`; mail waits rather than
  bouncing (`registry.ts:44-50,202-205`; `ARCHITECTURE.md:138-150`).
- A watcher error or missed event does not stop the session. Polling finds mail
  later (`mailbox.ts:187-199`). A corrupt JSON letter is discarded, so it does
  not block later letters (`mailbox.ts:129-139`).
- Sweeping keeps a non-empty mailbox for 30 days. It only removes an empty
  mailbox when its saved session cannot be resumed (`registry.ts:217-251`). This
  rule was added after an earlier sweep deleted queued mail; the history and
  failure are recorded in `registry.ts:220-229` and `ARCHITECTURE.md:99-110`.
- **Important limit:** the file is removed before `pi.sendMessage` is called.
  Therefore a receiver process crash after `rmSync` and before Pi accepts the
  custom message loses the letter. The code makes this ordering explicit
  (`mailbox.ts:111-117,129-137`), even though the architecture calls removal a
  no-duplicate guarantee (`ARCHITECTURE.md:55-65`). This is at-most-once handoff
  after drain, not a durable exactly-once result guarantee.
- The repository does not define a parent/child crash protocol, ownership claim,
  intent record, signal control, or result marker. Those are outside pi-peer's
  scope.

### Mid-turn injection

- A received letter is passed to the Pi extension API as a custom message with
  `{ deliverAs: "steer", triggerTurn: true }` (`src/extension/index.ts:77-87`).
  The architecture says this lands between tool calls and wakes an idle session
  (`ARCHITECTURE.md:112-117`). It does not interrupt a tool already in flight.
- This is not an external steer channel into an arbitrary `pi -p` process. The
  receiving Pi process must have the extension loaded, must be watching its
  inbox, and must call `pi.sendMessage` itself. If it is offline, the message is
  queued for a later run. Thus pi-peer has mid-turn delivery to a live Pi session,
  but not process-independent mid-turn control.
- The delivered text is marked as peer text with no authority. The boundary is
  repeated on every delivery (`src/peer/format.ts:14-39`). This is a prompt
  boundary, not an operating-system permission boundary.

### Platform assumptions

- The stated scope is one machine and one visible filesystem. The README says a
  container and host cannot communicate through this design (`README.md:55-59`).
- The code uses Node/Bun filesystem APIs, `fs.watch`, `process.kill(pid, 0)`, and
  POSIX-like file permissions. The repository does not state a formal supported
  OS matrix. It does not use a network transport. Any macOS/Linux use is a
  reasonable fit for the APIs, but exact cross-platform behavior is not proven
  by the repository.

## Relevance to our runtime decisions

### Does it show a steer path without parent coupling?

No, not for our background child model. It shows a useful two-stage pattern:
filesystem mail can outlive a process, then a live Pi process can turn that mail
into `steer`. But the second stage is coupled to the receiving Pi extension
process and its Pi API. It does not steer a detached `pi -p --mode json` from a
separate parent after the parent has crashed. It therefore does not supply the
named per-run keeper route. If steer becomes a requirement, a keeper would still
need to own the live Pi control API and have its own durable ownership and crash
rules.

### Does it add something to our durable-artifact model?

It offers a low-latency notification pattern without polling alone: `fs.watch`
plus a 3-second poll fallback (`mailbox.ts:157-199`). This could improve a
human-facing watch or a parent notification helper, while leaving durable run
artifacts as the source of truth. It also offers a clear user distinction between
`Delivered` and `Queued` (`format.ts:82-95`).

It does **not** improve the required exactly-once result path. Its receipt is
based on deleting the letter before Pi delivery. A durable delivered marker with
an atomic create and a deliver-then-mark order is stronger for our result
contract. Its mailbox is also a queue of messages, not an observation log, run
record, intent record, outcome record, or ownership claim.

### Public surfaces and UX patterns

The public surface is small and clear: `list_peers`, `message_peer`, and `/peers`
(`extension/index.ts:177-247`). Useful patterns for our open tickets are:

- show stable human names plus working directory and state;
- refuse ambiguous control targets instead of guessing;
- return explicit `delivered` versus `queued` status;
- keep a stopped session visible when it can resume;
- show peer messages as a distinct, non-authoritative message;
- provide `accept`, `ask`, and `refuse` inbound policy modes.

These patterns map well to control and notification surfaces, but our names and
states should use this project's terms: run, session, settled, delivered,
observation, interrupt, redirect, stop, claim, and reconciliation.

### Anti-patterns and validations for our exclusions

- **Live steer depends on a live receiver.** This validates excluding mid-turn
  child steer from the default detached path. A file can survive a crash, but
  the `steer` call cannot happen without a live Pi process.
- **Consumption before handling weakens durability.** Removing mail before the
  Pi API call creates a loss window. Our result path should not copy this. Keep
  deliver-then-mark and use durable markers.
- **Pid plus heartbeat is only presence.** The repository itself warns that pid
  reuse and pauses make both signals necessary (`ARCHITECTURE.md:87-97`). It is
  not an identity token or proof that a particular run owns a process. Our run
  artifacts and identity token remain necessary.
- **Prompt boundaries do not enforce authority.** The repeated warning is good
  UX, but it cannot replace the signal and intent rules required for control.
- **The 30-day sweep is a policy choice, not crash recovery.** It can eventually
  discard queued peer mail. Our retention policy must be explicit, and result
  delivery must be recoverable from durable artifacts before cleanup.

## Unknowns

- The repository does not state a formal macOS/Linux support matrix, filesystem
  durability (`fsync`) policy, or behavior on network filesystems.
- There is no real multi-process integration test in the files read here; the
  extension tests use a stand-in Pi API. The tests are strong for pure mailbox
  behavior, but they do not prove a crash between unlink and `pi.sendMessage`.
- It is not established whether the exact Pi version used by this project keeps
  `deliverAs: "steer"` semantics stable across all idle, tool-call, and shutdown
  states. The package declares a broad Pi peer dependency (`package.json:39-56`).
- There is no evidence of remote peers, cross-container discovery, or external
  control of a detached `pi -p --mode json` process.

## Verdict

pi-peer is useful evidence, but it does not change our locked runtime design. Its
best lesson is a simple public message surface backed by inspectable filesystem
mail, with `fs.watch` plus polling for fast notification, stable session
identity, explicit queued/delivered UX, and a repeated non-authority boundary.
Its `steer` mechanism is inside the receiving Pi process, so it is not a
process-independent route and does not remove the need for a per-run keeper if
live steer is later required. Its unlink-before-handoff window is an important
warning: keep our durable artifacts, deliver-then-mark order, and crash recovery
as the stronger contract.
