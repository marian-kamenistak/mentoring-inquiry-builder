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
	GA4_MEASUREMENT_ID?: string;
	GA4_API_SECRET?: string;
};

const json = (data: unknown, status = 200): Response =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** True for cancellation/decline/removal payloads — never advance the pipeline on these.
 * Scoped to the VALUE of an event-type-ish key (type/event/status/…) so a legitimate booking
 * payload that merely contains "cancel_url" or "cancellation policy" text isn't mistaken for one.
 * Falls back to a raw-text scan only when no such key is present (non-JSON / unknown shape). */
export function isCancellationPayload(raw: string): boolean {
	const typed = raw.match(/"(?:type|event|event_type|eventType|status|action|kind)"\s*:\s*"([^"]*)"/gi);
	if (typed && typed.length) {
		return typed.some((m) => {
			const value = m.match(/:\s*"([^"]*)"/)?.[1] ?? "";
			return /cancel|declin|delet|remov/i.test(value);
		});
	}
	return /cancel|declin|delet|remov/i.test(raw);
}

/** "How did you hear about me?" free-text answer, if the payload has one — scoped to the VALUE
 * next to a hear/slyšel/dozvěděl-labelled key so it doesn't over-match incidental text like
 * "hope to hear from you: soon". Handles both `"<label with hear>":"<answer>"` and Reclaim/typeform-
 * style `"question":"<label with hear>","answer":"<answer>"` shapes. */
export function extractHeardFrom(raw: string): string | null {
	const asKey = raw.match(/"[^"]*(?:hear|slyšel|dozvěděl)[^"]*"\s*:\s*"([^"]{2,200})"/i)?.[1];
	if (asKey) return asKey.trim();
	const asQuestion = raw.match(/"[^"]*(?:hear|slyšel|dozvěděl)[^"]*"\s*,\s*"answer"\s*:\s*"([^"]{2,200})"/i)?.[1];
	return asQuestion ? asQuestion.trim() : null;
}

/** GA4 Measurement Protocol body for a `call_booked` server-side conversion event. */
export function ga4CallBookedBody(clientId: string, params: Record<string, string | number>) {
	return {
		client_id: clientId,
		non_personalized_ads: false,
		events: [{ name: "call_booked", params: { ...params, engagement_time_msec: 1 } }],
	};
}

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

	// Cancellations/declines must never advance the pipeline or fire a conversion — bail before
	// any Attio or GA4 work starts.
	if (isCancellationPayload(raw)) return json({ ok: true, ignored: "cancellation" });

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

					const pv: any = personData.data[0].values ?? {};
					const val = (k: string) => pv?.[k]?.[0]?.value ?? "";
					// Funnel: Lead → Intro call.
					const pipe = (entriesData.data ?? []).find((e: any) => e.list_api_slug === "mentoring_pipeline");
					if (pipe) {
						await fetch(`https://api.attio.com/v2/lists/mentoring_pipeline/entries/${pipe.entry_id}`, {
							method: "PATCH",
							headers,
							body: JSON.stringify({ data: { entry_values: { stage: "Intro call" } } }),
						}).catch(() => {});
					} else {
						await fetch("https://api.attio.com/v2/lists/mentoring_pipeline/entries", {
							method: "POST",
							headers,
							body: JSON.stringify({
								data: { parent_record_id: personId, parent_object: "people", entry_values: { stage: "Intro call", added_via: "Manual", source: "booking" } },
							}),
						}).catch(() => {});
					}
					// "How did you hear about me?" — Reclaim passes custom question answers in the payload; keep the raw sentence.
					const heard = extractHeardFrom(raw);
					if (heard) {
						await fetch(`https://api.attio.com/v2/objects/people/records/${personId}`, {
							method: "PATCH",
							headers,
							body: JSON.stringify({ data: { values: { heard_from: heard } } }),
						}).catch(() => {});
					}
					// GA4 server-side conversion. Joins the browser session via ga_client_id when we have it.
					if (env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET) {
						const cid = val("ga_client_id") || `server.${[...email].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
						await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`, {
							method: "POST",
							body: JSON.stringify(
								ga4CallBookedBody(cid, { source: val("first_touch_source") || "direct", campaign: val("first_touch_campaign") || "", gclid: val("gclid") || "" })
							),
						}).catch((e) => console.error("ga4 mp exception", String(e)));
					}
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
