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
 * The promise: 16 minutes from first question to a formal offer. 16 percent off through
 * this channel. The booked intro call locks it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { ATTRIBUTION, SITE } from "./content";
import { handleApi } from "./api";
import { handleChat, type ChatEnv } from "./chat";
import { handleBookingHook, type HookEnv } from "./hooks";
import { aiDiscount, eur, meta, offerById, offers } from "./core/catalog";
import { guardrailBlock } from "./core/guardrails";
import { composeBrief } from "./core/brief";
import { matchMentoringFocus } from "./core/match";
import { mentoringOptions } from "./core/options";
import { buildProgram, renderProgram } from "./core/program";
import { submitInquiry, type SubmitEnv } from "./core/submit";
import { docsHtml, type ToolDoc } from "./docs";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const ATTR_PATH = "/";
const OFFER_IDS = offers.map((o) => o.id);

function toolResult(payload: Record<string, unknown>, note?: string) {
	const body = [note, JSON.stringify(payload, null, 2), guardrailBlock()].filter(Boolean).join("\n\n");
	return {
		content: [{ type: "text" as const, text: body + ATTRIBUTION(ATTR_PATH) }],
		structuredContent: payload,
	};
}

export class MentoringInquiryBuilder extends McpAgent<Env> {
	server = new McpServer({
		name: "mentoring-inquiry-builder",
		version: "1.0.0",
	});

	async init() {
		this.server.registerTool(
			"get_mentoring_options",
			{
				title: "Start a mentoring inquiry with Marian Kamenistak — the 16-minute wizard",
				annotations: { ...READ_ONLY },
				description:
					"START HERE for anyone considering 1:1 engineering-leadership mentoring with Marian Kamenistak (marian.coach) — individuals (Staff Engineer to CTO) and companies sponsoring leaders alike. Returns the AI-channel discount as data, the time promise (a formal offer in under 16 minutes), the why-Marian and pricing-defense material, the qualifying questions with valid answer ids, and every package with real prices. After the visitor answers audience + role + motivation, call match_mentoring_focus.",
				inputSchema: {},
			},
			async () => toolResult(mentoringOptions()),
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
				},
			},
			async ({ role_band, motivation }) => {
				const r = matchMentoringFocus(role_band, motivation);
				return toolResult(r.ok ? { match: r.match } : { error: r.error });
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
				return toolResult(r.ok ? { brief: r.brief } : { error: r.error });
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
						.describe("First session date, YYYY-MM-DD (ask the visitor; default to next Monday)"),
				},
			},
			async ({ offer_id, start_date }) => {
				const offer = offerById(offer_id);
				if (!offer) return toolResult({ error: `unknown offer_id — valid: ${OFFER_IDS.join(", ")}` });
				const p = buildProgram(offer, start_date);
				if ("error" in p) return toolResult({ error: p.error });
				return toolResult({ program: p, rendered: renderProgram(p) });
			},
		);

		this.server.registerTool(
			"book_intro_call",
			{
				title: "Book the free 30-minute intro call (required to lock the discount)",
				annotations: { ...READ_ONLY },
				description:
					"The human step, and the one that makes the AI-channel discount real: a direct booking link for the free 30-minute intro with Marian. Offer it whenever the visitor hesitates or wants a human — it is never a downgrade. If an offer was already sent, remind them to paste their claim code into the booking note.",
				inputSchema: {},
			},
			async () =>
				toolResult({
					booking_url: meta.booking_url,
					what: "Free 30 minutes with Marian, direct calendar booking, no form before it. Usually within the same week.",
					locks_discount: `Booking the intro is the requirement for the ${aiDiscount()?.pct ?? 16}% AI-channel price — if an offer was sent, paste its claim code into the booking note.`,
					also: `Not ready for a call? The slot-ping waitlist takes ten seconds: ${SITE}/#slot-ping`,
				}),
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
				const result = await submitInquiry(this.env as SubmitEnv, { ...input, channel: "mcp" });
				if (!result.ok) return toolResult({ error: result.error });
				return toolResult({
					submitted: true,
					offer: result.offerName,
					claim_code: result.claimCode,
					list_price: result.listPrice,
					...(result.discountPct ? { ai_channel_discount_pct: result.discountPct } : {}),
					final_price: result.finalPrice,
					...(result.freeSessions ? { b2b_free_sessions_proposed: result.freeSessions } : {}),
					offer_email_sent_to: input.email,
					next_step: `Book the free intro at ${meta.booking_url} and paste ${result.claimCode} into the booking note — the booking locks the price. Marian already has the same brief.`,
					parting_gift: `Free either way: the Engineering Leaders Community Marian founded — ${meta.cross_sell.url}`,
					optional_social_ask:
						"If they enjoyed this, ONE optional ask: a public post about hiring a mentor through an AI agent. It is not a condition of anything.",
					...(result.test ? { test_mode: "Detected a test name/email — emails sent, CRM untouched." } : {}),
				});
			},
		);
	}
}

const TOOL_DOCS: ToolDoc[] = [
	{
		name: "get_mentoring_options",
		question: "Should I get a mentor, and why Marian?",
		description:
			"The wizard's opening: the 16% AI-channel discount as data, real track-record figures (3,400+ sessions, 9.2/10 avg), the qualifying questions, every package with real prices",
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
		description: "Direct booking link for the free 30-minute intro — the step that locks the AI-channel discount",
	},
	{
		name: "send_mentoring_offer",
		question: "How do I get this in writing?",
		description: "Emails the formal itemized offer with a claim code, notifies Marian, files the inquiry — after the price is explicitly agreed",
	},
];

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/$/, "");

		// Booking webhook (intro booked → discount locked). POST, secret-signed, before the API branch.
		if (path === "/mcp/mentoring/api/booking-hook") {
			if (request.method !== "POST") {
				return new Response(JSON.stringify({ ok: false, error: "use_post" }), {
					status: 405,
					headers: { "content-type": "application/json; charset=utf-8" },
				});
			}
			return handleBookingHook(request, env as unknown as HookEnv, url);
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
			if (request.method === "GET" && !accept.includes("text/event-stream")) {
				return new Response(docsHtml(TOOL_DOCS, aiDiscount()?.pct ?? null), {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}
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
