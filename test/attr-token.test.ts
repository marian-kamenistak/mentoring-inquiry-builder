/**
 * Redeeming the click-time attribution token (2026-09-07).
 *
 * This is the ONLY attribution path for a booker who never returns to marian.coach, and that is
 * most of them — ~4 `Booking attribution` cards against ~11 bookings when measured. What can
 * silently go wrong here is not "does it run" but:
 *   1. clobbering a truer, earlier first touch with the one from this booking;
 *   2. re-stamping on every reschedule webhook because the token was never spent;
 *   3. taking a hostile string from a third-party payload and turning it into a KV key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleBookingHook } from "../src/hooks";

const SECRET = "s3cr3t";
const url = new URL(`https://x/mcp/mentoring/api/booking-hook?secret=${SECRET}`);

const post = (body: any) =>
	new Request("https://x/mcp/mentoring/api/booking-hook", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

/** Reclaim's envelope, with a `data-`-forwarded param. */
const payloadWithToken = (attr: unknown) => ({
	email: "booker@corp.com",
	meeting: { custom_data: { data: { attr } } },
});

const mockAttio = (personValues: any = {}) => {
	const writes: { url: string; body: any }[] = [];
	vi.stubGlobal("fetch", vi.fn(async (u: any, init: any) => {
		const s = String(u);
		if (init?.method && init.method !== "GET" && s.includes("attio.com")) {
			writes.push({ url: s, body: init.body ? JSON.parse(init.body) : null });
		}
		if (s.includes("/people/records/query")) {
			return new Response(JSON.stringify({ data: [{ id: { record_id: "p1" }, values: personValues }] }), { status: 200 });
		}
		if (s.includes("/entries?limit=100")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
		return new Response(JSON.stringify({ data: [] }), { status: 200 });
	}));
	return writes;
};

const fakeKv = (store: Record<string, unknown>) => {
	const gets: string[] = [];
	const deletes: string[] = [];
	return {
		gets,
		deletes,
		kv: {
			get: async (k: string) => {
				gets.push(k);
				return store[k] ?? null;
			},
			delete: async (k: string) => void deletes.push(k),
			put: async () => {},
		} as any,
	};
};

const PARKED = {
	first: { first_touch_source: "linkedin", first_touch_at: "2026-09-01T10:00:00.000Z" },
	refresh: { last_touch_source: "google", gclid: "xyz" },
};

afterEach(() => vi.unstubAllGlobals());

describe("attribution token redemption", () => {
	it("stamps first touch onto a person who has none", async () => {
		const writes = mockAttio({});
		const { kv, gets, deletes } = fakeKv({ "battr:0123456789abcdef": PARKED });
		await handleBookingHook(post(payloadWithToken("0123456789abcdef")), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t", MC_ATTR: kv }, url);

		expect(gets).toEqual(["battr:0123456789abcdef"]);
		const stamp = writes.find((w) => w.body?.data?.values?.first_touch_source);
		expect(stamp?.body.data.values.first_touch_source).toBe("linkedin");
		expect(stamp?.body.data.values.gclid).toBe("xyz");
	});

	it("spends the token so a reschedule webhook cannot re-stamp", async () => {
		mockAttio({});
		const { kv, deletes } = fakeKv({ "battr:0123456789abcdef": PARKED });
		await handleBookingHook(post(payloadWithToken("0123456789abcdef")), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t", MC_ATTR: kv }, url);
		expect(deletes).toEqual(["battr:0123456789abcdef"]);
	});

	it("never overwrites an earlier first touch — that one is truer", async () => {
		const writes = mockAttio({ first_touch_at: [{ value: "2026-08-01T00:00:00.000Z" }] });
		const { kv } = fakeKv({ "battr:0123456789abcdef": PARKED });
		await handleBookingHook(post(payloadWithToken("0123456789abcdef")), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t", MC_ATTR: kv }, url);

		const stamp = writes.find((w) => w.body?.data?.values && "gclid" in w.body.data.values);
		expect(stamp).toBeTruthy();
		// Refreshables still land; the write-once fields do not.
		expect(stamp?.body.data.values.first_touch_source).toBeUndefined();
		expect(stamp?.body.data.values.gclid).toBe("xyz");
	});

	it("ignores a malformed token rather than building a KV key from it", async () => {
		mockAttio({});
		for (const bad of ["../../secret", "battr:x", "ABCDEF0123456789", "", 42, null]) {
			const { kv, gets } = fakeKv({});
			await handleBookingHook(post(payloadWithToken(bad)), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t", MC_ATTR: kv }, url);
			expect(gets).toEqual([]);
		}
	});

	it("survives an unknown or expired token", async () => {
		const writes = mockAttio({});
		const { kv, gets } = fakeKv({});
		const res = await handleBookingHook(post(payloadWithToken("0123456789abcdef")), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t", MC_ATTR: kv }, url);
		expect(res.status).toBe(200);
		expect(gets).toEqual(["battr:0123456789abcdef"]);
		expect(writes.find((w) => w.body?.data?.values?.first_touch_source)).toBeUndefined();
	});

	it("does not blow up when the KV binding is missing", async () => {
		mockAttio({});
		const res = await handleBookingHook(post(payloadWithToken("0123456789abcdef")), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t" }, url);
		expect(res.status).toBe(200);
	});

	it("is a no-op for the ordinary booking that carries no token", async () => {
		const writes = mockAttio({});
		const { kv, gets } = fakeKv({ "battr:0123456789abcdef": PARKED });
		await handleBookingHook(post({ email: "booker@corp.com" }), { BOOKING_HOOK_SECRET: SECRET, ATTIO_TOKEN: "t", MC_ATTR: kv }, url);
		expect(gets).toEqual([]);
		expect(writes.find((w) => w.body?.data?.values?.first_touch_source)).toBeUndefined();
	});
});
