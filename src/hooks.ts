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
 *
 * Two kinds of booker, both handled:
 *   warm — came through the wizard, already a Person with an inquiry entry. Their
 *          entry flips to "Intro booked" and the pipeline advances to "Intro call".
 *   cold — clicked an ad, landed, booked the intro, never touched the wizard. They
 *          are not a Person yet, so one is created (assert on email) before the
 *          pipeline row and the GA4 `call_booked` conversion. Without that the
 *          whole paid funnel's only real outcome went unrecorded.
 */

import { splitName } from "./core/submit";

const INQUIRIES_LIST_SLUG = "mentoring_ai_inquiries";
const PIPELINE_LIST_SLUG = "mentoring_pipeline";

export type HookEnv = {
	BOOKING_HOOK_SECRET?: string;
	ATTIO_TOKEN?: string;
	SLACK_WEBHOOK_URL?: string;
	GA4_MEASUREMENT_ID?: string;
	GA4_API_SECRET?: string;
	/** Shared secret for www.marian.coach/api/prep-invite. Unset → the prep email is skipped. */
	PREP_INVITE_SECRET?: string;
	/** "true" → echo the raw booking payload to Slack. Diagnostic, see the echo block below. */
	BOOKING_HOOK_ECHO?: string;
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

/**
 * The attendee's name, if the payload carries one in a shape we can trust.
 *
 * WHY THIS IS DELIBERATELY NARROW. The first real booking (2026-08-21) produced an Attio Person
 * with no name at all: `body.name` was absent, so `matchedName` fell back to the address and
 * Slack announced "Intro booked — haytham88@gmail.com". The obvious fix — scan the raw payload
 * for `"name"` — is worse than the bug, because a booking payload is full of names that are not
 * the attendee's: the event ("Marian and Haytham - Mentoring open door"), the scheduling link,
 * the webhook, the calendar, the timezone. Writing one of those into a CRM as a person's name is
 * not recoverable by looking at the record later.
 *
 * So: explicit fields first, then ONLY attendee/invitee/guest-scoped keys, never a bare "name".
 * Anything that looks like an address or an event title is rejected. When nothing qualifies this
 * returns "" and the name is left to /api/booking-attr, which reads it from Reclaim's own return
 * redirect (`?attendee_name=`) — a shape that has been observed rather than guessed.
 */
export function extractAttendeeName(raw: string, body: any): string {
	const candidates: unknown[] = [
		// VERIFIED 2026-08-21 by a deliberate test booking + cancel (both payloads captured in
		// #mc-mentoring-bot). Reclaim api_version v2026-04-13 nests the booker under
		// meeting.attendee, and the ONLY bare `name` in the payload is participants[0].name —
		// which is Marian. That is the exact value a broad scan would have written into every
		// booker's Attio record, so this path stays first and the bare key stays excluded.
		body?.meeting?.attendee?.attendee_name,
		body?.name,
		body?.attendee?.name,
		body?.attendee_name,
		body?.attendeeName,
		body?.invitee?.name,
		body?.invitee_name,
		Array.isArray(body?.attendees) ? body.attendees[0]?.name : undefined,
	];
	const scoped = raw.match(/"(?:attendee|invitee|guest|booker)_?(?:full_?)?name"\s*:\s*"([^"]{1,120})"/i)?.[1];
	if (scoped) candidates.push(scoped);

	for (const c of candidates) {
		const v = typeof c === "string" ? c.trim() : "";
		if (!v || v.length > 120) continue;
		if (v.includes("@")) continue; // an address, not a name
		if (/\s-\s/.test(v)) continue; // "Marian and Haytham - Mentoring open door"
		return v;
	}
	return "";
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

/**
 * "Monday, 31 August at 21:30" for the prep email's date line, rendered in the ATTENDEE's own
 * timezone — not Marian's. Reclaim sends `meeting.attendee.attendee_zone_id.id` as an IANA name
 * for exactly this, and a booker in London being told a Prague time is worse than no time at all.
 *
 * Shapes seen in the two captured payloads: Created carried a local offset
 * ("2026-08-31T21:30:00+02:00") and Cancelled carried UTC ("2026-08-31T19:30:00Z") for the SAME
 * meeting — so this must never read the string, only the parsed instant.
 *
 * Returns "" on anything unexpected. The email drops the line rather than printing a wrong time.
 */
export function formatMeetingWhen(body: any): string {
	const start = body?.meeting?.start_time;
	if (typeof start !== "string" || !start) return "";
	const d = new Date(start);
	if (Number.isNaN(d.getTime())) return "";
	const tz = body?.meeting?.attendee?.attendee_zone_id?.id || "Europe/Prague";
	try {
		// Composed from parts rather than taking a locale's own joining: en-GB renders
		// "Monday 31 August", and the format Marian writes by hand is "Tuesday, 25 August at 17:00".
		// The comma is his, so it is assembled here instead of inherited from ICU.
		const parts = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).formatToParts(d);
		const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
		const weekday = part("weekday"), day = part("day"), month = part("month");
		if (!weekday || !day || !month) return "";
		const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(d);
		return `${weekday}, ${day} ${month} at ${time}`;
	} catch {
		return "";
	}
}

