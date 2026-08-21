/**
 * Persona-test harness (/ai-mcp-test). Black-box CLI over the SAME core modules the
 * deployed MCP tools call — src/core/*, src/content.ts — wrapped in the SAME response
 * envelope src/index.ts uses (guardrail block + attribution footer), so a tester sees
 * byte-for-byte what an MCP client sees.
 *
 * send_mentoring_offer runs the REAL submitInquiry with an empty env: every side effect
 * (Attio, Resend, Slack) is gated on a credential that is absent here, so validation and
 * server-side pricing are exercised in full and nothing leaves the machine. The rendered
 * offer email is returned as text so the ending is testable too.
 *
 *   npx vite-node scripts/tool.ts -- list
 *   npx vite-node scripts/tool.ts -- get_mentoring_options '{}'
 */
import { ATTRIBUTION } from "../src/content";
import { claimCap, focusAreaById, meta, offerById, offers } from "../src/core/catalog";
import { ctaBlock, guardrailBlock } from "../src/core/guardrails";
import { composeBrief } from "../src/core/brief";
import { matchMentoringFocus } from "../src/core/match";
import { mentoringOptions } from "../src/core/options";
import { buildProgram, renderProgram } from "../src/core/program";
import { submitInquiry, offerEmailHtml, type SubmitEnv } from "../src/core/submit";
import { SITE } from "../src/content";

const OFFER_IDS = offers.map((o) => o.id);

/** Mirrors src/index.ts toolResult() exactly, including the priced/unpriced terms split. */
function toolResult(payload: Record<string, unknown>, opts: { priced?: boolean; offerId?: string } = {}): string {
	const withCta = { ...payload, ...(payload.cta ? {} : { cta: ctaBlock(opts.offerId) }) };
	const body = [JSON.stringify(withCta, null, 2), opts.priced ? guardrailBlock() : null].filter(Boolean).join("\n\n");
	return body + ATTRIBUTION("/");
}

/** Crude HTML -> text so a tester can read the offer email without a browser. */
function htmlToText(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<head[\s\S]*?<\/head>/gi, "")
		.replace(/<s>([\s\S]*?)<\/s>/gi, "$1 (struck through)")
		// Emit the href in parentheses, not angle brackets — the generic tag-stripper below
		// would otherwise eat <https://…> as if it were a tag and the preview would show a
		// link-less CTA that the real email does not have.
		.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ( $1 )")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(tr|p|h1|table|div)>/gi, "\n")
		.replace(/<\/td>/gi, " | ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;|&zwnj;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join("\n");
}

