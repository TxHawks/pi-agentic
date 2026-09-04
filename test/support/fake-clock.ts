/**
 * A manual clock for timing tests: no real sleeps ever. Actions scheduled
 * with a zero or negative delay run at once, so "at spawn" scripting needs
 * no advance call.
 */
export class FakeClock {
	private nowMs: number;
	private seq = 0;
	private timers: Array<{ due: number; seq: number; run: () => void }> = [];

	constructor(startMs = 0) {
		this.nowMs = startMs;
	}

	now(): number {
		return this.nowMs;
	}

	schedule(delayMs: number, run: () => void): void {
		if (delayMs <= 0) {
			run();
			return;
		}
		this.timers.push({ due: this.nowMs + delayMs, seq: this.seq++, run });
	}

	/** Move time forward, running every due action in due-then-schedule order. */
	advance(ms: number): void {
		const target = this.nowMs + ms;
		for (;;) {
			let next: { due: number; seq: number; run: () => void } | undefined;
			for (const timer of this.timers) {
				if (timer.due > target) continue;
				if (!next || timer.due < next.due || (timer.due === next.due && timer.seq < next.seq)) {
					next = timer;
				}
			}
			if (!next) break;
			this.timers.splice(this.timers.indexOf(next), 1);
			this.nowMs = next.due;
			next.run();
		}
		this.nowMs = target;
	}
}
