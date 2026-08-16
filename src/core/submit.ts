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
 * Claim code: AI16-<YYMMDD>-<8 hex> where hex = first 8 of
 * HMAC-SHA256(CLAIM_SECRET, lower(email)|offer_id|YYMMDD|channel). Verifiable at
 * /mcp/mentoring/api/verify without any datastore — the Attio entry is primary evidence,
 * the HMAC is the independent audit trail.
 */
import { type Attribution, firstTouchValues, refreshableValues, laneFromCampaign } from "./attribution";
import {
	aiDiscount,
	clampConcession,
	discountFor,
	eur,
	focusAreaById,
	meta,
	motivationById,
	offerById,
	offers,
	roleBandById,
	routing,
	slotsOpen,
	visibilityById,
} from "./catalog";
import { buildProgram, renderProgram, type Program } from "./program";

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
			finalPrice: number;
			discountPct: number | null;
			freeSessions: number;
			test: boolean;
	  }
	| { ok: false; error: string };

function splitName(full: string): { first: string; last: string } {
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
	return `AI16-${ymd}-${hex.toUpperCase()}`;
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
	const leaders = audience === "company" ? Math.max(1, Math.min(50, input.leaders_count ?? 1)) : 1;
	const multi = offer.id === "first-quarter" ? leaders : 1;
	const discount = discountFor(offer.id, channel);
	const perLeader = discount ? discount.priceAfter : offer.price;
	const listPrice = offer.price * multi;
	const finalPrice = perLeader * multi;
	const freeSessions = clampConcession(audience, leaders, offer.id, input.free_sessions_requested ?? 0);

	const visibility = input.visibility && visibilityById(input.visibility) ? input.visibility : null;

	const now = new Date();
	const code = await claimCode(env.CLAIM_SECRET, email, offer.id, channel, now);
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
				`List price: ${eur(listPrice)}${multi > 1 ? ` (${leaders} leaders × ${eur(offer.price)})` : ""} excl. VAT`,
				`AI-channel price (-${discount.pct}%, intro booked): ${eur(finalPrice)} excl. VAT`,
			]
		: [`Price: ${eur(finalPrice)} excl. VAT`];
	if (freeSessions > 0) priceLines.push(`B2B concession proposed: +${freeSessions} free sessions (Marian confirms on the intro call)`);

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

	const slackPrice = discount ? `~${eur(listPrice)}~ → *${eur(finalPrice)}* (AI channel, -${discount.pct}%)` : `*${eur(finalPrice)}*`;
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

						// Attribution from the mc_attr cookie (chat channel only — MCP clients have no cookie).
						// First touch is written once; click ids, the GA client id and last touch describe THIS
						// conversion and are refreshed every time.
						const hasFirst = Array.isArray(personRec?.data?.values?.first_touch_source) && personRec.data.values.first_touch_source.length > 0;
						const attrValues = input.attribution
							? { ...(hasFirst ? {} : firstTouchValues(input.attribution)), ...refreshableValues(input.attribution) }
							: {};
						if (Object.keys(attrValues).length) {
							await fetch(`https://api.attio.com/v2/objects/people/records/${personId}`, {
								method: "PATCH", headers,
								body: JSON.stringify({ data: { values: attrValues } }),
							}).catch((e) => console.error("attio attribution patch exception", String(e)));
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
								await fetch(`https://api.attio.com/v2/objects/people/records/${personId}`, {
									method: "PATCH",
									headers,
									body: JSON.stringify({
										data: { values: { company: [{ target_object: "companies", target_record_id: companyId }] } },
									}),
								}).catch((e) => console.error("attio person-company link exception", String(e)));
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
							free_sessions: String(freeSessions),
							leaders_count: String(leaders),
							claim_code: code,
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
							await fetch(`https://api.attio.com/v2/lists/${PIPELINE_LIST_SLUG}/entries/${pipe.entry_id}`, { method: "PATCH", headers, body: JSON.stringify({ data: { entry_values: pipeVals } }) })
								.catch((e) => console.error("attio pipeline update exception", String(e)));
						} else {
							await fetch(`https://api.attio.com/v2/lists/${PIPELINE_LIST_SLUG}/entries`, {
								method: "POST",
								headers,
								body: JSON.stringify({ data: { parent_record_id: personId, parent_object: "people", entry_values: { stage: "Lead", added_via: "AI wizard", source: channel, ...pipeVals } } }),
							}).catch((e) => console.error("attio pipeline create exception", String(e)));
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
						offerName: offer.name,
						sessions: offer.sessions ?? 1,
						focus: focus.map((f) => f!.label),
						successDef,
						listPrice,
						finalPrice,
						discountPct: discount?.pct ?? null,
						freeSessions,
						leaders,
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
	return { ok: true, offerName: offer.name, claimCode: code, listPrice, finalPrice, discountPct: discount?.pct ?? null, freeSessions, test: isTest };
}

