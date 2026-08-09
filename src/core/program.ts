/**
 * Deterministic mentoring-program engine (the deterministic-promise rule, ELC journey.ts
 * precedent): anything that becomes a delivery commitment is computed by a PURE function
 * from catalog metadata. The model narrates the skeleton, never edits it.
 *
 * Simple by design: sessions are placed every `cadence_days` starting from the start date,
 * shifted off weekends (Sat -> Mon, Sun -> Mon). Dates are planning targets; the intro
 * call fixes the real cadence.
 */
import type { Offer } from "./catalog";

export type ProgramSession = {
	n: number;
	date: string; // YYYY-MM-DD
	minutes: number;
	kind: "session" | "checkpoint" | "closing-review";
	label: string;
};

export type Program = {
	offerId: string;
	startDate: string;
	sessions: ProgramSession[];
	asyncAccess: boolean;
	caveat: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (d: Date): string => d.toISOString().slice(0, 10);

const skipWeekend = (d: Date): Date => {
	const day = d.getUTCDay();
	if (day === 6) return new Date(d.getTime() + 2 * DAY_MS); // Sat -> Mon
	if (day === 0) return new Date(d.getTime() + 1 * DAY_MS); // Sun -> Mon
	return d;
};

export function buildProgram(offer: Offer, startDate: string): Program | { error: string } {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return { error: "start_date must be YYYY-MM-DD" };
	const start = new Date(`${startDate}T00:00:00Z`);
	if (Number.isNaN(start.getTime())) return { error: `invalid start_date "${startDate}"` };
	const p = offer.program;
	if (!p) return { error: `offer "${offer.id}" has no program metadata` };

	const count = offer.sessions ?? 1;
	const sessions: ProgramSession[] = [];
	for (let i = 0; i < count; i++) {
		const raw = new Date(start.getTime() + i * Math.max(p.cadence_days, 0) * DAY_MS);
		const date = skipWeekend(raw);
		const isCheckpoint = p.checkpoint_after_session !== undefined && i + 1 === p.checkpoint_after_session;
		const isClosing = p.closing_review === true && i + 1 === count;
		sessions.push({
			n: i + 1,
			date: iso(date),
			minutes: p.session_minutes,
			kind: isClosing ? "closing-review" : isCheckpoint ? "checkpoint" : "session",
			label: isClosing
				? `Session ${i + 1} of ${count} — closing review: score progress against your definition of success`
				: isCheckpoint
					? `Session ${i + 1} of ${count} — mid-point checkpoint: are we working on the right things?`
					: `Session ${i + 1} of ${count}`,
		});
	}
	return {
		offerId: offer.id,
		startDate,
		sessions,
		asyncAccess: p.async_access === true,
		caveat: "Dates are planning targets computed from the package cadence; the intro call fixes the real schedule.",
	};
}

export function renderProgram(program: Program): string {
	const lines = program.sessions.map((s) => `  ${s.date} · ${s.minutes} min · ${s.label}`);
	if (program.asyncAccess) lines.push("  Plus: async access between sessions (Slack/WhatsApp, fair use).");
	return `Program skeleton (start ${program.startDate}):\n${lines.join("\n")}\n${program.caveat}`;
}
