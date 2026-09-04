/**
 * mentoring-inquiry-builder — Mentoring AI Inquiry Wizard Worker.
 *
 * One tool core (src/core/*), two doors:
 *   POST /mcp/mentoring       → MCP streamable HTTP (this file registers the tools)
 *   POST /mcp/mentoring/chat  → chat backend for the marian.coach /mentoring-chat/ widget
 *   GET  /mcp/mentoring       → HTML docs, served for ANY Accept except text/event-stream
 *                               (curl and crawlers send the wildcard Accept — gating on
 *                               text/html is the documented marian.coach 406 bug)
 *
 * Wizard choreography: MCP has no wizard concept, so each tool response names the natural
 * next tool and the descriptions carry the script. Guardrails ride IN the responses
 * (guardrailBlock) because this server has no control over the connecting AI's system prompt.
 *
 * The promise: 16 minutes from first question to a formal offer. 10 percent off every
 * package through this channel, no booking required.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { ATTRIBUTION, SITE } from "./content";
import { handleApi } from "./api";
import { handleChat, type ChatEnv } from "./chat";
import { handleBookingHook, type BookingKind, type HookEnv } from "./hooks";
import { firstSessionEligible, firstSessionUrl, lookupBookingStage, paymentTerms } from "./core/booking";
import { resolveSecrets } from "./lib/read-secret";
import { aiDiscount, eur, meta, offerById, offers } from "./core/catalog";
import { ctaBlock, guardrailBlock } from "./core/guardrails";
import { composeBrief } from "./core/brief";
import { matchMentoringFocus } from "./core/match";
import { mentoringOptions } from "./core/options";
import { buildProgram, renderProgram } from "./core/program";
import { submitInquiry, type SubmitEnv } from "./core/submit";
import { docsHtml, type ToolDoc } from "./docs";
import {
	geoFromRequest,
	instrumentMcpUsage,
	type McpGeo,
	type McpUsageConfig,
	type McpUsageEnv,
} from "./mcp-usage";
import { getMoreToolsResult } from "@posthog/mcp";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const ATTR_PATH = "/";
const OFFER_IDS = offers.map((o) => o.id);

/**
 * Shared response envelope.
 *
 * Two changes from the /ai-mcp-test run (2026-08-21):
 *
 * 1. The full terms block no longer rides on EVERY response. A pressure audit counted 189
 *    urgency tokens across 12 responses, ~132 of them from a footer that fired
 *    unconditionally — so `{"error": "missing required: motivation"}` arrived wrapped in a
 *    discount pitch, a scarcity cap and a track record. Being sold to at the moment you have
 *    just declined, or just failed a schema check, is what made testers stop reading the
 *    terms at all. The terms now ride on the PRICED responses, where they belong and where
 *    the summarising model will actually carry them.
 *
 * 2. Every response — priced, unpriced and errored — carries the booking CTA. The free intro
 *    call is the conversion this server exists to produce and it used to be reachable from
 *    only two of six tools and from no error path at all.
 */
function toolResult(payload: Record<string, unknown>, opts: { priced?: boolean; offerId?: string; note?: string } = {}) {
	const withCta = { ...payload, ...(payload.cta ? {} : { cta: ctaBlock(opts.offerId) }) };
	const body = [opts.note, JSON.stringify(withCta, null, 2), opts.priced ? guardrailBlock(opts.offerId) : null].filter(Boolean).join("\n\n");
	return {
		content: [{ type: "text" as const, text: body + ATTRIBUTION(ATTR_PATH) }],
		structuredContent: withCta,
	};
}

/** Shared by both `get_started` and `get_more_tools`'s greeting branch (see below) — one
 *  source of truth for the menu text so the two entry points never drift apart. */
