# pi-subagents

pi-subagents lets a parent Pi agent hand work to child agents. This glossary names the domain: units of work, saved sessions, processes, ownership, observation, control, and cleanup.

## Language

### Work and state

**Run**:
One launch of a child, from launch until its result settles. A resume starts a new run on the same session. The word is mode-neutral: a run is a background run or an interactive run.
_Avoid_: job, execution, incarnation

**Task**:
The instructions the parent gives a child for one run.

**Session**:
The saved conversation of one agent, stored by Pi. One session can receive many runs.

**Launching**:
The state of a run whose record exists but whose process is not yet confirmed.

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

**Exit record**:
The durable record of one run's process end: the exit code, the signal if one ended the process, and the end time.

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

**Stop**:
End a run's process.
_Avoid_: kill, terminate (terminate names a parent-close policy)

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

**Pass receipt**:
The durable, machine-readable record of one full live-probe run: the commit it proves, the Pi version, the model ref, and the result of every probe.

**Release gate**:
The set of checks that must pass before a version is published. The gate is mechanical: no check relies on a human's memory.
