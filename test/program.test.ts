import { describe, expect, it } from "vitest";
import { offerById } from "../src/core/catalog";
import { buildProgram, type Program } from "../src/core/program";

describe("program engine (deterministic-promise rule)", () => {
	const fq = offerById("first-quarter")!;

	it("is deterministic", () => {
		const a = buildProgram(fq, "2026-09-07") as Program;
		const b = buildProgram(fq, "2026-09-07") as Program;
		expect(a).toEqual(b);
	});

	it("places 6 bi-weekly sessions with checkpoint and closing review", () => {
		const p = buildProgram(fq, "2026-09-07") as Program; // a Monday
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
		const p = buildProgram(fq, "2026-09-05") as Program; // a Saturday start
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
