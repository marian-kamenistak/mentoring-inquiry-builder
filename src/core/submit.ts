/**
 * Offer submission — the ONLY mutating path. Ported from the ELC partnership-builder
 * submit.ts chassis (test-mode guard, Promise.all fan-out, best-effort side effects) with
 * the Attio patterns from mc-web's ai-waitlist.ts (person upsert, typed entry_values,
 * duplicate check then PATCH).
 *
 * Server-side recompute is the contract: no tool accepts a price as input. The discount is
 * keyed on channel (chat|mcp — the web configurator never discounts), the B2B concession is
 * clamped against catalog data, and price_agreed is a hard gate — the offer email does not
 * exist until the visitor said yes to a number the catalog computed.
 *
 * Claim code: AI<pct>-<YYMMDD>-<8 hex> (AI10- since 2026-08-30) where hex = first 8 of
 * HMAC-SHA256(CLAIM_SECRET, lower(email)|offer_id|YYMMDD|channel). Verifiable at
 * /mcp/mentoring/api/verify without any datastore — the Attio entry is primary evidence,
 * the HMAC is the independent audit trail.
 */
import { type Attribution, attributionValues, laneFromCampaign } from "./attribution";
import {
	aiDiscount,
	clampConcession,
	discountFor,
	effectiveRate,
	eur,
	focusAreaById,
	isPerLeader,
	leaderMultiplier,
	meta,
	motivationById,
	multiLeaderError,
	offerById,
	offers,
	priceDisplay,
	roleBandById,
	routing,
	sessionsBreakdown,
	sessionsDelivered,
	vatFor,
	visibilityById,
	visibilityOptions,
	type Offer,
} from "./catalog";
import { buildProgram, renderProgram, type Program } from "./program";

const DAY_MS = 24 * 60 * 60 * 1000;
const INQUIRIES_LIST_SLUG = "mentoring_ai_inquiries";
const PIPELINE_LIST_SLUG = "mentoring_pipeline";
const ATTIO_LIST_URL = "https://app.attio.com/marian/list/mentoring_ai_inquiries";

export type SubmitEnv = {
	ATTIO_TOKEN?: string;
	RESEND_API_KEY?: string;
	SLACK_WEBHOOK_URL?: string;
	LEAD_NOTIFY_TO?: string;
	LEAD_NOTIFY_FROM?: string;
	CLAIM_SECRET?: string;
};

export type SubmitInput = {
	name: string;
	email: string;
	audience: "individual" | "company";
	role_band: string;
	motivation: string;
	focus_area_ids: string[];
	success_definition: string;
	offer_id: string;
	price_agreed: boolean;
	company?: string;
	leaders_count?: number;
	free_sessions_requested?: number;
	start_date?: string;
	visibility?: string;
	notes?: string;
	channel: "chat" | "mcp";
	attribution?: Attribution;
};

export type SubmitResult =
	| {
			ok: true;
			offerName: string;
			claimCode: string;
			listPrice: number;
			listPriceDisplay: string;
			finalPrice: number;
			finalPriceDisplay: string;
			discountPct: number | null;
			freeSessions: number;
			/** Set when a requested concession was refused — never silently zero it. */
			concessionRejected: string | null;
			/** Canonical consent id, echoed so it is visibly recorded and not merely validated. */
			visibility: string | null;
			sessionsTotal: number;
			/** Paid + free sessions — the divisor behind effectivePerSession. */
			sessionsCounted: number;
			effectivePerSession: number;
			floorPerSession: number;
			breachesFloor: boolean;
			commitment: string | null;
			/** Human-readable VAT treatment for this buyer, incl. the gross figure for individuals. */
			vat: string | null;
			test: boolean;
	  }
	| { ok: false; error: string };

/**
 * `fetch` resolves on a 4xx, so a bare `.catch` on an Attio write sees nothing when Attio
 * actually rejects it — and Attio 400s the WHOLE request on a single unknown slug. Every
 * fire-and-forget write goes through here instead, because `console.error` is what the daily
 * 4mc-pipeline-health job alerts on: a silent 400 is a lead lost with a green dashboard.
 */
async function attioWrite(label: string, url: string, init: RequestInit): Promise<boolean> {
	try {
		const res = await fetch(url, init);
		if (!res.ok) {
			console.error(`attio ${label} failed`, res.status, await res.text().catch(() => ""));
			return false;
		}
		return true;
	} catch (e) {
		console.error(`attio ${label} exception`, String(e));
		return false;
	}
}

