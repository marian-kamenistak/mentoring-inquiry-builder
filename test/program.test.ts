import { describe, expect, it } from "vitest";
import { offerById } from "../src/core/catalog";
import { buildProgram, type Program } from "../src/core/program";

describe("program engine (deterministic-promise rule)", () => {
	const fq = offerById("first-quarter")!;
	/** Pinned clock. `buildProgram` refuses a start date in the past against the real `new Date()`,
	 *  so hardcoding a start date without pinning `today` makes a test that passes until that date
	 *  goes by and then fails forever — this file started failing on 2026-09-08 for exactly that
	 *  reason. `test/persona-regressions.test.ts` already passes `today`; this file had not. */
	const TODAY = "2026-09-01";

	it("is deterministic", () => {
		const a = buildProgram(fq, "2026-09-07", { today: TODAY }) as Program;
		const b = buildProgram(fq, "2026-09-07", { today: TODAY }) as Program;
		// Assert it built a real program first: two REJECTIONS also compare equal, which is how
		// this test kept passing for three days while the two below were failing.
		expect(a.sessions).toBeDefined();
		expect(a).toEqual(b);
	});

	it("places 6 bi-weekly sessions with checkpoint and closing review", () => {
		const p = buildProgram(fq, "2026-09-07", { today: TODAY }) as Program; // a Monday
		expect(p.sessions).toHaveLength(6);
		expect(p.sessions[2].kind).toBe("checkpoint"); // checkpoint_after_session: 3
		expect(p.sessions[5].kind).toBe("closing-review");
		// async_access was removed from First quarter 2026-08-21: the offer email was printing
		// "Between sessions: async access" as a deliverable of a package whose own catalog copy
		// sells "Priority scheduling, guaranteed slot". Async belongs to Continuous sparring.
		expect(p.asyncAccess).toBe(false);
		// bi-weekly spacing (weekend shifts allowed to stretch by ≤2 days)
		for (let i = 1; i < p.sessions.length; i++) {
			const gap = (Date.parse(p.sessions[i].date) - Date.parse(p.sessions[i - 1].date)) / 86400000;
			expect(gap).toBeGreaterThanOrEqual(12);
			expect(gap).toBeLessThanOrEqual(16);
		}
	});

	it("never lands a session on a weekend", () => {
		const p = buildProgram(fq, "2026-09-05", { today: TODAY }) as Program; // a Saturday start
		for (const s of p.sessions) {
			const day = new Date(`${s.date}T00:00:00Z`).getUTCDay();
			expect(day).not.toBe(0);
			expect(day).not.toBe(6);
		}
	});

	it("rejects malformed dates", () => {
		expect("error" in buildProgram(fq, "next monday")).toBe(true);
		expect("error" in buildProgram(fq, "2026-13-40")).toBe(true);
	});
});