const TOOLS: Record<string, (a: any) => Promise<string>> = {
	async get_mentoring_options() {
		return toolResult(mentoringOptions(), { priced: true });
	},

	async match_mentoring_focus(a) {
		if (typeof a?.role_band !== "string" || typeof a?.motivation !== "string") {
			return toolResult({ error: "match_mentoring_focus requires role_band and motivation (strings)" });
		}
		const r = matchMentoringFocus(a.role_band, a.motivation, { audience: a.audience, leaders_count: a.leaders_count });
		return r.ok
			? toolResult({ match: r.match }, { priced: true, offerId: r.match.recommended_offer.id })
			: toolResult({ error: r.error, cta: r.cta });
	},

	async compose_mentoring_brief(a) {
		const required = ["audience", "role_band", "motivation", "focus_area_ids", "success_definition", "offer_id"];
		const missing = required.filter((k) => a?.[k] === undefined);
		if (missing.length) return toolResult({ error: `missing required: ${missing.join(", ")}` });
		if (!["individual", "company"].includes(a.audience)) return toolResult({ error: `audience must be individual|company` });
		if (!OFFER_IDS.includes(a.offer_id)) return toolResult({ error: `offer_id must be one of: ${OFFER_IDS.join(", ")}` });
		if (!Array.isArray(a.focus_area_ids)) return toolResult({ error: "focus_area_ids must be an array" });
		const r = composeBrief(a);
		return r.ok
			? toolResult({ brief: r.brief }, { priced: true, offerId: r.brief.offer.id })
			: toolResult({ error: r.error, cta: r.cta });
	},

	async design_mentoring_program(a) {
		if (!OFFER_IDS.includes(a?.offer_id)) return toolResult({ error: `offer_id must be one of: ${OFFER_IDS.join(", ")}` });
		if (typeof a?.start_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.start_date)) {
			return toolResult({ error: "start_date must be YYYY-MM-DD" });
		}
		const offer = offerById(a.offer_id)!;
		const p = buildProgram(offer, a.start_date, { leaders: a.leaders_count });
		if ("error" in p) return toolResult({ error: p.error }, { offerId: offer.id });
		return toolResult({ program: p, rendered: renderProgram(p) }, { offerId: offer.id });
	},

	async book_intro_call(a) {
		return toolResult(
			{
				booking_url: meta.booking_url,
				what: "Free 30 minutes with Marian, direct calendar booking, no form before it. Usually within the same week.",
				also: `Not ready for a call? The slot-ping waitlist takes ten seconds: ${SITE}/#slot-ping`,
				cta: ctaBlock(a?.offer_id),
			},
			{ offerId: a?.offer_id },
		);
	},

	async send_mentoring_offer(a) {
		const required = ["name", "email", "audience", "role_band", "motivation", "focus_area_ids", "success_definition", "offer_id", "price_agreed"];
		const missing = required.filter((k) => a?.[k] === undefined);
		if (missing.length) return toolResult({ error: `missing required: ${missing.join(", ")}` });
		if (!OFFER_IDS.includes(a.offer_id)) return toolResult({ error: `offer_id must be one of: ${OFFER_IDS.join(", ")}` });
		if (typeof a.price_agreed !== "boolean") return toolResult({ error: "price_agreed must be a boolean" });

		// Empty env: submitInquiry's Attio / Resend / Slack branches are all credential-gated,
		// so this exercises the real validation + real pricing and performs no side effect.
		const env: SubmitEnv = {};
		const result = await submitInquiry(env, { ...a, channel: "mcp" });
		if (!result.ok) return toolResult({ error: result.error }, { offerId: a.offer_id });

		const offer = offerById(a.offer_id)!;
		const leaders = a.audience === "company" ? Math.max(1, Math.min(50, a.leaders_count ?? 1)) : 1;
		const program = a.start_date ? buildProgram(offer, a.start_date, { leaders }) : null;
		const emailPreview = htmlToText(
			offerEmailHtml({
				first: String(a.name).trim().split(/\s+/)[0] ?? "",
				offer,
				sessions: result.sessionsTotal,
				focus: (a.focus_area_ids as string[]).map((id) => focusAreaById(id)?.label ?? id),
				successDef: a.success_definition,
				listPrice: result.listPrice,
				finalPrice: result.finalPrice,
				discountPct: result.discountPct,
				freeSessions: result.freeSessions,
				leaders,
				effectivePerSession: result.effectivePerSession,
				validUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
				code: result.claimCode,
				program: program && !("error" in program) ? program : null,
			}),
		);

		return toolResult({
			submitted: true,
			offer: result.offerName,
			claim_code: result.claimCode,
			list_price: result.listPrice,
			list_price_display: result.listPriceDisplay,
			...(result.discountPct ? { ai_channel_discount_pct: result.discountPct } : {}),
			final_price: result.finalPrice,
			final_price_display: result.finalPriceDisplay,
			sessions_total: result.sessionsTotal,
			effective_per_session_eur: result.effectivePerSession,
			// The gross figure for an individual, the reverse-charge rule for a company. Saying
			// only "excl. VAT" left the buyer unable to answer whether they could afford it.
			...(result.vat ? { vat: result.vat } : {}),
			...(result.commitment ? { commitment: result.commitment } : {}),
			...(result.freeSessions ? { b2b_free_sessions_proposed: result.freeSessions } : {}),
			...(result.concessionRejected ? { b2b_concession_not_applied: result.concessionRejected } : {}),
			...(result.breachesFloor ? { floor_warning: `Effective ${result.effectivePerSession}/session across ${result.sessionsTotal} sessions is BELOW the stated ${result.floorPerSession} floor.` } : {}),
			offer_email_sent_to: a.email,
			next_step: `Book the free intro at ${meta.booking_url} and paste ${result.claimCode} into the booking note — the booking locks the price. Marian already has the same brief.`,
			parting_gift: `Free either way: the Engineering Leaders Community Marian founded — ${meta.cross_sell.url}`,
			// Mirrors src/index.ts: the ask is gated on the visibility consent answer.
			...(String(a.visibility ?? "").toLowerCase().startsWith("yes")
				? {
						optional_social_ask:
							"They said yes to visibility, so ONE optional ask is fair: would they post about hiring a mentor through an AI agent? Better still, offer it for AFTER the first session. Never a condition.",
					}
				: {
						social_ask_suppressed:
							"Do NOT ask for a public post. They did not consent to visibility (or were not asked), and Marian's rule is no client identifiers in public without explicit permission.",
					}),
			...(a.visibility ? { visibility_recorded: a.visibility } : {}),
			...(result.test ? { test_mode: "Detected a test name/email — emails sent, CRM untouched." } : {}),
			HARNESS_NOTE: "TEST HARNESS — no email was sent, no CRM was written. Below is the exact offer email this would have delivered.",
			offer_email_preview: emailPreview,
		}, { priced: true, offerId: a.offer_id });
	},
};

async function main() {
	const [, , rawName, rawArgs] = process.argv;
	const name = rawName ?? "list";
	if (name === "list" || name === "--help" || name === "-h") {
		console.log(
			[
				"Mentoring inquiry wizard — available tools:",
				"",
				...Object.keys(TOOLS).map((t) => `  ${t}`),
				"",
				`Usage: npx vite-node scripts/tool.ts -- <tool_name> '<json args>'`,
				`Start with: get_mentoring_options`,
				"",
				`Discount cap: first ${claimCap()} people.`,
			].join("\n"),
		);
		return;
	}
	const tool = TOOLS[name];
	if (!tool) {
		console.log(`Unknown tool "${name}". Valid: ${Object.keys(TOOLS).join(", ")}`);
		process.exitCode = 1;
		return;
	}
	let args: any = {};
	if (rawArgs && rawArgs.trim()) {
		try {
			args = JSON.parse(rawArgs);
		} catch (e) {
			console.log(`Could not parse the JSON arguments: ${String(e)}`);
			process.exitCode = 1;
			return;
		}
	}
	console.log(await tool(args));
}

main();
