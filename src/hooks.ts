/**
 * Booking webhook: intro booked → discount locked, automated.
 *
 * POST /mcp/mentoring/api/booking-hook with { secret, email, name?, note? }.
 * Trigger source: Reclaim webhook if available on Marian's plan, else a Zapier
 * "booking created" zap or a Google Calendar push watch on the calendar
 * marian.coach/meet books into — anything that can POST JSON works.
 *
 * On hit: find the person's entry in the Mentoring AI Inquiries list → PATCH
 * status "Intro booked" + intro_booked_at → Slack "🔒 discount locked". All
 * best-effort; the claim-code-in-booking-note manual flow stays the audit trail.
 */

const INQUIRIES_LIST_SLUG = "mentoring_ai_inquiries";

export type HookEnv = {
	BOOKING_HOOK_SECRET?: string;
	ATTIO_TOKEN?: string;
	SLACK_WEBHOOK_URL?: string;
};

const json = (data: unknown, status = 200): Response =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Marian's own addresses — never treat them as the visitor when scanning a booking payload. */
const OWN_EMAILS = new Set(["marian@marian.coach", "marian@kamenistak.com", "marian@engineeringleaders.io", "leads@marian.coach"]);

export async function handleBookingHook(request: Request, env: HookEnv, url: URL): Promise<Response> {
	if (!env.BOOKING_HOOK_SECRET) return json({ ok: false, error: "hook_not_configured" }, 503);

	const raw = await request.text().catch(() => "");
	let body: { secret?: string; email?: string; name?: string; note?: string } = {};
	try {
		body = JSON.parse(raw);
	} catch {
		// Tolerated: Reclaim's payload shape is not under our control; the raw-text scan below
		// still finds the attendee email and claim code.
	}
	// Shared-secret gate, three doors: ?secret= in the endpoint URL (Reclaim — its UI signs
	// with its own secret we don't verify; ours rides in the URL), the x-hook-secret header
	// (Zapier/manual), or the body field.
	const provided = url.searchParams.get("secret") ?? request.headers.get("x-hook-secret") ?? body.secret ?? "";
	if (provided !== env.BOOKING_HOOK_SECRET) return json({ ok: false, error: "forbidden" }, 403);

	// Tolerant extraction: explicit fields first, then a raw-text scan over whatever payload
	// the trigger sent (Reclaim event JSON, Zapier mapping, manual curl).
	const claimFromNote = raw.match(/AI16-\d{6}-[0-9A-F]{8}/i)?.[0]?.toUpperCase() ?? null;
	let email = (body.email ?? "").trim().toLowerCase();
	if (!email) {
		const found = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
		email = found.map((e) => e.toLowerCase()).find((e) => !OWN_EMAILS.has(e)) ?? "";
	}
	if (!email && !claimFromNote) return json({ ok: false, error: "need_email_or_claim_code" }, 400);

	let locked = false;
	let matchedName = body.name ?? email;

	if (env.ATTIO_TOKEN) {
		try {
			const headers = { Authorization: `Bearer ${env.ATTIO_TOKEN}`, "content-type": "application/json" };
			let entryId: string | undefined;

			// Path 1: the booking attendee's email → person → their inquiry entry.
			if (email) {
				const personRes = await fetch("https://api.attio.com/v2/objects/people/records/query", {
					method: "POST",
					headers,
					body: JSON.stringify({ filter: { email_addresses: email }, limit: 1 }),
				});
				const personData: any = personRes.ok ? await personRes.json().catch(() => ({ data: [] })) : { data: [] };
				const personId: string | undefined = personData?.data?.[0]?.id?.record_id;
				if (personId) {
					const entriesRes = await fetch(`https://api.attio.com/v2/objects/people/records/${personId}/entries?limit=100`, {
						headers: { Authorization: `Bearer ${env.ATTIO_TOKEN}` },
					});
					const entriesData: any = entriesRes.ok ? await entriesRes.json().catch(() => ({ data: [] })) : { data: [] };
					entryId = (entriesData.data ?? []).find((e: any) => e.list_api_slug === INQUIRIES_LIST_SLUG)?.entry_id;
				}
			}

			// Path 2: booked with a different email than the offer — the claim code pasted in
			// the booking note still finds the entry.
			if (!entryId && claimFromNote) {
				const byCodeRes = await fetch(`https://api.attio.com/v2/lists/${INQUIRIES_LIST_SLUG}/entries/query`, {
					method: "POST",
					headers,
					body: JSON.stringify({ filter: { claim_code: claimFromNote }, limit: 1 }),
				});
				const byCode: any = byCodeRes.ok ? await byCodeRes.json().catch(() => ({ data: [] })) : { data: [] };
				entryId = byCode?.data?.[0]?.id?.entry_id ?? byCode?.data?.[0]?.entry_id;
			}

			if (entryId) {
				const patchRes = await fetch(`https://api.attio.com/v2/lists/${INQUIRIES_LIST_SLUG}/entries/${entryId}`, {
					method: "PATCH",
					headers,
					body: JSON.stringify({ data: { entry_values: { status: "Intro booked" } } }),
				});
				locked = patchRes.ok;
				if (!patchRes.ok) console.error("booking-hook attio patch failed", patchRes.status, await patchRes.text().catch(() => ""));
			}
		} catch (e) {
			console.error("booking-hook attio exception", String(e));
		}
	}

	if (env.SLACK_WEBHOOK_URL) {
		await fetch(env.SLACK_WEBHOOK_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: `:lock: Intro booked — *${matchedName}*${claimFromNote ? ` · claim ${claimFromNote}` : ""}${locked ? " · Attio entry flipped to Intro booked" : " · no matching Attio entry found (check manually)"}`,
				unfurl_links: false,
			}),
		}).catch((e) => console.error("booking-hook slack exception", String(e)));
	}

	return json({ ok: true, locked, claim: claimFromNote });
}
