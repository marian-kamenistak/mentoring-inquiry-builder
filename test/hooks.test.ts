import { afterEach, describe, expect, it, vi } from "vitest";
import { isCancellationPayload, ga4CallBookedBody, extractHeardFrom, shouldFireCallBooked, handleBookingHook, extractAttendeeName, formatMeetingWhen } from "../src/hooks";

// Shape of a real Attio list-entry read. `intro_arranged` ("Mentee stage") is a STATUS-type
// attribute, so its value nests under .status.title — a select would nest under .option.title.
const entryAtStage = (title: string) => ({
	entry_id: "e1",
	list_api_slug: "mentoring_pipeline",
	entry_values: { intro_arranged: [{ status: { title } }] },
});

describe("booking-hook helpers", () => {
	it("detects cancellations without flipping bookings", () => {
		expect(isCancellationPayload('{"type":"event.canceled","email":"a@b.c"}')).toBe(true);
		expect(isCancellationPayload('{"type":"event.created","email":"a@b.c"}')).toBe(false);
		expect(isCancellationPayload("Attendee declined the invitation")).toBe(true);
	});
	it("scopes the cancellation match to a typed event-key value, not the whole payload", () => {
		expect(isCancellationPayload('{"type":"event.created","cancel_url":"https://x/cancel","email":"a@b.c"}')).toBe(false);
		expect(isCancellationPayload('{"status":"declined"}')).toBe(true);
		expect(isCancellationPayload('{"event":"booking.created","description":"you may cancel anytime"}')).toBe(false);
	});
	it("builds a GA4 MP body with a stable fallback client id", () => {
		const b: any = ga4CallBookedBody("123.456", { campaign: "paid-a-cto" });
		expect(b.client_id).toBe("123.456");
		expect(b.events[0].name).toBe("call_booked");
		expect(b.events[0].params.campaign).toBe("paid-a-cto");
	});
	it("extracts a heard-about-me answer only from a typed key/question value", () => {
		expect(extractHeardFrom('{"How did you hear about me?":"LinkedIn ad"}')).toBe("LinkedIn ad");
		expect(extractHeardFrom('{"answers":[{"question":"Kde jste se o mně dozvěděl?","answer":"od kolegy"}]}')).toBe("od kolegy");
		expect(extractHeardFrom('{"note":"hope to hear from you: soon"}')).toBeNull();
	});
	it("fires call_booked only on the transition into Intro call", () => {
		expect(shouldFireCallBooked(null)).toBe(true);
		expect(shouldFireCallBooked(undefined)).toBe(true);
		expect(shouldFireCallBooked(entryAtStage("lead"))).toBe(true);
		expect(shouldFireCallBooked(entryAtStage("intro arranged"))).toBe(false);
		// Unknown shape (entry_values missing) fails open — better a duplicate than a lost conversion.
		expect(shouldFireCallBooked({ entry_id: "e1" })).toBe(true);
	});
});

// ── Prep email (added 2026-08-21) ────────────────────────────────────────────────────────────
// The email that asks "what is the one thing you would want different in 3 months?". It is the
// only contact a booker gets between booking and the call, so the two things that matter are that
// it goes out at all, and that a Reclaim retry / reschedule does not send it twice.

const SECRET = "hook-secret";
const PREP = "prep-secret";

/** Collects every outbound call so a test can assert on the prep-invite one specifically. */
const mockFetch = (handler: (url: string, init: any) => any) => {
	const calls: { url: string; init: any }[] = [];
	vi.stubGlobal("fetch", async (url: any, init: any) => {
		calls.push({ url: String(url), init });
		return handler(String(url), init) ?? new Response("{}", { status: 200 });
	});
	return calls;
};

const post = (body: unknown) =>
	new Request("https://www.marian.coach/mcp/mentoring/api/booking-hook", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const url = new URL(`https://www.marian.coach/mcp/mentoring/api/booking-hook?secret=${SECRET}`);
const prepCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes("/api/prep-invite"));

