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

**Settled**:
The state of a run whose final result exists in durable storage. Settled does not mean delivered.

**Delivered**:
The state of a result that the owner's context has received, by steer or through a wait.

**Undelivered result**:
A settled result that no parent has received yet.
_Avoid_: unclaimed result

**Hibernated**:
A child session whose latest run has settled and whose process has exited, kept ready for a later run.

**Wake**:
Start a new run on a hibernated session. Resume wakes a session.

### Ownership and recovery

**Owner**:
The parent session that holds a run. The owner receives the run's result and may control the run.

**Released**:
A run whose owner let go on purpose, as in a normal parent exit under the `continue` policy. A released run needs no recovery.

**Orphaned**:
A run whose owner disappeared without releasing it, as after a crash. Reconciliation must resolve an orphaned run.

**Lost**:
A run whose process can no longer be found or confirmed.

**Claim**:
Take ownership of a released or orphaned run. The claimer becomes the run's owner.
_Avoid_: adopt, take over

**Reconciliation**:
The check that compares run records against live processes and updates each run's state.

**Identity token**:
Durable proof that a recorded process is still the run's own process. It guards against process-id reuse.

### Records and observation

**Run record**:
The durable record of one run's identity, state, and ownership.
_Avoid_: run metadata

**Observation log**:
The durable log of one run's events.

**Exit record**:
The durable record of one run's process end: the exit code, the signal if one ended the process, and the end time.

**Run artifacts**:
All durable files of one run: the run record, the exit record, the observation log, and prompt and task files. Run artifacts never include the child's Pi session transcript.

**Peek**:
A bounded, non-blocking read of a run's progress. A peek returns at once with whatever exists. A peek returns progress facts. It does not return the child's message content.

**Live view**:
The human-facing, continuously updating view of one run's full content.

### Control

**Steer**:
Inject a message into a session's current turn. Results steer the parent; mid-turn control steers the child.

**Interrupt**:
End a run's current turn. The run may continue after an interrupt.
_Avoid_: abort

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