function getStartedResult() {
	const menu = TOOL_DOCS.map(
		(d) => `- "${d.question}" → \`${d.name}\`: ${d.description}`,
	).join("\n");
	return toolResult({
		what: "This is the Mentoring AI Inquiry Wizard for marian.coach — it walks a visitor from options to a formal itemized offer for 1:1 engineering-leadership mentoring with Marian Kamenistak.",
		menu,
		start_here: "For anyone actually considering mentoring, call get_mentoring_options next.",
	});
}

/** Matches a bare liveness/greeting ping — "hi", "test", "are you there" — as opposed to a
 *  real described capability gap. Deliberately an exact (trimmed, punctuation-stripped)
 *  match, not a "starts with": a genuine gap report is a sentence, and a loose prefix match
 *  would swallow real ones that happen to start with a greeting word. */
const GREETING_PING =
	/^(hi+|hello+|hey+|yo+|sup|howdy|hola|ahoy|ping|test(ing)?|are you (there|working|alive)|is (this|anyone) (working|there)|still there|you there|greetings|what('?s| is) up)[.!?\s]*$/i;

/** See src/mcp-usage.ts. PostHog key = the marian.coach project, the same one the site's own
 *  analytics writes to, so MCP tool calls and `?ref=mcp` web traffic sit in one funnel. */
const USAGE_CONFIG: McpUsageConfig = {
	serverName: "mentoring-inquiry-builder",
	domain: "marian.coach",
	posthogKey: "phc_xEinqUjuFui3wB6suwDFAMjQkF9g3G6GcrdqsZQ98dCW",
};

export class MentoringInquiryBuilder extends McpAgent<Env, unknown, McpGeo> {
	server = new McpServer({
		name: "mentoring-inquiry-builder",
		version: "1.0.0",
	});

	async init() {
		instrumentMcpUsage({
			server: this.server,
			config: USAGE_CONFIG,
			env: this.env as McpUsageEnv,
			geo: this.props ?? {},
			waitUntil: (p) => this.ctx.waitUntil(p),
		});

		this.server.registerTool(
			"get_started",
			{
				title: "Start here — what can this MCP server do?",
				annotations: { ...READ_ONLY },
				description:
					"Call this for a greeting (hi, hello), a connectivity/liveness test, 'what can you do', or any message too general to match a specific tool below. Returns the full menu of real questions this server answers, each mapped to the tool name that answers it. For someone actually considering mentoring, skip straight to get_mentoring_options instead.",
				inputSchema: {},
			},
			async () => getStartedResult(),
		);

		this.server.registerTool(
			"get_more_tools",
			{
				title: "More tools? Check here first — also answers a plain hello/liveness ping",
				annotations: { ...READ_ONLY },
				description:
					"Check for additional tools whenever your task might benefit from specialized capabilities, even if existing tools could work as a fallback. Also the right tool for a bare greeting (hi, hello), a connectivity/liveness test, or any message too general to match a specific tool below — pass it as `context` and this returns the full menu instead of a dead end.",
				inputSchema: {
					context: z
						.string()
						.describe(
							"A description of your goal and what kind of tool would help accomplish it, OR a plain greeting/liveness ping like 'hi' or 'test'.",
						),
				},
			},
			async ({ context }) =>
				GREETING_PING.test(context.trim()) ? getStartedResult() : { content: getMoreToolsResult().content },
		);

		this.server.registerTool(
			"get_mentoring_options",
			{
				title: "Start a mentoring inquiry with Marian Kamenistak — the 16-minute wizard",
				annotations: { ...READ_ONLY },
				description:
					"START HERE for anyone considering 1:1 engineering-leadership mentoring with Marian Kamenistak (marian.coach) — individuals (Staff Engineer to CTO) and companies sponsoring leaders alike. Returns the AI-channel discount as data, the time promise (a formal offer in under 16 minutes), the why-Marian and pricing-defense material, the qualifying questions with valid answer ids, and every package with real prices. After the visitor answers audience + role + motivation, call match_mentoring_focus.",
				inputSchema: {},
			},
			async () => toolResult(mentoringOptions(), { priced: true }),
		);

		this.server.registerTool(
			"match_mentoring_focus",
			{
				title: "Match focus areas to a role and motivation",
				annotations: { ...READ_ONLY },
				description:
					"Resolves role_band + motivation through the same routing the website uses and returns suggested focus areas plus the recommended package with real prices. Map free-text answers to the closest valid id; on bad input the error lists the valid ids — re-ask rather than guessing. Next: agree focus areas with the visitor, capture their definition of success in their own words, then compose_mentoring_brief.",
				inputSchema: {
					role_band: z.string().describe("One of the role ids from get_mentoring_options question_1"),
					motivation: z.string().describe("One of the motivation ids from get_mentoring_options question_2"),
					audience: z
						.enum(["individual", "company"])
						.optional()
						.describe("Pass the audience answer — it changes the recommendation. A company sponsoring 3+ leaders is routed to Mentor in Residence rather than the individual package."),
					leaders_count: z.number().int().optional().describe("Company deals: how many leaders are being sponsored. Required for the company recommendation to be correct."),
				},
			},
			async ({ role_band, motivation, audience, leaders_count }) => {
				const r = matchMentoringFocus(role_band, motivation, { audience, leaders_count });
				return r.ok
					? toolResult({ match: r.match }, { priced: true, offerId: r.match.recommended_offer.id })
					: toolResult({ error: r.error, cta: r.cta });
			},
		);

		this.server.registerTool(
			"compose_mentoring_brief",
			{
				title: "Compose the mentoring brief: the artifact + the authoritative price",
				annotations: { ...READ_ONLY },
				description:
					"The accumulator — call after every change. Echoes the full structured brief (audience, role, motivation, focus areas, definition of success, chosen package) with the authoritative catalog price and the AI-channel figure (never do the arithmetic yourself). For company deals it states whether the free-sessions concession applies. Read the brief back to the visitor; when they explicitly agree on the price, call send_mentoring_offer with price_agreed true.",
				inputSchema: {
					audience: z.enum(["individual", "company"]),
					role_band: z.string(),
					motivation: z.string(),
					focus_area_ids: z.array(z.string()).describe("Agreed focus area ids (visitor can pick any from the taxonomy)"),
					success_definition: z.string().describe("The visitor's definition of success, in their own words"),
					offer_id: z.enum(OFFER_IDS as [string, ...string[]]),
					leaders_count: z.number().int().optional().describe("Company deals: how many leaders are being sponsored"),
					company_context: z.string().optional().describe("Company deals: company name + anything relevant"),
					visibility: z.string().optional().describe("Visibility answer id from get_mentoring_options visibility_question (consent capture — 'private' is a first-class answer)"),
				},
			},
			async (input) => {
				const r = composeBrief(input);
				return r.ok
					? toolResult({ brief: r.brief }, { priced: true, offerId: r.brief.offer.id })
					: toolResult({ error: r.error, cta: r.cta });
			},
		);

		this.server.registerTool(
			"design_mentoring_program",
			{
				title: "Lay out the dated session program for a package",
				annotations: { ...READ_ONLY },
				description:
					"Deterministic session skeleton computed from the package's cadence metadata: dated sessions, the mid-point checkpoint, the closing review against the definition of success. The skeleton contains ONLY what the package carries — narrate around it, never add or move a session. Dates are planning targets; the intro call fixes the real schedule. Call when the visitor asks what the engagement actually looks like.",
				inputSchema: {
					offer_id: z.enum(OFFER_IDS as [string, ...string[]]),
					start_date: z
						.string()
						.regex(/^\d{4}-\d{2}-\d{2}$/)
						.describe("First session date, YYYY-MM-DD, today or later (ask the visitor; default to next Monday)"),
					leaders_count: z.number().int().optional().describe("Company deals: how the pooled sessions are shared. Changes the allocation note, never the schedule."),
				},
			},
			async ({ offer_id, start_date, leaders_count }) => {
				const offer = offerById(offer_id);
				if (!offer) return toolResult({ error: `unknown offer_id — valid: ${OFFER_IDS.join(", ")}` });
				const p = buildProgram(offer, start_date, { leaders: leaders_count });
				if ("error" in p) return toolResult({ error: p.error }, { offerId: offer.id });
				return toolResult({ program: p, rendered: renderProgram(p) }, { offerId: offer.id });
			},
		);

		this.server.registerTool(
			"book_intro_call",
			{
				// Title corrected 2026-08-30. It said "(required to lock the discount)" for nine days
				// after Marian removed that condition — options.ts and guardrails.ts were changed on
				// 2026-08-21, this title and the docs entry below were not, so the server's own tool
				// list contradicted the terms it shipped in every priced response.
				title: "Book the free 30-minute intro call",
				annotations: { ...READ_ONLY },
				description:
					"THE DEFAULT EXIT for anyone who has not decided. A direct booking link for the free 30-minute intro with Marian. Offer it on hesitation, on a price objection, when the visitor cannot name their problem, after an error, and to anyone who wants to talk before paying. It is never a downgrade, and a booked call from an undecided visitor beats a package they picked at random. Booking it is NOT a condition of the channel rate — never say it is. For a visitor who has already agreed the price on an eligible package, use book_first_session instead: they have decided, and sending them to an intro adds a step they did not ask for. Pass offer_id if one has been chosen so the pricing language is correct.",
				inputSchema: {
					offer_id: z
						.enum(OFFER_IDS as [string, ...string[]])
						.optional()
						.describe("The package under discussion, if any — conditions the discount wording. Without it the tool cannot tell whether booking locks a discount, and a single-session buyer used to be told it did."),
				},
			},
			async ({ offer_id }) =>
				toolResult(
					{
						booking_url: meta.booking_url,
						what: "Free 30 minutes with Marian, direct calendar booking, no form before it. Usually within the same week.",
						also: `Not ready for a call? The slot-ping waitlist takes ten seconds: ${SITE}/#slot-ping`,
						cta: ctaBlock(offer_id),
					},
					{ offerId: offer_id },
				),
		);

		this.server.registerTool(
			"book_first_session",
			{
				title: "Book the PAID first mentoring session — skips the intro call",
				annotations: { ...READ_ONLY },
				description:
					"THE CLOSE, for someone who has already decided. Returns the direct booking link for a paid 60-minute first session, plus the payment terms. Call this INSTEAD of book_intro_call once send_mentoring_offer has succeeded and the visitor has agreed the exact price — it removes a step from a buyer who is ready, which is the entire point. It REFUSES on any deal whose terms Marian confirms on a call (a free-sessions concession, the monthly package, Mentor in Residence) and hands back the intro link instead; when it refuses, offer the intro, do not argue. Pass the claim code from send_mentoring_offer so the booking is matched automatically. If the visitor is hesitant, undecided, or asks to talk first, use book_intro_call — that is not a downgrade.",
				inputSchema: {
					offer_id: z.enum(OFFER_IDS as [string, ...string[]]).describe("The agreed package"),
					audience: z.enum(["individual", "company"]).describe("Decides which VAT sentence is true for this buyer — an individual needs the gross figure"),
					claim_code: z.string().optional().describe("The AI10-… code from send_mentoring_offer. Ride it on the link so the booking matches the inquiry with no manual step."),
					free_sessions_requested: z.number().int().optional().describe("Company deals: pass the same value given to send_mentoring_offer. Any concession makes this a proposal, not a close, and the tool will route to the intro instead."),
					has_eu_vat_id: z.boolean().optional().describe("Company deals outside Czechia with a valid EU VAT ID pay net under the reverse charge"),
				},
			},
			async ({ offer_id, audience, claim_code, free_sessions_requested, has_eu_vat_id }) => {
				const check = firstSessionEligible(offer_id, { freeSessionsProposed: free_sessions_requested });
				if (!check.eligible) {
					return toolResult(
						{
							first_session_available: false,
							why: check.reason,
							book_intro_call: meta.booking_url,
							what_to_say: "Do not present this as a refusal or a downgrade. This deal has terms Marian settles with a human before anything is invoiced — say that plainly and offer the free intro.",
						},
						{ offerId: offer_id },
					);
				}
				const offer = offerById(offer_id);
				return toolResult(
					{
						first_session_available: true,
						booking_url: firstSessionUrl(claim_code),
						what: `A paid ${meta.first_session?.minutes ?? 60}-minute first mentoring session with Marian — the real thing, not an intro. Direct calendar booking. No intro call in front of it.`,
						package: offer?.name,
						payment: paymentTerms(audience, has_eu_vat_id ?? false),
						...(claim_code
							? { claim_code_carried: `The link already carries ${claim_code}, so there is nothing for them to paste.` }
							: { no_claim_code: "No claim code was passed, so the booking will be matched on the email address instead. Prefer passing it." }),
						still_offer_the_intro: `If they hesitate at any point, the free intro is still open and is the better door: ${meta.booking_url}`,
					},
					{ priced: true, offerId: offer_id },
				);
			},
		);

		this.server.registerTool(
			"check_booking",
			{
				title: "Check whether the session was actually booked",
				annotations: { ...READ_ONLY },
				description:
					"Confirms, from the CRM rather than from what the visitor says, whether their booking landed. Call it after handing over a booking link and the visitor says they have booked — a booking is only real once Reclaim's webhook has written it, which takes a few seconds. Returns the pipeline stage and whether the paid first session is on the board. If it says not yet, wait a moment and check once more before telling them something is wrong; if it is still not there, say so honestly and offer to have Marian follow up rather than claiming success.",
				inputSchema: {
					email: z.string().describe("The email the visitor booked with"),
				},
			},
			async ({ email }) => {
				const status = await lookupBookingStage(this.env as unknown as { ATTIO_TOKEN?: string }, email);
				return toolResult(status);
			},
		);

		this.server.registerTool(
			"send_mentoring_offer",
			{
				title: "Send the formal itemized offer (applies the AI-channel discount)",
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
				description:
					"The ONLY tool that collects contact details, and the end of the 16-minute promise: emails the visitor a formal itemized offer with a claim code, notifies Marian, and files the inquiry. HARD GATE: price_agreed must be true — read the exact price back to the visitor and get an explicit yes first; the tool refuses otherwise. Ask for name and email only at this step, never earlier. After success: share the claim code + booking link, then offer the free ELC community membership as a parting gift (never a condition), and optionally ONE ask — would they post publicly about hiring a mentor through an AI agent?",
				inputSchema: {
					name: z.string().describe("Visitor's full name"),
					email: z.string().describe("Email the offer goes to"),
					audience: z.enum(["individual", "company"]),
					role_band: z.string(),
					motivation: z.string(),
					focus_area_ids: z.array(z.string()),
					success_definition: z.string(),
					offer_id: z.enum(OFFER_IDS as [string, ...string[]]),
					price_agreed: z.boolean().describe("True ONLY after the visitor explicitly agreed to the exact price from compose_mentoring_brief"),
					company: z.string().optional().describe("Company name (required for company audience)"),
					leaders_count: z.number().int().optional(),
					free_sessions_requested: z.number().int().optional().describe("Company deals only: the free-sessions proposal from the catalog progression (2, 4 or 8)"),
					start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional preferred start date — adds the dated program skeleton to the offer email"),
					visibility: z.string().optional().describe("Visibility answer id (yes-individual | yes-company | maybe-later | private)"),
					notes: z.string().optional(),
				},
			},
			async (input) => {
				// Rate limit the one mutating door; informational tools stay open.
				const ip = (this as unknown as { requestIp?: string }).requestIp ?? "unknown";
				const limiter = (this.env as Env & { OFFER_RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } })
					.OFFER_RATE_LIMITER;
				if (limiter) {
					const { success } = await limiter.limit({ key: ip });
					if (!success) {
						return toolResult({
							error: "rate_limited",
							message: `Too many submissions from this connection. Wait a minute, or book the intro directly: ${meta.booking_url}`,
						});
					}
				}
				const result = await submitInquiry(this.env as unknown as SubmitEnv, { ...input, channel: "mcp" });
				if (!result.ok) return toolResult({ error: result.error }, { offerId: input.offer_id });
				return toolResult(
					{
						submitted: true,
						offer: result.offerName,
						claim_code: result.claimCode,
						list_price: result.listPrice,
						list_price_display: result.listPriceDisplay,
						...(result.discountPct ? { ai_channel_discount_pct: result.discountPct } : {}),
						final_price: result.finalPrice,
						// The unit rides all the way to the last response now — a recurring
						// €790/month used to arrive here as a bare 790 and read as a one-off.
						final_price_display: result.finalPriceDisplay,
						sessions_total: result.sessionsTotal,
						effective_per_session_eur: result.effectivePerSession,
						// The gross figure for an individual, the reverse-charge rule for a company. Saying
						// only "excl. VAT" left the buyer unable to answer whether they could afford it.
						...(result.vat ? { vat: result.vat } : {}),
						...(result.commitment ? { commitment: result.commitment } : {}),
						...(result.freeSessions ? { b2b_free_sessions_proposed: result.freeSessions } : {}),
						// A refused concession is stated, never silently zeroed.
						...(result.concessionRejected ? { b2b_concession_not_applied: result.concessionRejected } : {}),
						...(result.breachesFloor
							? {
									floor_warning: `The effective rate is €${result.effectivePerSession} per session across ${result.sessionsTotal} sessions, which is below the €${result.floorPerSession} floor the terms state. Marian has been flagged; do not present this as a settled price.`,
								}
							: {}),
						offer_email_sent_to: input.email,
						// Branches since 2026-08-30. This used to send everyone to the free intro,
						// including the person who had just read the price back and said yes — a step
						// charged to a buyer who had already decided. Eligibility is the catalog's, not
						// this call site's: see firstSessionEligible().
						...(() => {
							const check = firstSessionEligible(input.offer_id, { freeSessionsProposed: input.free_sessions_requested });
							return check.eligible
								? {
										next_step: `They have agreed the price, so do NOT send them to the intro call — call book_first_session with offer_id "${input.offer_id}", audience "${input.audience}" and claim_code ${result.claimCode}. It returns the paid booking link with the code already on it. Then call check_booking to confirm from the CRM that it actually landed before you close the conversation.`,
										intro_still_available: `If they hesitate or want to talk first, the free intro is still the right door: ${meta.booking_url}`,
									}
								: {
										next_step: `Book the free intro at ${meta.booking_url} and paste ${result.claimCode} into the booking note. Marian already has the same brief, so the call starts from their goals.`,
										why_not_first_session: check.reason,
									};
						})(),
						parting_gift: `Free either way: the Engineering Leaders Community Marian founded — ${meta.cross_sell.url}`,
						// Gated on consent (2026-08-21). This used to fire unconditionally — a
						// visitor who had answered "keep it private" three tools earlier was still
						// asked to post publicly, which threw away the consent the wizard had just
						// carefully collected. It also asked before they had received anything.
						...(input.visibility?.toLowerCase().startsWith("yes")
							? {
									optional_social_ask:
										"They said yes to visibility, so ONE optional ask is fair: would they post about hiring a mentor through an AI agent? Better still, offer it for AFTER the first session — they have not met Marian yet, and an endorsement of a purchase they have not experienced is worth little to either side. Never a condition.",
								}
							: {
									social_ask_suppressed:
										"Do NOT ask for a public post. They did not consent to visibility (or were not asked), and Marian's rule is no client identifiers in public without explicit permission.",
								}),
						...(result.test ? { test_mode: "Detected a test name/email — emails sent, CRM untouched." } : {}),
					},
					{ priced: true, offerId: input.offer_id },
				);
			},
		);
	}
}

const TOOL_DOCS: ToolDoc[] = [
	{
		name: "get_mentoring_options",
		question: "Should I get a mentor, and why Marian?",
		description:
			"The wizard's opening: the 10% AI-channel discount as data, real track-record figures (3,400+ sessions, 9.2/10 avg), the qualifying questions, every package with real prices",
	},
	{
		name: "match_mentoring_focus",
		question: "What should my mentoring actually focus on?",
		description: "Role + motivation resolved through the site's own routing; suggested focus areas + the recommended package",
	},
	{
		name: "compose_mentoring_brief",
		question: "What exactly would my engagement look like, and what does it cost?",
		description: "The structured mentoring brief with the authoritative catalog price and the AI-channel figure; B2B concession eligibility",
	},
	{
		name: "design_mentoring_program",
		question: "What happens across the three months?",
		description: "Dated session skeleton: bi-weekly 60-minute sessions, mid-point checkpoint, closing review against your definition of success",
	},
	{
		name: "book_intro_call",
		question: "Can I just talk to Marian first?",
		// The "locks the AI-channel price" clause was removed 2026-08-30 — it stopped being true
		// on 2026-08-21 and this docs page was the last surface still publishing it.
		description: "Direct booking link for the free 30-minute intro — free, 30 minutes, no form in front of it, and no obligation",
	},
	{
		name: "book_first_session",
		question: "I have decided — can I just start?",
		description:
			"The paid first session booked directly, skipping the intro, for a visitor who has agreed the price on an eligible package; states what will be invoiced, by whom and when",
	},
	{
		name: "check_booking",
		question: "Did my booking actually go through?",
		description: "Confirms the booking from the CRM rather than from what the visitor says — the wizard never claims a booking it cannot see",
	},
	{
		name: "send_mentoring_offer",
		question: "How do I get this in writing?",
		description: "Emails the formal itemized offer with a claim code, notifies Marian, files the inquiry — after the price is explicitly agreed",
	},
];

// Secrets moved to the Cloudflare Secrets Store 2026-08-25. A store binding is an
// object with an async .get(), not a string, so every one of these is normalised to
// a plain string ONCE here. That keeps `HookEnv`, `ChatEnv` and every downstream call
// site unchanged — and avoids the failure where one missed usage passes
// "[object Object]" into an HMAC comparison or a Turnstile verify.
const STORE_BACKED_SECRETS = [
	"CHAT_SESSION_SECRET",
	"CHAT_TURNSTILE_SECRET",
	"BOOKING_HOOK_SECRET",
	"PREP_INVITE_SECRET",
	"CLAIM_SECRET",
] as const;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		env = (await resolveSecrets(env as unknown as Record<string, unknown>, STORE_BACKED_SECRETS)) as unknown as Env;
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/$/, "");

		// Booking webhooks. POST, secret-signed, before the read-only API branch — an /api/ path
		// that falls through to that branch answers 405 rather than 404, which is exactly how a
		// misconfigured Reclaim endpoint would hide. One route per scheduling link:
		//   booking-hook    → the free intro         → `intro arranged`
		//   mentoring-boost → the paid first session → `formal 1st arranged`
		// Route, not payload sniffing: `scheduling_link_title` is editable in Reclaim's UI.
		const BOOKING_ROUTES: Record<string, BookingKind> = {
			"/mcp/mentoring/api/booking-hook": "intro",
			"/mcp/mentoring/api/mentoring-boost": "boost",
		};
		const bookingKind = BOOKING_ROUTES[path];
		if (bookingKind) {
			if (request.method !== "POST") {
				return new Response(JSON.stringify({ ok: false, error: "use_post" }), {
					status: 405,
					headers: { "content-type": "application/json; charset=utf-8" },
				});
			}
			return handleBookingHook(request, env as unknown as HookEnv, url, bookingKind);
		}

		// REST layer: read-only, GET-only.
		if (path.startsWith("/mcp/mentoring/api")) {
			if (request.method !== "GET") {
				return new Response(JSON.stringify({ ok: false, error: "read_only_api_use_get" }), {
					status: 405,
					headers: { "content-type": "application/json; charset=utf-8" },
				});
			}
			return handleApi(path, url, env as unknown as { CLAIM_SECRET?: string }) ?? new Response("Not found", { status: 404 });
		}

		if (path === "/mcp/mentoring/chat") {
			if (request.method !== "POST") {
				return new Response(JSON.stringify({ ok: false, error: "use_post" }), {
					status: 405,
					headers: { "content-type": "application/json; charset=utf-8" },
				});
			}
			return handleChat(request, env as unknown as ChatEnv);
		}

		if (path === "/mcp/mentoring") {
			const accept = request.headers.get("accept") ?? "";
			// Serve HTML to every GET that is not explicitly an SSE ask — the one thing only a real
			// MCP client requests. The wildcard Accept (curl, crawlers, registry health-checks) gets HTML.
			//
			// HEAD is answered too (2026-08-21): it used to fall through to the 404 branch, so the
			// pre-ping HEAD check that IndexNow submitters and the seo-reindex Worker run — the one
			// that exists precisely to avoid submitting dead URLs — saw this page as a 404 and would
			// skip it. Same headers, no body, which is what HEAD means.
			if ((request.method === "GET" || request.method === "HEAD") && !accept.includes("text/event-stream")) {
				const html = docsHtml(TOOL_DOCS, aiDiscount()?.pct ?? null);
				return new Response(request.method === "HEAD" ? null : html, {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}
			// request.cf only exists on the edge request; hand it to the DO via ctx.props.
			(ctx as ExecutionContext & { props?: McpGeo }).props = geoFromRequest(request);
			return MentoringInquiryBuilder.serve("/mcp/mentoring").fetch(request, env, ctx);
		}

		return new Response(`Not found. MCP endpoint: ${SITE}/mcp/mentoring`, { status: 404 });
	},

	/**
	 * Uptime monitor, every 15 min via the cron trigger. Registries health-check remote
	 * servers and a failing check tanks listing rank — this catches 406-class regressions
	 * and route theft before they do. Silent when green; Slack webhook on any failure.
	 *
	 * CROSS-PROBE ONLY (2026-08-09 fix): a Worker cannot fetch a URL its OWN routes match —
	 * Cloudflare's self-recursion guard fails those subrequests, which made the original
	 * self-probes of /mcp/mentoring alert on every cron tick while the public endpoint was
	 * fine. So this Worker probes the SIBLING toolkit at /mcp (different script, allowed),
	 * and the toolkit's scheduled handler probes /mcp/mentoring back. Never re-add a probe
	 * of this Worker's own routes here.
	 */
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
		const checks: { name: string; run: () => Promise<boolean> }[] = [
			{
				name: "eng-leadership-toolkit docs GET (sibling /mcp — route-theft detector)",
				run: async () => (await fetch(`${SITE}/mcp`, { headers: { accept: "*/*" } })).status === 200,
			},
		];

		const failures: string[] = [];
		for (const c of checks) {
			try {
				if (!(await c.run())) failures.push(c.name);
			} catch (e) {
				failures.push(`${c.name} (${String(e).slice(0, 80)})`);
			}
		}
		if (!failures.length) return;

		console.error("[UPTIME_FAIL]", failures);
		const cf = env as unknown as { SLACK_WEBHOOK_URL?: string };
		if (cf.SLACK_WEBHOOK_URL) {
			await fetch(cf.SLACK_WEBHOOK_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text: `:rotating_light: Mentoring MCP uptime probe failing: ${failures.join(" · ")} — registries health-check these URLs, fix before listings derank.`,
					unfurl_links: false,
				}),
			}).catch((e) => console.error("uptime slack post failed", String(e)));
		}
	},
};