/**
 * The visitor's formal itemized offer email. Light theme, Outlook-safe tables (mc-web
 * email conventions), accent #D02E7C. Struck list price above the AI-channel price, the
 * claim code in a bordered callout, one CTA: book the intro — the booking locks the price.
 */
function offerEmailHtml(args: {
	first: string;
	offerName: string;
	sessions: number;
	focus: string[];
	successDef: string;
	listPrice: number;
	finalPrice: number;
	discountPct: number | null;
	freeSessions: number;
	leaders: number;
	code: string;
	program: Program | null;
}): string {
	const { first, offerName, sessions, focus, successDef, listPrice, finalPrice, discountPct, freeSessions, leaders, code, program } = args;
	const open = slotsOpen();
	const d = aiDiscount();
	const accent = "#D02E7C";
	const rowStyle = `padding:8px 0;font-size:14px;line-height:1.6;color:#333;border-bottom:1px solid #eee;`;

	const headlinePrice = discountPct
		? `<p style="margin:0 0 2px;font-size:15px;color:#888;"><s>${eur(listPrice)}</s> <span style="color:${accent};font-weight:700;">−${discountPct}% AI channel</span></p>
     <p style="margin:0 0 6px;font-size:40px;line-height:1.05;font-weight:700;letter-spacing:-0.02em;color:#171717;">${eur(finalPrice)}<span style="font-size:14px;font-weight:500;color:#888;"> excl. VAT</span></p>
     <p style="margin:0 0 24px;font-size:13px;color:#888;">The ${discountPct}% holds once your free intro call is booked. This price goes to the first ${meta.slots.claim_cap} people${open > 0 ? `, and ${open} of those places are still open` : ""}.</p>`
		: `<p style="margin:0 0 24px;font-size:40px;line-height:1.05;font-weight:700;letter-spacing:-0.02em;color:#171717;">${eur(finalPrice)}<span style="font-size:14px;font-weight:500;color:#888;"> excl. VAT</span></p>`;

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
        <tr><td style="${rowStyle}">Sessions</td><td align="right" style="${rowStyle}white-space:nowrap;">${sessions * leaders} × 60 min${leaders > 1 ? ` (${sessions} per leader)` : ""}</td></tr>
        <tr><td style="${rowStyle}">Focus</td><td align="right" style="${rowStyle}">${focus.join("<br>")}</td></tr>
        <tr><td style="${rowStyle}">Your definition of success</td><td align="right" style="${rowStyle}">${successDef.replace(/</g, "&lt;")}</td></tr>
        ${freeSessions ? `<tr><td style="${rowStyle}">B2B concession (proposed)</td><td align="right" style="${rowStyle}white-space:nowrap;">+${freeSessions} free sessions</td></tr>` : ""}
        <tr><td style="${rowStyle}">Guarantee</td><td align="right" style="${rowStyle}">Any session below 7/10 is free</td></tr>
        ${programHtml}
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:26px;">
        <tr><td style="border:2px solid ${accent};border-radius:12px;padding:18px 22px;">
          <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#171717;">Next step — this locks the price:</p>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#333;">Book your free 30-minute intro call and paste <strong>${code}</strong> into the booking note. ${discountPct ? `The ${discountPct}% AI-channel price holds while the open slots last.` : ""}${freeSessions ? " Marian confirms the free-sessions proposal on the call." : ""}</p>
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
        <tr><td>
          <a href="${meta.booking_url}" style="display:inline-block;background-color:${accent};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 26px;border-radius:999px;border:1px solid #b02064;">Book the intro call</a>
        </td></tr>
      </table>
      <p style="margin:30px 0 4px;font-size:15px;line-height:1.65;color:#333;">Nothing here is a contract — the intro call is where we both check the fit. If it's not a fit, no hard feelings and no invoice.</p>
      <p style="margin:16px 0 0;font-size:15px;line-height:1.5;color:#171717;font-weight:600;">Marian Kamenistak</p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#888;">${(d && `3,400+ sessions · 300+ leaders · 9.2/10 avg`) ?? ""} · <a href="https://www.marian.coach/?ref=offer-email" style="color:${accent};">marian.coach</a></p>
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
