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
	continues?: string;
	allocation?: string;
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

export function buildProgram(offer: Offer, startDate: string, opts: { today?: string; leaders?: number } = {}): Program | { error: string } {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return { error: "start_date must be YYYY-MM-DD" };
	const start = new Date(`${startDate}T00:00:00Z`);
	if (Number.isNaN(start.getTime())) return { error: `invalid start_date "${startDate}"` };
	// A mistyped year used to produce a confident six-session schedule running through the
	// first COVID lockdown. A plan for the past is the silent-wrong-answer class.
	const today = opts.today ?? new Date().toISOString().slice(0, 10);
	if (startDate < today) return { error: `start_date "${startDate}" is in the past (today is ${today}) — ask the visitor for a real start date, or default to the next working Monday.` };
	const p = offer.program;
	if (!p) return { error: `offer "${offer.id}" has no program metadata` };

	// Recurring SKUs: `sessions` is the count PER MONTH, so laying out `offer.sessions` and
	// labelling them "of 2" told a subscription buyer her engagement ended in a fortnight.
	// Render the committed minimum instead, and mark that it continues.
	const c = offer.commitment;
	const perMonth = c?.sessions_are === "per_month";
	const months = perMonth ? Math.max(1, c?.minimum_months ?? 1) : 1;
	const count = (offer.sessions ?? 1) * months;
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
	const leaders = Math.max(1, opts.leaders ?? 1);
	return {
		offerId: offer.id,
		startDate,
		sessions,
		asyncAccess: p.async_access === true,
		...(perMonth ? { continues: `This is the ${months}-month minimum commitment (${offer.sessions} sessions a month). The engagement continues monthly after that until cancelled — this skeleton is not the end of it.` } : {}),
		// A pooled company SKU is not a per-leader calendar. Say so rather than letting an
		// 18-row list read as one leader's schedule, or as 18 sessions each.
		...(leaders > 1 && offer.per_leader !== true
			? { allocation: `These ${sessions.length} sessions are a pool shared across ${leaders} leaders — roughly ${Math.floor(sessions.length / leaders)} each. Who takes which slot is agreed on the intro call; this skeleton deliberately does not assign them.` }
			: {}),
		caveat: "Dates are planning targets computed from the package cadence; the intro call fixes the real schedule. Public holidays are not accounted for — check the dates against your own calendar.",
	};
}

export function renderProgram(program: Program): string {
	const lines = program.sessions.map((s) => `  ${s.date} · ${s.minutes} min · ${s.label}`);
	if (program.asyncAccess) lines.push("  Plus: async access between sessions (Slack/WhatsApp, fair use).");
	if (program.continues) lines.push(`  → ${program.continues}`);
	if (program.allocation) lines.push(`  → ${program.allocation}`);
	// The header used to echo the requested date while session 1 sat two days later (weekend
	// roll), which read as a bug to anyone comparing the two.
	const actual = program.sessions[0]?.date ?? program.startDate;
	const header = actual === program.startDate ? `start ${program.startDate}` : `requested ${program.startDate}, first session ${actual} (rolled off the weekend)`;
	return `Program skeleton (${header}):\n${lines.join("\n")}\n${program.caveat}`;
}