/** `call_booked` is a conversion, so it may only fire on the actual transition INTO `Intro call`.
 * A re-sent or duplicated booking webhook (Reclaim retries, a Zapier replay, a reschedule) hits
 * this endpoint again with the person already parked on `Intro call` — counting that as a second
 * conversion would inflate every ad platform's ROAS. Pass the person's `mentoring_pipeline` entry
 * (or null/undefined when they have none yet). */
export function shouldFireCallBooked(pipeEntry: any): boolean {
	if (!pipeEntry) return true;
	const stage = pipeEntry?.entry_values?.stage?.[0]?.option?.title;
	return stage !== "Intro call";
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
	/** `meeting` is Reclaim's own envelope — shape captured 2026-08-21, see reclaim-webhook.md.
	    Left as `any` on purpose: it is a third party's payload, and the code reads it through
	    narrow accessors (extractAttendeeName, formatMeetingWhen) that each validate what they take. */
	let body: { secret?: string; email?: string; name?: string; note?: string; meeting?: any } = {};
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

	console.log("[BOOKING_HOOK_RAW]", raw.slice(0, 2000));

	// ...and to Slack, because the log alone has been unreadable: the shared CLOUDFLARE_API_TOKEN
	// 403s on every observability endpoint (verified 2026-08-21 — it lists 33 Workers fine, so it is
	// a missing scope, not a bad request), and the dashboard needs a human. Echoing here means the
	// next booking, real or a deliberate test, reveals the payload shape to whoever is looking.
	// Placed BEFORE the cancellation guard on purpose: reclaim-webhook.md's other open gap is that
	// the handler cannot tell a booking from a reschedule or a cancel, and those payloads return
	// early — so echoing after the guard would never show the very shapes that gap needs.
	// TEMPORARY. Flip BOOKING_HOOK_ECHO to "false" in wrangler.jsonc and redeploy once the shape is
	// written into _mentoring/reclaim-webhook.md — this posts a booker's name and address verbatim.
	if (env.BOOKING_HOOK_ECHO === "true" && env.SLACK_WEBHOOK_URL) {
		await fetch(env.SLACK_WEBHOOK_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: `:microscope: Raw booking payload (diagnostic — turn off once mapped)\n\`\`\`${raw.slice(0, 2500) || "(empty body)"}\`\`\``,
				unfurl_links: false,
			}),
		}).catch((e) => console.error("booking-hook echo exception", String(e)));
	}

	// Cancellations/declines must never advance the pipeline or fire a conversion — bail before
	// any Attio or GA4 work starts.
	if (isCancellationPayload(raw)) return json({ ok: true, ignored: "cancellation" });

	// Tolerant extraction: explicit fields first, then a raw-text scan over whatever payload
	// the trigger sent (Reclaim event JSON, Zapier mapping, manual curl).
	const claimFromNote = raw.match(/AI16-\d{6}-[0-9A-F]{8}/i)?.[0]?.toUpperCase() ?? null;
	let email = (body.email ?? body?.meeting?.attendee?.attendee_email ?? "").trim().toLowerCase();
	if (!email) {
		const found = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
		email = found.map((e) => e.toLowerCase()).find((e) => !OWN_EMAILS.has(e)) ?? "";
	}
	if (!email && !claimFromNote) return json({ ok: false, error: "need_email_or_claim_code" }, 400);

	// The payload shape is STILL unverified — _mentoring/reclaim-webhook.md's "Known gap" asks for
	// exactly this: read a real one from the logs, then add event-type filtering and pull the name,
	// meeting time and language from their actual fields instead of inferring them. Logged once per
	// booking, truncated, and only on the hook path. It carries the booker's name and address, so
	// it is PII in the Worker log for the retention window — that is the price of stopping the
	// guesswork, and it comes out once the shape is written down.

	/* Test-mode guard, mirroring /api/prep and /api/email-capture in mc-web. This Worker had none,
	   which is why Attio still carries People called "GA4 Probe Two" and "Cold Booker Test" from
	   earlier probes — and, worse, why each of those fired a real GA4 `call_booked`, the primary
	   Google Ads conversion, which cannot be retracted once sent. A booking hook is the one place
	   a test is genuinely expensive.
	   Scoped TIGHT to the address (^test@ / +test@), never to names or free text: a 2026-08-21
	   audit found /test/i guards elsewhere silently eating submissions from anyone called "Testa".
	   Slack still posts, so a deliberate test is visible rather than silent. */
	const isTestBooking = /^test@|\+test@/i.test(email);
	if (isTestBooking) console.log("[BOOKING_HOOK_TEST_MODE] skipping Attio + GA4 + prep email for", email);

	let locked = false;
	let createdPerson = false;
	const attendeeName = extractAttendeeName(raw, body);
	let matchedName = attendeeName || email;
	// Gates the prep email. A Reclaim retry, a Zapier replay or a reschedule hits this endpoint
	// again for someone already parked on `Intro call`; the Attio block below flips this to false
	// in that case so they are not emailed the same question twice. Same transition test that
	// guards the GA4 conversion — see shouldFireCallBooked.
	let isFirstBooking = true;

	if (env.ATTIO_TOKEN && !isTestBooking) {
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
				let personId: string | undefined = personData?.data?.[0]?.id?.record_id;
				let personValues: any = personData?.data?.[0]?.values ?? {};

				// COLD BOOKER (fix 2026-08-16). Someone who clicks an ad, lands, and books the intro
				// without ever touching the wizard or a form is not an Attio Person yet. Until this
				// block existed the lookup simply missed and everything below no-opped in silence:
				// no `mentoring_pipeline` row, so the intro never entered the funnel, and no GA4
				// `call_booked` — which is the PRIMARY Google Ads conversion (361 EUR in
				// google-ads-setup.md). Booking-direct is the most common path for paid traffic, so
				// that was the campaign quietly under-reporting its only real outcome.
				// Assert (PUT + matching_attribute) rather than POST: race-safe if two hooks land at
				// once, and it returns the existing record instead of a duplicate.
				if (!personId) {
					const { first, last } = splitName(attendeeName);
					const created = await fetch("https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses", {
						method: "PUT",
						headers,
						body: JSON.stringify({
							data: {
								values: {
									email_addresses: [email],
									...(first ? { name: [{ first_name: first, last_name: last, full_name: attendeeName }] } : {}),
								},
							},
						}),
					});
					if (created.ok) {
						const rec: any = await created.json().catch(() => null);
						personId = rec?.data?.id?.record_id;
						personValues = rec?.data?.values ?? {};
						createdPerson = Boolean(personId);
					} else {
						console.error("booking-hook attio person create failed", created.status, await created.text().catch(() => ""));
					}
				}

				if (personId) {
					const entriesRes = await fetch(`https://api.attio.com/v2/objects/people/records/${personId}/entries?limit=100`, {
						headers: { Authorization: `Bearer ${env.ATTIO_TOKEN}` },
					});
					const entriesData: any = entriesRes.ok ? await entriesRes.json().catch(() => ({ data: [] })) : { data: [] };
					entryId = (entriesData.data ?? []).find((e: any) => e.list_api_slug === INQUIRIES_LIST_SLUG)?.entry_id;

					const val = (k: string) => personValues?.[k]?.[0]?.value ?? "";
					// Funnel: Lead → Intro call. Only an actual transition counts — see shouldFireCallBooked.
					const pipe = (entriesData.data ?? []).find((e: any) => e.list_api_slug === PIPELINE_LIST_SLUG);
					let pipeEntry: any = pipe;
					if (pipe && !pipe.entry_values) {
						// The memberships payload doesn't always carry entry_values; one GET reads the stage.
						const pipeRes = await fetch(`https://api.attio.com/v2/lists/${PIPELINE_LIST_SLUG}/entries/${pipe.entry_id}`, {
							headers: { Authorization: `Bearer ${env.ATTIO_TOKEN}` },
						});
						if (pipeRes.ok) {
							const pipeData: any = await pipeRes.json().catch(() => null);
							if (pipeData?.data) pipeEntry = pipeData.data;
						}
					}
					const isTransition = shouldFireCallBooked(pipe ? pipeEntry : null);
					isFirstBooking = isTransition;
					if (pipe) {
						// Already on Intro call → the PATCH would be a no-op write. Skip it.
						if (isTransition) {
							// `intro_arranged` drives the Mentoring flow kanban and Marian moves those cards by
							// hand. Seed it only when it is still blank — someone already on `mentoring` who
							// books through the intro link must not be dragged back to `intro arranged`.
							const onBoard = pipeEntry?.entry_values?.intro_arranged?.[0]?.status?.title;
							const values: Record<string, string> = { stage: "Intro call" };
							if (!onBoard) values.intro_arranged = "intro arranged";
							await fetch(`https://api.attio.com/v2/lists/${PIPELINE_LIST_SLUG}/entries/${pipe.entry_id}`, {
								method: "PATCH",
								headers,
								body: JSON.stringify({ data: { entry_values: values } }),
							}).catch((e) => console.error("attio pipeline stage exception", String(e)));
						}
					} else {
						await fetch(`https://api.attio.com/v2/lists/${PIPELINE_LIST_SLUG}/entries`, {
							method: "POST",
							headers,
							body: JSON.stringify({
								data: { parent_record_id: personId, parent_object: "people", entry_values: { stage: "Intro call", intro_arranged: "intro arranged", added_via: "Manual", source: "booking" } },
							}),
						}).catch((e) => console.error("attio pipeline create exception", String(e)));
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
					// Transition-only: a repeat webhook for someone already on Intro call fires nothing.
					if (isTransition && env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET) {
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

	// ── Prep email: the one question, asked between the booking and the call ──────────────────
	// Until this existed (2026-08-21) a booker heard nothing from Marian between booking and the
	// session — Reclaim's calendar invite was the entire follow-up, so the intro opened cold and
	// spent its first minutes on discovery. Rendered and sent by mc-web, which owns the email
	// chassis; this only supplies the address.
	//
	// The date line is now real: the payload shape was captured on 2026-08-21 and `when` comes from
	// meeting.start_time rendered in the attendee's own timezone. It still degrades to no line if
	// the field is missing or unparseable — a wrong time is worse than none.
	//
	// Language still defaults to EN, deliberately. The payload's only locale-ish signal is the
	// attendee timezone, and Europe/Prague does not mean the booker reads Czech — half of Marian's
	// Prague pipeline is expats. Guessing wrong here greets someone in a language they do not
	// speak, which is worse than a formal-but-correct English email. A CZ booker gets re-sent by hand.
	let prepEmailed = false;
	if (env.PREP_INVITE_SECRET && email && isFirstBooking && !isTestBooking) {
		try {
			const prepRes = await fetch("https://www.marian.coach/api/prep-invite", {
				method: "POST",
				headers: { "content-type": "application/json", "x-prep-secret": env.PREP_INVITE_SECRET },
				body: JSON.stringify({ email, name: attendeeName, when: formatMeetingWhen(body), lang: "en" }),
			});
			prepEmailed = prepRes.ok;
			if (!prepRes.ok) console.error("prep-invite failed", prepRes.status, await prepRes.text().catch(() => ""));
		} catch (e) {
			console.error("prep-invite exception", String(e));
		}
	}

	if (env.SLACK_WEBHOOK_URL) {
		await fetch(env.SLACK_WEBHOOK_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: `${isTestBooking ? ":test_tube: TEST booking (nothing written)" : ":lock: Intro booked"} — *${matchedName}*${claimFromNote ? ` · claim ${claimFromNote}` : ""}${
					locked
						? " · Attio entry flipped to Intro booked"
						: createdPerson
							? " · new Person created and added to the pipeline as Intro call (booked direct, no wizard inquiry)"
							: " · no matching Attio entry found (check manually)"
				}${prepEmailed ? " · prep email sent" : isFirstBooking ? " · *prep email NOT sent*" : ""}`,
				unfurl_links: false,
			}),
		}).catch((e) => console.error("booking-hook slack exception", String(e)));
	}

	return json({ ok: true, locked, created_person: createdPerson, claim: claimFromNote, prep_emailed: prepEmailed });
}
