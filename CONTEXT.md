# pi-subagents

pi-subagents lets a parent Pi agent hand work to child agents. This glossary names the domain: units of work, saved sessions, processes, ownership, observation, control, and cleanup.

## Language

### Work and state

**Run**:
One launch of a child, from launch until its result settles. A resume starts a new run on the same session. The word is mode-neutral: a run is a background run or an interactive run.
_Avoid_: job, execution, incarnation

**Task**:
The instructions the parent gives a child for one run.

**Time budget**:
The time limits that a run gets at launch: one limit for the whole run, and one limit for time without output. The budget is part of the run record. A recorded budget is a standing stop order: the extension may stop a run that is past its budget, even when the run has no owner.

**Warning schedule**:
The ordered token thresholds that watch a run's context window. Each threshold sends the child one warning. The last threshold is the context floor. The schedule is part of the run record.

**Session**:
The saved conversation of one agent, stored by Pi. One session can receive many runs.

**Queued**:
The state of a run that is accepted but waits for a free place in the run pool. A queued run has a run record and no process. Code alone decides when a queued run launches; a model never does.

**Queue-wait limit**:
The longest time an ownerless queued run may stay queued. Any extension process may cancel an ownerless queued run that is past the limit. A queued run with a living owner has no wait limit.

**Run pool**:
The shared limit on live runs in one project. Every run with a live process takes one place in the pool, no matter who owns the run. A launch waits in the queue when the pool is full.
_Avoid_: global pool, machine pool

**Launching**:
The state of a run whose record exists but whose process is not yet confirmed.

**Waiting**:
The state of a run that has an open wait on its own descendant runs. A waiting run is not idle while a live descendant shows work. The whole-run limit still applies while a run waits.

**Settled**:
The state of a run whose final result exists in durable storage. Settled does not mean delivered.

**Delivered**:
The state of a result that the owner's context has received, by steer or through a wait.

**Undelivered result**:
A settled result that no parent has received yet.
_Avoid_: unclaimed result

**Hibernated**:
A child session whose latest run has settled and whose process has exited, kept ready for a later run.

**Resume**:
Start a new run on a hibernated session. The new run keeps the work of the session's completed messages.
_Avoid_: wake

### Ownership and recovery

**Owner**:
The parent session that holds a run. The owner receives the run's result and may control the run.

**Released**:
A run whose owner let go on purpose, as in a normal parent exit under the `continue` policy. A released run needs no recovery.

**Orphaned**:
A run whose owner disappeared without releasing it, as after a crash. Reconciliation must resolve an orphaned run.

**Lost**:
A run whose process and result cannot be confirmed. Lost is not final: later evidence can return a lost run to running or settled.

**Claim**:
Take ownership of a released or orphaned run. The claimer becomes the run's owner.
_Avoid_: adopt, take over

**Reconciliation**:
The check that compares run records against live processes and updates each run's state.

**Owner sweep**:
The periodic pass that each owner process runs. The sweep launches the owner's queued runs, applies standing stop orders, cancels expired ownerless queued runs, and runs retention when the throttle permits.

**Spawn grace**:
The short time a launching run may stay unconfirmed before reconciliation marks it lost.

**Identity token**:
Durable proof that a recorded process is still the run's own process. It guards against process-id reuse.

### Records and observation

**Run record**:
The durable record of one run's identity, state, and ownership.
_Avoid_: run metadata

**Owner marker**:
The durable record of one run's ownership: the owner's identity, or the released state.

**Writer guard**:
The durable record that permits at most one live run on one session.

**Intent record**:
The durable record of one control request: the actor, the action, and the time.

**Outcome record**:
The durable record of a settled run's outcome class.

**Delivered marker**:
The durable record that one run's result was delivered.

**Observation log**:
The durable log of one run's events.

**Log ceiling**:
The size limit of one observation log. The extension stops a run whose log passes the ceiling. The ceiling protects the disk, not the model's context window.

**Cursor**:
A reader's position in one observation log. A cursor lives in memory, per reader. It is never written to disk.

**Cold read**:
A read of an observation log with no cursor. A cold read starts in the tail window, so it never reads a whole log.

**Tail window**:
The bounded span at the end of an observation log where a cold read starts. A read that starts there reports the lines before it as not read.

**Torn tail**:
The incomplete last line of an observation log, while the child is in the middle of a write. A torn tail is returned separately from whole events, and the cursor never moves past it.
_Avoid_: partial line

**Launch wrapper**:
The small shell process that starts a background run's child in its own process group, records the child's identity token, waits, and writes the exit record. The launch wrapper lives exactly as long as the run.
_Avoid_: supervisor, keeper

**Exit record**:
The durable record of one run's process end: the raw wait status, and the end time. The raw wait status carries the exit code, or 128 plus the signal number when a signal ended the process.

**Run artifacts**:
All durable files of one run: the run record, the owner marker, the intent records, the exit record, the outcome record, the delivered marker, the observation log, and prompt and task files. Run artifacts never include the child's Pi session transcript.

**Peek**:
A bounded, non-blocking read of a run's progress. A peek returns at once with whatever exists. A peek returns progress facts. It does not return the child's message content.

**Live view**:
The human-facing, continuously updating view of one run's full content.

**Runtime notice**:
A marked message that the extension puts into the parent's conversation. A notice reports an event. A notice is not a delivery.

**Stall warning**:
A runtime notice that tells a run's owner the run shows no progress. It uses progress facts only.

### Control

**Steer**:
Inject a message into a session's current turn. Results steer the parent; mid-turn control steers the child.

**Interrupt**:
End a run's current turn. The run may continue after an interrupt.
_Avoid_: abort

**Redirect**:
Interrupt a run, then resume its session with a new task. A redirect is one operation with one answer. The session keeps the work of its completed messages.

**Wrap-up**:
A redirect that the time-limit rules trigger near the end of a run's time budget. The interrupted run's session resumes with one instruction: report the finished work and the unfinished work. The report gets the remaining budget. The original deadline does not move.

**Context floor**:
The last threshold of a run's warning schedule. Past the floor, the extension refuses every new tool call in the child, so the run can only report and end. Code enforces the floor; the model does not decide.

**Stop**:
End a run's process.
_Avoid_: kill, terminate (terminate names a parent-close policy)

**Auto-exit**:
An option of an interactive run. The child ends its own process after its final response, so the run settles and delivers without help. Operator input in the pane disarms auto-exit; the `/auto-exit` command re-arms it.
_Avoid_: takeover, abort

### Cleanup

**Dismiss**:
Hide a run's human-facing row. Dismiss removes nothing.

**Delete**:
Remove a run's artifacts. Delete never removes the child's Pi session transcript.

**No-session**:
A launch with no durable, resumable Pi session. Its run artifacts follow normal retention.

**Retention**:
The rules that limit how long and how much run data is kept.

### Validation

**Live probe**:
A scripted check that launches a real child and asserts on run artifacts. A live probe never judges the quality of a model's output.

**Smoke**:
A scripted live check that is not part of the release gate. A smoke covers a path that the release gate does not own. A human runs a smoke on demand.

**Pass receipt**:
The durable, machine-readable record of one full live-probe run: the commit it proves, the Pi version, the model ref, and the result of every probe.

**Release gate**:
The set of checks that must pass before a version is published. The gate is mechanical: no check relies on a human's memory.