describe("booking-hook prep email", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("sends the prep invite for a fresh booking, with the shared secret in the header", async () => {
		const calls = mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
		const res = await handleBookingHook(post({ email: "new@corp.com", name: "Ada Lovelace" }), { BOOKING_HOOK_SECRET: SECRET, PREP_INVITE_SECRET: PREP }, url);
		expect((await res.json() as any).prep_emailed).toBe(true);
		const sent = prepCalls(calls);
		expect(sent).toHaveLength(1);
		expect(sent[0].init.headers["x-prep-secret"]).toBe(PREP);
		expect(JSON.parse(sent[0].init.body)).toMatchObject({ email: "new@corp.com", name: "Ada Lovelace" });
	});

	it("never emails on a cancellation, which reaches this endpoint the same way a booking does", async () => {
		const calls = mockFetch(() => new Response("{}", { status: 200 }));
		await handleBookingHook(post({ type: "event.canceled", email: "new@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, PREP_INVITE_SECRET: PREP }, url);
		expect(prepCalls(calls)).toHaveLength(0);
	});

	it("does not email twice when a retry arrives for someone already on intro arranged", async () => {
		// Attio says: person exists, already parked on intro arranged. That is a replay.
		const calls = mockFetch((u) => {
			if (u.includes("/people/records/query")) return new Response(JSON.stringify({ data: [{ id: { record_id: "p1" }, values: {} }] }), { status: 200 });
			if (u.includes("/entries?limit=100")) return new Response(JSON.stringify({ data: [entryAtStage("intro arranged")] }), { status: 200 });
			return new Response("{}", { status: 200 });
		});
		await handleBookingHook(post({ email: "repeat@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, PREP_INVITE_SECRET: PREP, ATTIO_TOKEN: "t" }, url);
		expect(prepCalls(calls)).toHaveLength(0);
	});

	it("still emails a returning person whose pipeline entry sits at an earlier stage", async () => {
		const calls = mockFetch((u) => {
			if (u.includes("/people/records/query")) return new Response(JSON.stringify({ data: [{ id: { record_id: "p1" }, values: {} }] }), { status: 200 });
			if (u.includes("/entries?limit=100")) return new Response(JSON.stringify({ data: [entryAtStage("lead")] }), { status: 200 });
			return new Response("{}", { status: 200 });
		});
		await handleBookingHook(post({ email: "lead@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, PREP_INVITE_SECRET: PREP, ATTIO_TOKEN: "t" }, url);
		expect(prepCalls(calls)).toHaveLength(1);
	});

	it("skips the email rather than failing the booking when the secret is not configured", async () => {
		const calls = mockFetch(() => new Response("{}", { status: 200 }));
		const res = await handleBookingHook(post({ email: "new@corp.com" }), { BOOKING_HOOK_SECRET: SECRET }, url);
		expect(res.status).toBe(200);
		expect((await res.json() as any).prep_emailed).toBe(false);
		expect(prepCalls(calls)).toHaveLength(0);
	});

	it("reports the booking as ok even when the prep email fails to send", async () => {
		mockFetch((u) => (u.includes("/api/prep-invite") ? new Response("nope", { status: 502 }) : new Response("{}", { status: 200 })));
		const res = await handleBookingHook(post({ email: "new@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, PREP_INVITE_SECRET: PREP }, url);
		expect(res.status).toBe(200);
		expect((await res.json() as any).prep_emailed).toBe(false);
	});
});

describe("extractAttendeeName — the booking that arrived nameless (2026-08-21)", () => {
	it("takes an explicit name field", () => {
		expect(extractAttendeeName('{"name":"Haytham"}', { name: "Haytham" })).toBe("Haytham");
	});
	it("reads attendee/invitee-scoped shapes the trigger might send", () => {
		expect(extractAttendeeName("{}", { attendee: { name: "Haytham" } })).toBe("Haytham");
		expect(extractAttendeeName("{}", { attendee_name: "Haytham" })).toBe("Haytham");
		expect(extractAttendeeName("{}", { attendeeName: "Haytham" })).toBe("Haytham");
		expect(extractAttendeeName("{}", { invitee: { name: "Haytham" } })).toBe("Haytham");
		expect(extractAttendeeName("{}", { attendees: [{ name: "Haytham" }] })).toBe("Haytham");
	});
	it("finds a scoped key in an unparsed payload", () => {
		expect(extractAttendeeName('{"attendee_name":"Haytham","event_name":"Mentoring open door"}', {})).toBe("Haytham");
		expect(extractAttendeeName('{"inviteeFullName":"Jana Novakova"}', {})).toBe("Jana Novakova");
	});

	// The whole reason this function is narrow: a booking payload is full of names that are not
	// the person's, and a wrong one written into Attio looks exactly like a right one.
	it("never takes a bare name key — that is the event, the link or the webhook", () => {
		expect(extractAttendeeName('{"name":"Mentoring Intro webhook"}', {})).toBe("");
		expect(extractAttendeeName('{"event":{"name":"Mentoring open door"}}', {})).toBe("");
		expect(extractAttendeeName('{"calendar_name":"Marian work"}', {})).toBe("");
		expect(extractAttendeeName('{"timezone_name":"Europe/Prague"}', {})).toBe("");
	});
	it("rejects the observed event title even when it arrives on a scoped key", () => {
		expect(extractAttendeeName("{}", { attendee_name: "Marian and Haytham - Mentoring open door" })).toBe("");
	});
	it("rejects an address masquerading as a name", () => {
		expect(extractAttendeeName("{}", { attendee_name: "haytham88@gmail.com" })).toBe("");
	});
	it("falls through to the next candidate instead of giving up on the first bad one", () => {
		expect(extractAttendeeName("{}", { name: "a - b", attendee_name: "Haytham" })).toBe("Haytham");
	});
	it("returns empty when nothing qualifies, leaving the name to /api/booking-attr", () => {
		expect(extractAttendeeName('{"foo":"bar"}', {})).toBe("");
		expect(extractAttendeeName("", {})).toBe("");
	});
});

describe("test-mode guard — a probe must not cost a real conversion", () => {
	const SECRET_T = "s3cr3t";
	const postT = (body: any) =>
		new Request("https://x/mcp/mentoring/api/booking-hook", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const urlT = new URL(`https://x/mcp/mentoring/api/booking-hook?secret=${SECRET_T}`);

	afterEach(() => vi.unstubAllGlobals());

	it("writes nothing to Attio and fires no GA4 conversion for a test@ booker", async () => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (u: any) => {
			calls.push(String(u));
			return new Response("{}", { status: 200 });
		}));
		const res = await handleBookingHook(postT({ email: "test@example.com" }), {
			BOOKING_HOOK_SECRET: SECRET_T,
			ATTIO_TOKEN: "t",
			GA4_MEASUREMENT_ID: "G-X",
			GA4_API_SECRET: "s",
			PREP_INVITE_SECRET: "p",
		}, urlT);
		expect(res.status).toBe(200);
		expect(calls.some((c) => c.includes("attio.com"))).toBe(false);
		expect(calls.some((c) => c.includes("google-analytics.com"))).toBe(false);
		expect(calls.some((c) => c.includes("prep-invite"))).toBe(false);
	});

	it("still does all of it for a real booker", async () => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (u: any) => {
			calls.push(String(u));
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}));
		await handleBookingHook(postT({ email: "real@corp.com" }), {
			BOOKING_HOOK_SECRET: SECRET_T,
			ATTIO_TOKEN: "t",
			PREP_INVITE_SECRET: "p",
		}, urlT);
		expect(calls.some((c) => c.includes("attio.com"))).toBe(true);
		expect(calls.some((c) => c.includes("prep-invite"))).toBe(true);
	});

	it("does not match a real person whose address merely contains 'test'", async () => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (u: any) => {
			calls.push(String(u));
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}));
		await handleBookingHook(postT({ email: "testa.novakova@corp.com" }), {
			BOOKING_HOOK_SECRET: SECRET_T,
			ATTIO_TOKEN: "t",
		}, urlT);
		expect(calls.some((c) => c.includes("attio.com"))).toBe(true);
	});
});

/* Fixtures captured from REAL Reclaim webhooks on 2026-08-21 (api_version v2026-04-13) by making a
   deliberate test booking and cancelling it. Trimmed only where noted. These are the ground truth
   the handler was previously guessing at — if Reclaim changes its shape, these fail first. */
const RECLAIM_CREATED = {
	type: "SchedulingLink.Meeting.Created",
	event_ts: "2026-08-21T17:49:41.255Z",
	api_version: "v2026-04-13",
	meeting: {
		participants: [
			{ is_host: true, user_id: "f081ad80", email: "marian@engineeringleaders.io", name: "Marian Kamenistak" },
		],
		attendee: {
			attendee_email: "test@marian.coach",
			attendee_name: "Payload Probe",
			attendee_zone_id: { id: "Europe/Prague", display_name: "Central European Time", abbreviation: "CET" },
		},
		start_time: "2026-08-31T21:30:00+02:00",
		end_time: "2026-08-31T22:00:00+02:00",
		scheduling_link_title: "Mentoring open door",
		scheduling_link_description: "Hey, I'm Marian.\n\nPaste the claim code (AI16-...) into the booking note",
		meeting_id: "eEOFVtqQYh6t",
		meeting_title: "Marian and Payload Probe - Mentoring open door",
		ccs: "",
		message: "PAYLOAD SHAPE PROBE - please ignore and delete.",
		meeting_location: { conference_location: "GOOGLE_MEET" },
	},
};
const RECLAIM_CANCELLED = {
	...RECLAIM_CREATED,
	type: "SchedulingLink.Meeting.Cancelled",
	meeting: { ...RECLAIM_CREATED.meeting, start_time: "2026-08-31T19:30:00Z", end_time: "2026-08-31T20:00:00Z" },
	cancellation_message: "Payload shape probe - cancelling immediately.",
};

describe("real Reclaim payloads (captured 2026-08-21)", () => {
	const createdRaw = JSON.stringify(RECLAIM_CREATED);
	const cancelledRaw = JSON.stringify(RECLAIM_CANCELLED);

	it("takes the attendee's name, never the host's", () => {
		expect(extractAttendeeName(createdRaw, RECLAIM_CREATED)).toBe("Payload Probe");
		expect(extractAttendeeName(createdRaw, RECLAIM_CREATED)).not.toBe("Marian Kamenistak");
	});

	it("treats Cancelled as a cancellation and Created as a booking", () => {
		expect(isCancellationPayload(cancelledRaw)).toBe(true);
		expect(isCancellationPayload(createdRaw)).toBe(false);
	});

	it("does not mistake the link description's claim-code blurb for a cancellation", () => {
		// The description is long marketing prose that rides in every payload; the typed-key
		// branch must win over any stray word in it.
		expect(isCancellationPayload(createdRaw)).toBe(false);
	});

	it("renders the date line in the attendee's timezone", () => {
		expect(formatMeetingWhen(RECLAIM_CREATED)).toBe("Monday, 31 August at 21:30");
	});

	it("gives the SAME wall-clock time whether the payload used an offset or UTC", () => {
		// Created sent +02:00, Cancelled sent Z for the identical meeting. Reading the string
		// instead of the instant would print 19:30 to the booker for a 21:30 call.
		expect(formatMeetingWhen(RECLAIM_CANCELLED)).toBe(formatMeetingWhen(RECLAIM_CREATED));
	});

	it("renders in the booker's own zone, not Marian's", () => {
		const london = { ...RECLAIM_CREATED, meeting: { ...RECLAIM_CREATED.meeting,
			attendee: { ...RECLAIM_CREATED.meeting.attendee, attendee_zone_id: { id: "Europe/London" } } } };
		expect(formatMeetingWhen(london)).toBe("Monday, 31 August at 20:30");
	});

	it("drops the line rather than printing a wrong time", () => {
		expect(formatMeetingWhen({ meeting: {} })).toBe("");
		expect(formatMeetingWhen({ meeting: { start_time: "not a date" } })).toBe("");
		expect(formatMeetingWhen({})).toBe("");
	});

	it("falls back to Prague when the attendee zone is absent", () => {
		const noZone = { ...RECLAIM_CREATED, meeting: { ...RECLAIM_CREATED.meeting, attendee: { attendee_name: "X" } } };
		expect(formatMeetingWhen(noZone)).toBe("Monday, 31 August at 21:30");
	});
});
