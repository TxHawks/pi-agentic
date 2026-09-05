/**
 * The POSIX shell launch wrapper of one background run. The wrapper is the
 * detached group leader: it ignores SIGTERM, starts the Pi child in its own
 * group, records the child's identity token, waits, and atomically writes
 * the exit record. The wrapper lives exactly as long as the run, so exit
 * evidence survives the death of the parent process.
 *
 * NOTE (load-bearing): the wrapper's real signal behavior — the TERM trap,
 * the child's clean SIGTERM exit, and the exit-record write after a parent
 * death — is proven only by the Tier B live probes. Those probes are
 * load-bearing and must never be weakened. The unit tests here prove the
 * record writes and the output redirect, not Pi's signal handling.
 */
import { join } from "node:path";
import { readFrozenJson } from "./artifacts.ts";
import type { IdentityToken } from "./identity.ts";

/** The child identity record of one run, inside its run directory. */
export const CHILD_IDENTITY_NAME = "child.json";

/** The exit record of one run, inside its run directory. */
export const EXIT_RECORD_NAME = "exit.json";

/** The shell that runs the launch wrapper. */
const WRAPPER_SHELL = "/bin/sh";

/**
 * The identity of the run's processes, captured by the wrapper itself, so
 * identity exists even when the parent dies mid-spawn. The wrapper records
 * its own token in the same file. A null wrapper token means the wrapper
 * could not read its own identity; the child token is the load-bearing part.
 */
export interface ChildIdentityRecord {
	child: IdentityToken;
	wrapper: IdentityToken | null;
}

/**
 * The exit evidence of one run. The raw wait status is the shell's `$?`
 * from `wait`: an exit code, or 128 plus the signal number for a signal
 * death. 143 means the SIGTERM path — the shell cannot tell `exit(143)`
 * from a TERM death, so classification rests on intent records. 137 means
 * SIGKILL.
 */
export interface ExitRecord {
	waitStatus: number;
	endedAt: string;
}

/**
 * The wrapper script. Invoked as `sh -c <script> <name> <runDir> <command>
 * [args...]`, so no argument ever passes through shell quoting. It writes
 * the child identity record and the exit record with a temp file plus a
 * hard link — the same atomic, no-overwrite rule as the frozen-write
 * primitive in artifacts.ts. The shell cannot fsync, so durability after a
 * power loss is weaker than the TS primitive; visibility is still whole
 * content or nothing.
 *
 * The identity capture must produce the exact same strings as the probe in
 * identity.ts: on Linux the raw tick count from /proc/<pid>/stat field 22
 * and the command between the first "(" and the last ")"; elsewhere the
 * trimmed `ps lstart=` and `ps comm=` text.
 */
const LAUNCH_WRAPPER_SCRIPT = [
	"run_dir=$1",
	"shift",
	"",
	"json_escape() {",
	"\tprintf '%s' \"$1\" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/\"/\\\\\"/g'",
	"}",
	"",
	"identity_json() {",
	"\tpid=$1",
	'\tif [ -r "/proc/$pid/stat" ]; then',
	'\t\tstat=$(cat "/proc/$pid/stat" 2>/dev/null) || return 1',
	// The command sits between the first "(" and the last ")". After the
	// last ")" the start time is the 20th field (field 22 of the stat line).
	// biome-ignore lint/suspicious/noTemplateCurlyInString: The child shell expands these variables.
	"\t\trest=${stat%)*}",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: The child shell expands these variables.
	"\t\tcommand_name=${rest#*(}",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: The child shell expands these variables.
	"\t\tset -- ${stat##*)}",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: The child shell expands these variables.
	"\t\tstart_time=${20}",
	"\telse",
	"\t\tstart_time=$(ps -p \"$pid\" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')",
	"\t\tcommand_name=$(ps -p \"$pid\" -o comm= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')",
	"\tfi",
	'\t[ -n "$start_time" ] && [ -n "$command_name" ] || return 1',
	'\tprintf \'{"pid":%d,"startTime":"%s","command":"%s"}\' "$pid" "$(json_escape "$start_time")" "$(json_escape "$command_name")"',
	"}",
	"",
	// Mirror of writeFrozenFile: link the temp file to the final name, so
	// a second writer can never replace a record; then drop the temp name.
	"write_frozen() {",
	'\tln "$1" "$2" 2>/dev/null',
	"\tfrozen_status=$?",
	'\trm -f "$1"',
	'\treturn "$frozen_status"',
	"}",
	"",
	'"$@" &',
	"child_pid=$!",
	"",
	// The trap comes after the spawn on purpose: an ignore disposition
	// survives exec, so a trap before the spawn would start the Pi child
	// with SIGTERM ignored, and interrupt and stop would never reach it.
	"trap '' TERM",
	"",
	// The command name is fork-stale until the child execs, so one early
	// read could record the shell's own name and every later liveness
	// check would answer command-mismatch. Two matching reads with a gap
	// make a pre-exec capture practically impossible.
	"child_identity=",
	"previous=",
	"tries=0",
	'while [ "$tries" -lt 20 ]; do',
	'\tcurrent=$(identity_json "$child_pid") || current=',
	'\tif [ -n "$current" ] && [ "$current" = "$previous" ]; then',
	"\t\tchild_identity=$current",
	"\t\tbreak",
	"\tfi",
	"\tprevious=$current",
	"\ttries=$((tries + 1))",
	'\tkill -0 "$child_pid" 2>/dev/null || break',
	"\tsleep 0.05",
	"done",
	"",
	'wrapper_identity=$(identity_json "$$") || wrapper_identity=',
	'if [ -n "$child_identity" ]; then',
	'\ttmp="$run_dir/.tmp-wrapper-$$-child"',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: The child shell expands these variables.
	'\tprintf \'{"child":%s,"wrapper":%s}\\n\' "$child_identity" "${wrapper_identity:-null}" > "$tmp"',
	'\twrite_frozen "$tmp" "$run_dir/child.json"',
	"fi",
	"",
	'wait "$child_pid"',
	"wait_status=$?",
	"",
	'tmp="$run_dir/.tmp-wrapper-$$-exit"',
	'printf \'{"waitStatus":%d,"endedAt":"%s"}\\n\' "$wait_status" "$(date -u \'+%Y-%m-%dT%H:%M:%SZ\')" > "$tmp"',
	'write_frozen "$tmp" "$run_dir/exit.json"',
	'exit "$wait_status"',
].join("\n");

/**
 * The full command line that starts the wrapper around one child command.
 * The run directory and the child command travel as arguments, never as
 * script text, so nothing needs shell escaping.
 */
export function launchWrapperCommand(
	runDir: string,
	command: string,
	args: readonly string[],
): { command: string; args: string[] } {
	return {
		command: WRAPPER_SHELL,
		args: ["-c", LAUNCH_WRAPPER_SCRIPT, "pi-run-wrapper", runDir, command, ...args],
	};
}

/** Read the child identity record, or null when the wrapper has not written it. */
export function readChildIdentity(runDir: string): ChildIdentityRecord | null {
	return readFrozenJson(join(runDir, CHILD_IDENTITY_NAME)) as ChildIdentityRecord | null;
}

/** Read the exit record, or null when the run has not ended. */
export function readExitRecord(runDir: string): ExitRecord | null {
	return readFrozenJson(join(runDir, EXIT_RECORD_NAME)) as ExitRecord | null;
}