export function splitName(full: string): { first: string; last: string } {
	const clean = full.trim().replace(/\s+/g, " ");
	const parts = clean.split(" ");
	return { first: parts[0] ?? "", last: parts.length > 1 ? parts.slice(1).join(" ") : "" };
}

export async function claimCode(secret: string | undefined, email: string, offerId: string, channel: string, date: Date): Promise<string> {
	const ymd = date.toISOString().slice(2, 10).replace(/-/g, "");
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret || "unset-claim-secret"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${email.toLowerCase()}|${offerId}|${ymd}|${channel}`));
	const hex = [...new Uint8Array(sig)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 8);
	// The prefix names the campaign that actually applied. Stamping "AI16" on a €430 single
	// session at 0% off was the defect two testers said they would screenshot and argue about
	// — a code named after a discount that was never granted. Derived from (offerId, channel)
	// only, so /api/verify reproduces it without needing an extra parameter.
	const d = discountFor(offerId, channel);
	const prefix = d ? `AI${d.pct}` : "MC";
	return `${prefix}-${ymd}-${hex.toUpperCase()}`;
}

async function postSlack(webhook: string | undefined, text: string): Promise<void> {
	if (!webhook) return;
	try {
		const res = await fetch(webhook, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
		});
		if (!res.ok) console.error("slack webhook failed", res.status);
	} catch (e) {
		console.error("slack webhook exception", String(e));
	}
}

export async function submitInquiry(env: SubmitEnv, input: SubmitInput): Promise<SubmitResult> {
	const name = input.name.trim().slice(0, 150);
	const email = input.email.trim().toLowerCase().slice(0, 200);
	const company = (input.company ?? "").trim().slice(0, 150);
	const successDef = input.success_definition.trim().slice(0, 1500);
	const notes = (input.notes ?? "").trim().slice(0, 1000);
	const { channel, audience } = input;

	if (!name) return { ok: false, error: "missing_name" };
	if (!/^\S+@\S+\.\S+$/.test(email)) return { ok: false, error: "invalid_email" };
	if (!input.price_agreed) {
		return { ok: false, error: "price_not_agreed — read the exact price back to the visitor and get an explicit yes before sending the offer" };
	}
	const offer = offerById(input.offer_id);
	if (!offer) return { ok: false, error: `unknown_offer — valid: ${offers.map((o) => o.id).join(", ")}` };
	if (!roleBandById(input.role_band)) return { ok: false, error: `unknown_role_band — valid: ${routing.role_bands.map((b) => b.id).join(", ")}` };
	if (!motivationById(input.motivation)) return { ok: false, error: "unknown_motivation" };
	if (!successDef) return { ok: false, error: "missing_success_definition" };
	const focus = input.focus_area_ids.map((id) => focusAreaById(id)).filter(Boolean);
	if (!focus.length) return { ok: false, error: "missing_focus_areas" };
	if (audience !== "company" && offer.audience === "company") return { ok: false, error: `offer "${offer.id}" is company-only` };

	// ── The authoritative price. Model/client numbers never enter. ──
	// Same rule as composeBrief: a company deal never silently assumes one leader.
	if (audience === "company" && (input.leaders_count === undefined || input.leaders_count === null)) {
		return { ok: false, error: "leaders_count is required for a company deal (that exact spelling) — it sets the price and decides the B2B concession, so it is never assumed to be 1." };
	}
	const leaders = audience === "company" ? Math.max(1, Math.min(50, input.leaders_count ?? 1)) : 1;
	// Refuse rather than silently under-bill: 10 leaders on `single-session` used to invoice
	// €430 and 10 on `monthly` €790, because the multiplier was a hardcoded offer-id check.
	const mlErr = multiLeaderError(offer, leaders);
	if (mlErr) return { ok: false, error: mlErr };
	const multi = leaderMultiplier(offer, leaders);
	const discount = discountFor(offer.id, channel);
	const perLeader = discount ? discount.priceAfter : offer.price;
	const listPrice = offer.price * multi;
	const finalPrice = perLeader * multi;
	const concession = clampConcession(audience, leaders, offer.id, input.free_sessions_requested ?? 0);
	const freeSessions = concession.granted;
	const sessionsTotal = sessionsDelivered(offer, leaders);
	const rate = effectiveRate(finalPrice, offer, leaders, freeSessions);

	// Consent must never fail open. An unrecognised visibility value used to vanish silently,
	// leaving a record indistinguishable from one where consent was never asked.
	if (input.visibility?.trim() && !visibilityById(input.visibility)) {
		return {
			ok: false,
			error: `unknown visibility "${input.visibility}" — this records CONSENT and is never guessed. Valid: ${visibilityOptions.map((v) => v.id).join(", ")}.`,
		};
	}
	const visibility = input.visibility && visibilityById(input.visibility) ? visibilityById(input.visibility)!.id : null;

	const now = new Date();
	const code = await claimCode(env.CLAIM_SECRET, email, offer.id, channel, now);
	// Every tester who tried to raise a purchase order stopped at the same missing field: an
	// offer with no expiry, whose price was instead conditional on an unnumbered race against
	// strangers. 30 days is a date a buyer can put in a calendar and a committee can approve
	// against; the claim code already carries its issue date.
	const validUntil = new Date(now.getTime() + 30 * DAY_MS).toISOString().slice(0, 10);
	const { first, last } = splitName(name);

	// Test-mode guard (mc-web + ELC precedent): previews emails + [TEST] Slack, CRM untouched.
	const isTest = /^test@|\+test@/i.test(email) || /^test\b/i.test(name);
	if (isTest) console.log("[OFFER_TEST_MODE] skipping Attio for", { name, email, channel });

	const notifyTo = env.LEAD_NOTIFY_TO ?? "marian@marian.coach";
	const notifyFrom = env.LEAD_NOTIFY_FROM ?? "leads@marian.coach";

	let program: Program | null = null;
	if (input.start_date) {
		const p = buildProgram(offer, input.start_date);
		if (!("error" in p)) program = p;
	}

	const focusLines = focus.map((f) => `• ${f!.label}`);
	const priceLines = discount
		? [
				`List price: ${priceDisplay(offer, listPrice)}${multi > 1 ? ` (${leaders} leaders × ${eur(offer.price)})` : ""}`,
				// "intro booked" removed 2026-08-30: the booking has not been a condition of this
				// price since 2026-08-21, and this line was printing the old condition into every
				// offer email — the one artifact a buyer keeps and forwards.
				`AI-channel price (-${discount.pct}%): ${priceDisplay(offer, finalPrice)}`,
			]
		: [`Price: ${priceDisplay(offer, finalPrice)}`];
	if (offer.commitment) priceLines.push(`Commitment: ${offer.commitment.terms}`);
	{ const v = vatFor(audience, finalPrice); if (v) priceLines.push(`VAT: ${v.display}`); }
	// Packages add free sessions, not a lower rate (2026-08-30) — the breakdown rides with the count.
	priceLines.push(`Sessions: ${sessionsTotal} (${sessionsBreakdown(offer)}${multi > 1 ? ` per leader × ${leaders}` : ""})${!isPerLeader(offer) && leaders > 1 ? ` (pooled across ${leaders} leaders)` : ""} — ${eur(offer.per_session ?? offer.price)} per paid session at list, effective ${eur(rate.perSession)}/session`);
	if (freeSessions > 0) {
		priceLines.push(`B2B concession proposed: +${freeSessions} free sessions (Marian confirms on the intro call) → effective ${eur(rate.perSession)}/session`);
	}
	// Surface the breach to Marian rather than letting him discover it at invoice.
	if (rate.breachesFloor) {
		priceLines.push(`⚠ FLOOR BREACH: ${eur(rate.perSession)}/session — ${eur(finalPrice)} across ${rate.sessions} sessions (${sessionsTotal} paid + ${freeSessions} free) is below the stated ${eur(rate.floor)} floor. Confirm before invoicing.`);
	}
	if (concession.rejected) priceLines.push(`Concession NOT applied: ${concession.rejected}`);

	const briefLines = [
		`${offer.name} — built via ${channel === "chat" ? "the marian.coach chat wizard" : "the MCP server"}`,
		...priceLines,
		"",
		`Audience: ${audience}${audience === "company" ? ` (${leaders} leader${leaders > 1 ? "s" : ""}${company ? `, ${company}` : ""})` : ""}`,
		`Role: ${roleBandById(input.role_band)!.label}`,
		`Why now: ${motivationById(input.motivation)!.label}`,
		"",
		"Focus areas:",
		...focusLines,
		"",
		`Definition of success (their words): ${successDef}`,
		...(visibility ? [`Visibility: ${visibilityById(visibility)!.label}`] : []),
		...(notes ? ["", `Notes: ${notes}`] : []),
		...(program ? ["", renderProgram(program)] : []),
		"",
		`Claim code: ${code}`,
	].join("\n");

	const slackPrice = discount
		? `~${eur(listPrice)}~ → *${priceDisplay(offer, finalPrice)}* (AI channel, -${discount.pct}%)`
		: `*${priceDisplay(offer, finalPrice)}*`;
	const slackText = [
		`${isTest ? "[TEST] " : ""}:robot_face: *${name}*${company ? ` (${company})` : ""} agreed a *${offer.name}* offer via *${channel}* at ${slackPrice}${freeSessions ? ` +${freeSessions} free sessions proposed` : ""}`,
		`${audience} · ${roleBandById(input.role_band)!.label} · ${focus.map((f) => f!.id).join(", ")} · ${email}${visibility?.startsWith("yes") ? " · :loudspeaker: open to public announcement" : ""}`,
		`Claim ${code} · awaiting intro booking · <${ATTIO_LIST_URL}|Mentoring AI Inquiries>`,
	].join("\n");

	// ── Attio: person upsert (+ company link for B2B) + inquiry list entry ──
	const attioPromise =
		env.ATTIO_TOKEN && !isTest
			? (async () => {
					try {
						const headers = { Authorization: `Bearer ${env.ATTIO_TOKEN}`, "content-type": "application/json" };
						const personRes = await fetch("https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses", {
							method: "PUT",
							headers,
							body: JSON.stringify({
								data: { values: { email_addresses: [email], name: [{ first_name: first, last_name: last, full_name: name }] } },
							}),
						});
						if (!personRes.ok) {
							console.error("attio person upsert failed", personRes.status, await personRes.text().catch(() => ""));
							return null;
						}
						const personRec: any = await personRes.json();
						const personId: string | undefined = personRec?.data?.id?.record_id;
						if (!personId) return null;

						// Attribution from the mc_attr cookie, or a synthetic MCP first touch when the caller
						// is an assistant and has no cookie to carry one. First touch is written once; click
						// ids, the GA client id and last touch describe THIS conversion and refresh every time.
						const attrValues = attributionValues(channel, input.attribution, personRec?.data?.values, now);
						if (Object.keys(attrValues).length) {
							await attioWrite("attribution patch", `https://api.attio.com/v2/objects/people/records/${personId}`, {
								method: "PATCH", headers,
								body: JSON.stringify({ data: { values: attrValues } }),
							});
						}

						// B2B: company find-or-create + record-reference link (never a string — 400s).
						if (company) {
							let companyId: string | undefined;
							const companyQueryRes = await fetch("https://api.attio.com/v2/objects/companies/records/query", {
								method: "POST",
								headers,
								body: JSON.stringify({ filter: { name: { $contains: company } }, limit: 1 }),
							});
							if (companyQueryRes.ok) {
								const companyData: any = await companyQueryRes.json().catch(() => ({ data: [] }));
								companyId = companyData?.data?.[0]?.id?.record_id;
							}
							if (!companyId) {
								const companyCreateRes = await fetch("https://api.attio.com/v2/objects/companies/records", {
									method: "POST",
									headers,
									body: JSON.stringify({ data: { values: { name: company } } }),
								});
								if (companyCreateRes.ok) {
									const created: any = await companyCreateRes.json();
									companyId = created?.data?.id?.record_id;
								}
							}
							if (companyId) {
								await attioWrite("person-company link", `https://api.attio.com/v2/objects/people/records/${personId}`, {
									method: "PATCH",
									headers,
									body: JSON.stringify({
										data: { values: { company: [{ target_object: "companies", target_record_id: companyId }] } },
									}),
								});
							}
						}

						const entryValues: Record<string, unknown> = {
							status: "Awaiting intro",
							added_from: channel,
							audience,
							role_band: input.role_band,
							motivation: input.motivation,
							focus_areas: focus.map((f) => f!.id).join(", "),
							success_definition: successDef,
							package: offer.id,
							list_price_eur: String(listPrice),
							final_price_eur: String(finalPrice),
							// The unit used to be lost on the way to the CRM too: a recurring
							// €790/month subscription landed in the pipeline as a €790 one-off,
							// under-forecasting a 12-month deal by roughly 10x.
							price_unit: offer.unit ?? "per_engagement",
							sessions_total: String(sessionsTotal),
							effective_per_session_eur: String(rate.perSession),
							free_sessions: String(freeSessions),
							leaders_count: String(leaders),
							claim_code: code,
							offer_valid_until: validUntil,
							// The free text they typed: payment preferences, urgency, the seat they
							// actually sit in. It reached the offer email and stopped there, so the
							// most actionable thing about a lead existed nowhere in the CRM.
							...(notes ? { notes } : {}),
							...(visibility ? { visibility } : {}),
						};

						// Duplicate check via the person's memberships (never a parent_record path
						// filter — 500s, ELC finding). PATCH the existing entry instead of duplicating.
						// Reused below for the mentoring_pipeline entry too.
						const entriesRes = await fetch(`https://api.attio.com/v2/objects/people/records/${personId}/entries?limit=100`, {
							headers: { Authorization: `Bearer ${env.ATTIO_TOKEN}` },
						});
						const entriesData: any = entriesRes.ok ? await entriesRes.json().catch(() => ({ data: [] })) : { data: [] };
						const existing = (entriesData.data ?? []).find((e: any) => e.list_api_slug === INQUIRIES_LIST_SLUG);

						let inquiryResult: { updated: true } | { created: boolean };
						if (existing) {
							const patchRes = await fetch(`https://api.attio.com/v2/lists/${INQUIRIES_LIST_SLUG}/entries/${existing.entry_id}`, {
								method: "PATCH",
								headers,
								body: JSON.stringify({ data: { entry_values: entryValues } }),
							});
							if (!patchRes.ok) console.error("attio inquiry update failed", patchRes.status, await patchRes.text().catch(() => ""));
							inquiryResult = { updated: true };
						} else {
							const postRes = await fetch(`https://api.attio.com/v2/lists/${INQUIRIES_LIST_SLUG}/entries`, {
								method: "POST",
								headers,
								body: JSON.stringify({ data: { parent_record_id: personId, parent_object: "people", entry_values: entryValues } }),
							});
							if (!postRes.ok) console.error("attio inquiry create failed", postRes.status, await postRes.text().catch(() => ""));
							inquiryResult = { created: postRes.ok };
						}

						// Funnel list: one row per person, stage Lead, carries the agreed SKU + value.
						const cmp = input.attribution?.last.cmp ?? input.attribution?.first.cmp;
						const lane = laneFromCampaign(cmp);
						const pipeVals: Record<string, unknown> = { sku: offer.id, value_eur: finalPrice, ...(cmp ? { campaign: cmp } : {}), ...(lane ? { lane } : {}) };
						const pipe = (entriesData.data ?? []).find((e: any) => e.list_api_slug === PIPELINE_LIST_SLUG);
						if (pipe) {
							await attioWrite("pipeline update", `https://api.attio.com/v2/lists/${PIPELINE_LIST_SLUG}/entries/${pipe.entry_id}`, { method: "PATCH", headers, body: JSON.stringify({ data: { entry_values: pipeVals } }) });
						} else {
							await attioWrite("pipeline create", `https://api.attio.com/v2/lists/${PIPELINE_LIST_SLUG}/entries`, {
								method: "POST",
								headers,
								body: JSON.stringify({ data: { parent_record_id: personId, parent_object: "people", entry_values: { mentee_stage: "Not yet", added_via: "AI wizard", source: channel, ...pipeVals } } }),
							});
						}

						return inquiryResult;
					} catch (e) {
						console.error("attio exception", String(e));
						return null;
					}
				})()
			: Promise.resolve(null);

	const slackPromise = attioPromise.then((attio: any) => {
		const text = attio?.updated ? slackText.replace("agreed a", "updated their") : slackText;
		return postSlack(env.SLACK_WEBHOOK_URL, text);
	});

	// ── Internal notify: durable lead record even if Attio is down ──
	const notifyPromise = env.RESEND_API_KEY
		? fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
				body: JSON.stringify({
					from: `Mentoring AI Wizard <${notifyFrom}>`,
					to: notifyTo,
					subject: `${isTest ? "[TEST, not in Attio] " : ""}Mentoring offer agreed via ${channel}: ${name} — ${offer.name} ${eur(finalPrice)}${freeSessions ? ` +${freeSessions} free` : ""}`,
					reply_to: email,
					text: [`New mentoring offer agreed through the AI channel (${channel})`, "", `Name:  ${name}`, `Email: ${email}`, ...(company ? [`Company: ${company}`] : []), "", briefLines, "", `List: ${ATTIO_LIST_URL}`].join("\n"),
				}),
			}).catch((e) => {
				console.error("resend notify exception", e);
				return null;
			})
		: Promise.resolve(null);

	const offerEmailPromise = env.RESEND_API_KEY
		? fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
				body: JSON.stringify({
					from: `Marian Kamenistak <${notifyFrom}>`,
					to: email,
					subject: `Your mentoring offer ${code}: ${offer.name}, ${eur(finalPrice)}`,
					reply_to: notifyTo,
					html: offerEmailHtml({
						first,
						offer,
						sessions: sessionsTotal,
						focus: focus.map((f) => f!.label),
						successDef,
						listPrice,
						finalPrice,
						discountPct: discount?.pct ?? null,
						freeSessions,
						leaders,
						effectivePerSession: rate.perSession,
						isCompany: audience === "company",
						vat: vatFor(audience, finalPrice)?.display ?? null,
						validUntil,
						code,
						program,
					}),
				}),
			}).catch((e) => {
				console.error("resend offer email exception", e);
				return null;
			})
		: Promise.resolve(null);

	await Promise.all([notifyPromise, offerEmailPromise, attioPromise, slackPromise]);

	if (!env.RESEND_API_KEY) {
		console.log("[INQUIRY_SUBMIT_LOG]", { name, email, company, offer: offer.id, listPrice, finalPrice, freeSessions, channel, code });
	}
	return {
		ok: true,
		offerName: offer.name,
		claimCode: code,
		listPrice,
		listPriceDisplay: priceDisplay(offer, listPrice),
		finalPrice,
		finalPriceDisplay: priceDisplay(offer, finalPrice),
		discountPct: discount?.pct ?? null,
		freeSessions,
		concessionRejected: concession.rejected,
		// Echoed back so the consent answer is visible in the result, not merely validated and
		// then dropped: a tester called the previous behaviour "validation theatre", and she
		// was right — the answer reached Attio and nothing else.
		visibility,
		sessionsTotal,
		// The count the effective rate is divided by = paid + free. Reporting the paid-only
		// figure next to a concession rate made the floor warning contradict its own
		// arithmetic (249.92 x 18 = 4,498.56, not 6,498).
		sessionsCounted: rate.sessions,
		effectivePerSession: rate.perSession,
		floorPerSession: rate.floor,
		breachesFloor: rate.breachesFloor,
		commitment: offer.commitment?.terms ?? null,
		vat: vatFor(audience, finalPrice)?.display ?? null,
		test: isTest,
	};
}

