/**
 * The second door: the paid first session (2026-08-30).
 *
 * What is actually worth testing here is not "does the code run" but the three ways this change
 * can silently do the wrong thing to a real deal:
 *   1. write a stage that drags an active mentee backwards, or refuse to advance one at all;
 *   2. hand the paid booking link to someone whose terms Marian has not settled yet;
 *   3. fire the wrong GA4 conversion, which is unretractable once sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { canAdvance, firstSessionEligible, firstSessionUrl, paymentTerms, STAGE_LADDER, stageRank } from "../src/core/booking";
import { handleBookingHook, shouldAdvance, shouldFireCallBooked, ga4BookingBody } from "../src/hooks";

const entryAtStage = (title: string) => ({
	entry_id: "e1",
	list_api_slug: "mentoring_pipeline",
	entry_values: { mentee_stage: [{ status: { title } }] },
});

describe("stage ladder", () => {
	it("ranks the live Attio ladder in order", () => {
		expect(STAGE_LADDER.map(stageRank)).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it("treats blank, unknown and non-string stages as unranked so they can be seeded", () => {
		expect(stageRank(null)).toBe(-1);
		expect(stageRank("")).toBe(-1);
		expect(stageRank("Proposal sent")).toBe(-1); // a value from an older ladder that no longer exists
		expect(stageRank(42)).toBe(-1);
	});

	it("matches case-insensitively — Attio titles are hand-typed and 'Intro arranged' happens", () => {
		expect(stageRank("INTRO ARRANGED")).toBe(1);
		expect(stageRank("  Formal 1st Arranged  ")).toBe(4);
	});

	it("advances forward only, which is the whole point of ranking instead of equality", () => {
		expect(canAdvance(null, "intro arranged")).toBe(true);
		expect(canAdvance("Not yet", "intro arranged")).toBe(true);
		expect(canAdvance("intro arranged", "intro arranged")).toBe(false);
		// The case the old seed-only-when-blank rule could not express: a paid booking lifting
		// someone who already has a stage.
		expect(canAdvance("Not yet", "formal 1st arranged")).toBe(true);
		expect(canAdvance("intro arranged", "formal 1st arranged")).toBe(true);
		// ...without ever dragging an active mentee back, which is what that rule existed to stop.
		expect(canAdvance("mentoring", "formal 1st arranged")).toBe(false);
		expect(canAdvance("done", "intro arranged")).toBe(false);
	});
});

describe("conversion gating", () => {
	it("keeps the intro door's original behaviour exactly", () => {
		expect(shouldFireCallBooked(null)).toBe(true);
		expect(shouldFireCallBooked(entryAtStage("Not yet"))).toBe(true);
		expect(shouldFireCallBooked(entryAtStage("intro arranged"))).toBe(false);
	});

	it("fires the paid conversion for someone whose intro is already booked", () => {
		// A prospect who booked an intro, then bought. `call_booked` must not fire again, but
		// `first_session_booked` must — they are different outcomes with different values.
		const e = entryAtStage("intro arranged");
		expect(shouldAdvance(e, "intro arranged")).toBe(false);
		expect(shouldAdvance(e, "formal 1st arranged")).toBe(true);
	});

	it("fails open on an unknown entry shape — a duplicate conversion beats a lost one", () => {
		expect(shouldAdvance({ entry_id: "e1" }, "formal 1st arranged")).toBe(true);
	});

	it("names the event it was asked for, so the two doors never merge in GA4", () => {
		expect(ga4BookingBody("first_session_booked", "c1", {}).events[0].name).toBe("first_session_booked");
		expect(ga4BookingBody("call_booked", "c1", {}).events[0].name).toBe("call_booked");
	});
});

describe("who may skip the intro", () => {
	it("lets a clean individual pack close in the conversation", () => {
		expect(firstSessionEligible("first-quarter").eligible).toBe(true);
		expect(firstSessionEligible("single-session").eligible).toBe(true);
	});

	it("refuses the monthly package — its own terms say Marian confirms the billing day on a call", () => {
		const r = firstSessionEligible("monthly");
		expect(r.eligible).toBe(false);
		expect((r as any).reason).toMatch(/intro/i);
	});

	it("refuses Mentor in Residence, which is itself a listed negotiation trigger", () => {
		expect(firstSessionEligible("mentor-in-residence").eligible).toBe(false);
	});

	it("refuses ANY package once a free-sessions concession is on the table", () => {
		// This is the one that matters: first-quarter is eligible on its own, and a concession
		// silently turns it into a proposal Marian has not agreed to yet.
		expect(firstSessionEligible("first-quarter").eligible).toBe(true);
		expect(firstSessionEligible("first-quarter", { freeSessionsProposed: 2 }).eligible).toBe(false);
	});

	it("refuses an unknown offer rather than guessing", () => {
		expect(firstSessionEligible("enterprise-platinum").eligible).toBe(false);
	});

	it("always hands back a real intro URL when it refuses, never a dead end", () => {
		const r = firstSessionEligible("monthly");
		expect((r as any).reason).toContain("https://");
	});
});

describe("the booking URL carries the claim code", () => {
	it("appends data-claim so Reclaim returns it inside the signed payload", () => {
		expect(firstSessionUrl("AI16-260830-ABCDEF01")).toContain("data-claim=AI16-260830-ABCDEF01");
	});

	it("returns a plain link when there is no code — never the string 'undefined'", () => {
		expect(firstSessionUrl()).not.toContain("data-claim");
		expect(firstSessionUrl("")).not.toContain("data-claim");
	});

	it("points at the boost link, not the intro link", () => {
		expect(firstSessionUrl()).toContain("mentoring-boost");
	});
});

describe("payment terms are stated, never collected", () => {
	it("gives an individual the Czech VAT sentence, because they pay the gross figure", () => {
		const t = paymentTerms("individual");
		expect(t.vat).toMatch(/21/);
		expect(t.invoiced_by).toMatch(/06093175/);
	});

	it("gives an EU company with a VAT ID the reverse-charge sentence, not a gross figure", () => {
		expect(paymentTerms("company", true).vat).toMatch(/[Rr]everse charge/);
	});

	it("gives a Czech company the 21% sentence rather than reverse charge", () => {
		expect(paymentTerms("company", false).vat).toMatch(/21/);
		expect(paymentTerms("company", false).vat).not.toMatch(/[Rr]everse charge/);
	});
});

// ── the webhook itself ───────────────────────────────────────────────────────────────────────
describe("boost webhook", () => {
	const SECRET = "s3cr3t";
	const url = new URL(`https://x/mcp/mentoring/api/mentoring-boost?secret=${SECRET}`);
	const post = (body: any) =>
		new Request("https://x/mcp/mentoring/api/mentoring-boost", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	afterEach(() => vi.unstubAllGlobals());

	/** Captures every Attio write body so the assertions can read what was actually sent. */
	const mockAttio = (entries: any[]) => {
		const writes: { url: string; body: any }[] = [];
		vi.stubGlobal("fetch", vi.fn(async (u: any, init: any) => {
			const s = String(u);
			if (init?.method && init.method !== "GET" && s.includes("attio.com")) {
				writes.push({ url: s, body: init.body ? JSON.parse(init.body) : null });
			}
			if (s.includes("/people/records/query")) return new Response(JSON.stringify({ data: [{ id: { record_id: "p1" }, values: {} }] }), { status: 200 });
			if (s.includes("/entries?limit=100")) return new Response(JSON.stringify({ data: entries }), { status: 200 });
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}));
		return writes;
	};

	it("writes formal 1st arranged, not intro arranged", async () => {
		const writes = mockAttio([entryAtStage("Not yet")]);
		const res = await handleBookingHook(post({ email: "buyer@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t" }, url, "boost");
		expect(await res.json()).toMatchObject({ ok: true, path: "boost", stage: "formal 1st arranged" });
		const stageWrite = writes.find((w) => w.body?.data?.entry_values?.mentee_stage);
		expect(stageWrite?.body.data.entry_values.mentee_stage).toBe("formal 1st arranged");
	});

	it("advances someone already sitting on intro arranged — the skip-the-intro case", async () => {
		const writes = mockAttio([entryAtStage("intro arranged")]);
		await handleBookingHook(post({ email: "buyer@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t" }, url, "boost");
		expect(writes.find((w) => w.body?.data?.entry_values?.mentee_stage)?.body.data.entry_values.mentee_stage).toBe("formal 1st arranged");
	});

	it("never drags an active mentee backwards on a reschedule", async () => {
		const writes = mockAttio([entryAtStage("mentoring")]);
		await handleBookingHook(post({ email: "mentee@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t" }, url, "boost");
		expect(writes.find((w) => w.body?.data?.entry_values?.mentee_stage)).toBeUndefined();
	});

	it("sets the paid inquiry status, which must exist as an Attio select option or the whole write 400s", async () => {
		const writes = mockAttio([{ entry_id: "i1", list_api_slug: "mentoring_ai_inquiries" }]);
		await handleBookingHook(post({ email: "buyer@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t" }, url, "boost");
		const statusWrite = writes.find((w) => w.body?.data?.entry_values?.status);
		expect(statusWrite?.body.data.entry_values.status).toBe("First session booked");
	});

	it("fires first_session_booked, never call_booked — the two must stay separable in Ads", async () => {
		const bodies: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (u: any, init: any) => {
			const s = String(u);
			if (s.includes("google-analytics.com")) bodies.push(String(init?.body ?? ""));
			if (s.includes("/people/records/query")) return new Response(JSON.stringify({ data: [{ id: { record_id: "p1" }, values: {} }] }), { status: 200 });
			if (s.includes("/entries?limit=100")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}));
		await handleBookingHook(post({ email: "buyer@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t", GA4_MEASUREMENT_ID: "G-X", GA4_API_SECRET: "s" }, url, "boost");
		expect(bodies.join()).toContain("first_session_booked");
		expect(bodies.join()).not.toContain("call_booked");
	});

	it("reads the claim code out of custom_data, so nothing depends on the booker pasting it", async () => {
		mockAttio([]);
		const res = await handleBookingHook(
			post({ meeting: { attendee: { attendee_email: "buyer@corp.com" }, custom_data: { data: { claim: "AI16-260830-ABCDEF01" } } } }),
			{ BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t" },
			url,
			"boost",
		);
		expect(await res.json()).toMatchObject({ claim: "AI16-260830-ABCDEF01" });
	});

	it("falls back to the booking note when custom_data is absent or malformed", async () => {
		mockAttio([]);
		const res = await handleBookingHook(
			post({ meeting: { attendee: { attendee_email: "buyer@corp.com" }, custom_data: { data: { claim: "not-a-code" } }, message: "AI16-260830-DEADBEEF" } }),
			{ BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t" },
			url,
			"boost",
		);
		expect(await res.json()).toMatchObject({ claim: "AI16-260830-DEADBEEF" });
	});

	it("still refuses a cancellation, and a cancelled paid session must not advance anyone", async () => {
		const writes = mockAttio([entryAtStage("Not yet")]);
		const res = await handleBookingHook(
			post({ type: "SchedulingLink.Meeting.Cancelled", meeting: { attendee: { attendee_email: "buyer@corp.com" } } }),
			{ BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t" },
			url,
			"boost",
		);
		expect(await res.json()).toMatchObject({ ignored: "cancellation" });
		expect(writes).toHaveLength(0);
	});

	it("still honours the test-mode guard — a probe must not cost a paid conversion either", async () => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (u: any) => {
			calls.push(String(u));
			return new Response("{}", { status: 200 });
		}));
		await handleBookingHook(post({ email: "test@example.com" }), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t", GA4_MEASUREMENT_ID: "G-X", GA4_API_SECRET: "s" }, url, "boost");
		expect(calls.some((c) => c.includes("attio.com"))).toBe(false);
		expect(calls.some((c) => c.includes("google-analytics.com"))).toBe(false);
	});

	it("rejects a wrong secret before doing anything", async () => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (u: any) => { calls.push(String(u)); return new Response("{}", { status: 200 }); }));
		const res = await handleBookingHook(post({ email: "buyer@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t" }, new URL("https://x/mcp/mentoring/api/mentoring-boost?secret=wrong"), "boost");
		expect(res.status).toBe(403);
		expect(calls).toHaveLength(0);
	});
});