/**
 * The visitor's formal itemized offer email. Light theme, Outlook-safe tables (mc-web
 * email conventions), accent #D02E7C. Struck list price above the AI-channel price, the
 * claim code in a bordered callout, one CTA: book the intro — the booking locks the price.
 */
export function offerEmailHtml(args: {
	first: string;
	offer: Offer;
	sessions: number;
	focus: string[];
	successDef: string;
	listPrice: number;
	finalPrice: number;
	discountPct: number | null;
	freeSessions: number;
	leaders: number;
	effectivePerSession: number;
	isCompany?: boolean;
	vat?: string | null;
	validUntil: string;
	code: string;
	program: Program | null;
}): string {
	const { first, offer, sessions, focus, successDef, listPrice, finalPrice, discountPct, freeSessions, leaders, effectivePerSession, isCompany, vat, validUntil, code, program } = args;
	const offerName = offer.name;
	const d = aiDiscount();
	const accent = "#D02E7C";
	const rowStyle = `padding:8px 0;font-size:14px;line-height:1.6;color:#333;border-bottom:1px solid #eee;`;
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	// The unit — "/ month", "/ quarter", "/ session" — that used to be stripped here, turning
	// a €790/month subscription and a €6,498/quarter retainer into one-off totals in the one
	// document the buyer forwards to finance.
	const unit = offer.unit === "per_month" ? " / month" : offer.unit === "per_quarter" ? " / quarter" : offer.unit === "per_session" ? " / session" : "";

	const headlinePrice = discountPct
		? `<p style="margin:0 0 2px;font-size:15px;color:#888;"><s>${eur(listPrice)}</s> <span style="color:${accent};font-weight:700;">−${discountPct}% AI channel, you save ${eur(listPrice - finalPrice)}</span></p>
     <p style="margin:0 0 6px;font-size:40px;line-height:1.05;font-weight:700;letter-spacing:-0.02em;color:#171717;">${eur(finalPrice)}<span style="font-size:14px;font-weight:500;color:#888;">${unit} excl. VAT</span></p>
     <p style="margin:0 0 24px;font-size:13px;color:#888;">${sessions} sessions, ${sessionsBreakdown(offer)}${leaders > 1 && isPerLeader(offer) ? " per leader" : ""} — ${eur(effectivePerSession)} a session. It is yours because you built the inquiry here, no booking required; the offer holds until the date below.</p>`
		: `<p style="margin:0 0 6px;font-size:40px;line-height:1.05;font-weight:700;letter-spacing:-0.02em;color:#171717;">${eur(finalPrice)}<span style="font-size:14px;font-weight:500;color:#888;">${unit} excl. VAT</span></p>
     <p style="margin:0 0 24px;font-size:13px;color:#888;">${sessions} sessions, ${sessionsBreakdown(offer)} — ${eur(effectivePerSession)} a session. This is the published list price — there is no AI-channel price on ${esc(offerName)}.</p>`;

	const programHtml = program
		? `<tr><td colspan="2" style="padding:18px 0 4px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${accent};">Program skeleton (planning targets)</td></tr>
       ${program.sessions.map((s) => `<tr><td style="${rowStyle}">${s.label}</td><td align="right" style="${rowStyle}white-space:nowrap;">${s.date}</td></tr>`).join("")}`
		: "";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @media only screen and (max-width: 620px) {
    .container { width: 100% !important; }
    .px { padding-left: 20px !important; padding-right: 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#faf7f2;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your offer, item by item. Book the intro to lock it.&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf7f2;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
    <tr><td class="px" style="background-color:#ffffff;border:1px solid #eee;border-radius:16px;padding:36px 44px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${accent};">Offer ${code}</p>
      <h1 style="margin:0 0 18px;font-size:28px;line-height:1.2;font-weight:600;color:#171717;">Here's the offer we agreed, ${first}.</h1>
      <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:#333;">Everything below came out of your own answers — your focus areas, your definition of success, the price we agreed. Marian has the same brief, so the intro call starts from your goals, not a blank page.</p>
      <p style="margin:0 0 2px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${accent};">${offerName}${leaders > 1 ? ` × ${leaders} leaders` : ""}</p>
      ${headlinePrice}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td style="${rowStyle}">Sessions</td><td align="right" style="${rowStyle}">${sessions} × ${offer.program?.session_minutes ?? 60} min${
					leaders > 1
						? isPerLeader(offer)
							? ` (${offer.sessions} per leader × ${leaders} leaders)`
							: ` — a pool shared across ${leaders} leaders, not ${offer.sessions} each`
						: offer.commitment?.sessions_are === "per_month"
							? " per month"
							: ""
				}</td></tr>
        <tr><td style="${rowStyle}">Package</td><td align="right" style="${rowStyle}">${sessionsBreakdown(offer)}${leaders > 1 && isPerLeader(offer) ? " per leader" : ""} · ${eur(offer.per_session ?? offer.price)} per paid session at list</td></tr>
        <tr><td style="${rowStyle}">Rate</td><td align="right" style="${rowStyle}">${eur(effectivePerSession)} / session${freeSessions ? ` (${eur(finalPrice)} ÷ ${sessions + freeSessions} sessions, incl. the ${freeSessions} free proposed)` : ` (${eur(finalPrice)} ÷ ${sessions} sessions)`}</td></tr>
        ${offer.commitment ? `<tr><td style="${rowStyle}">Commitment</td><td align="right" style="${rowStyle}">${esc(offer.commitment.terms)}</td></tr>` : ""}
        <tr><td style="${rowStyle}">Focus</td><td align="right" style="${rowStyle}">${focus.map(esc).join("<br>")}</td></tr>
        <tr><td style="${rowStyle}">Your definition of success</td><td align="right" style="${rowStyle}">${esc(successDef)}</td></tr>
        ${freeSessions ? `<tr><td style="${rowStyle}">B2B concession (proposed)</td><td align="right" style="${rowStyle}white-space:nowrap;">+${freeSessions} free sessions</td></tr>` : ""}
        ${offer.program?.async_access ? `<tr><td style="${rowStyle}">Between sessions</td><td align="right" style="${rowStyle}">Async access (Slack/WhatsApp, fair use)</td></tr>` : ""}
        ${offer.installments && leaders === 1 && discountPct ? `<tr><td style="${rowStyle}">Payment option</td><td align="right" style="${rowStyle}white-space:nowrap;">${offer.installments.count} monthly payments of ${eur(offer.installments.ai_channel_eur)}</td></tr>` : ""}
        <tr><td style="${rowStyle}">Guarantee</td><td align="right" style="${rowStyle}">Any session below 7/10 is free</td></tr>
        <tr><td style="${rowStyle}">If it isn't working</td><td align="right" style="${rowStyle}">${esc(meta.stop_rule)}</td></tr>
        ${programHtml}
      </table>
      <!-- The three things every finance reviewer asked for and none of them found: who
           invoices, what VAT applies, and how long the quote is good for. They were sitting in
           the terms block appended to every tool response and never reached the document. -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:22px;background-color:#faf7f2;border-radius:12px;">
        <tr><td style="padding:16px 18px;font-size:13px;line-height:1.7;color:#555;">
          <strong style="color:#171717;">${leaders > 1 || isCompany ? "For your finance team" : "The paperwork"}</strong><br>
          Invoiced by ${esc(meta.entity)}${leaders > 1 || isCompany ? ", your PO number on the invoice" : ""}.<br>
          ${vat ? esc(vat) : `Prices in ${esc(meta.currency)}, VAT ${esc(meta.vat)}.`}<br>
          This offer is valid until ${validUntil}. Nothing here is a contract; final terms are confirmed on the free intro call.
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:26px;">
        <tr><td style="border:2px solid ${accent};border-radius:12px;padding:18px 22px;">
          <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#171717;">Next step:</p>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#333;">Book your free 30-minute intro call and paste <strong>${code}</strong> into the booking note. ${
						discountPct
							? `The price is already yours and holds until ${validUntil}; the call is where you and Marian check the fit before anything is invoiced.`
							: `There is no discount to lock on ${esc(offerName)} — the call is simply where you and Marian check the fit before anything is invoiced.`
					}${freeSessions ? " Marian confirms the free-sessions proposal on the call." : ""}</p>
          <p style="margin:8px 0 0;font-size:14px;line-height:1.6;color:#333;">Direct link: <a href="${meta.booking_url}" style="color:${accent};">${meta.booking_url}</a></p>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
        <tr><td>
          <a href="${meta.booking_url}" style="display:inline-block;background-color:${accent};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 26px;border-radius:999px;border:1px solid #b02064;">Book the intro call</a>
        </td></tr>
      </table>
      <p style="margin:30px 0 4px;font-size:15px;line-height:1.65;color:#333;">Nothing here is a contract — the intro call is where we both check the fit. If it's not a fit, no hard feelings and no invoice.</p>
      <p style="margin:16px 0 0;font-size:15px;line-height:1.5;color:#171717;font-weight:600;">Marian Kamenistak</p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#888;">3,400+ sessions · 300+ leaders · 9.2/10 across 300+ reviews · <a href="https://www.marian.coach/?ref=offer-email" style="color:${accent};">marian.coach</a></p>
    </td></tr>
    <tr><td align="center" style="padding:24px 20px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <p style="margin:0;font-size:12px;line-height:1.6;color:#888;">You got this because you built a mentoring inquiry through marian.coach's AI wizard. One more thing, free either way: the <a href="https://www.engineeringleaders.io/partner/membership/free/?ref=offer-email" style="color:${accent};">Engineering Leaders Community</a> Marian founded — meetups, Slack with 3,100+ leaders, newsletter.</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}
