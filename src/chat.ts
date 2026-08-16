/**
 * Chat backend for the marian.coach /mentoring-chat/ widget — the second door over the same
 * tool core. Ported from the ELC partnership-builder chat.ts (session/Turnstile/agent-loop
 * machinery verbatim); prompt, tools and side events swapped for mentoring.
 *
 * POST /mcp/mentoring/chat
 *   body: { messages: [{role, content}...], turnstile_token?, session_token? }
 *   out:  SSE stream of JSON events:
 *     {type:"session", token}          minted after Turnstile verifies on the first message
 *     {type:"text", delta}             assistant text, streamed
 *     {type:"brief", ...}              structured brief after compose/submit — drives the live side card
 *     {type:"program", sessions}       after design_mentoring_program
 *     {type:"suggestions", chips:[]}   quick replies so non-typers never have to type
 *     {type:"submitted", ...}          offer sent (widget fires confetti on this)
 *     {type:"done"} | {type:"error", message}
 *
 * Stateless server: the client re-sends messages; caps 40 messages / 4k chars / last 30 kept.
 * Turnstile solves once, then an HMAC session token (~2h) covers the conversation.
 * CHAT_ENABLED kill switch: anything but "false" is on.
 */
import { parseAttributionCookie, type Attribution } from "./core/attribution";
import { eur, meta, offerById, offers } from "./core/catalog";
import { guardrailBlock } from "./core/guardrails";
import { composeBrief } from "./core/brief";
import { matchMentoringFocus } from "./core/match";
import { mentoringOptions } from "./core/options";
import { buildProgram, renderProgram } from "./core/program";
import { submitInquiry, type SubmitEnv } from "./core/submit";

export type ChatEnv = SubmitEnv & {
	ANTHROPIC_API_KEY?: string;
	CHAT_SESSION_SECRET?: string;
	CHAT_TURNSTILE_SECRET?: string;
	CHAT_MODEL?: string;
	CHAT_ENABLED?: string;
	CHAT_RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
};

const MAX_MESSAGES = 40;
const MAX_CHARS = 4000;
const KEEP_LAST = 30;
const MAX_TOOL_ITERATIONS = 5;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const OFFER_IDS = offers.map((o) => o.id);
const BOOKING = meta.booking_url;

// ── session token: hex(exp).hex(hmac-sha256(exp)) ────────────────────────────────────────────
async function hmac(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function mintSession(secret: string, now: number): Promise<string> {
	const exp = String(now + SESSION_TTL_MS);
	return `${exp}.${await hmac(secret, exp)}`;
}
export async function verifySession(secret: string, token: string, now: number): Promise<boolean> {
	const [exp, sig] = token.split(".");
	if (!exp || !sig) return false;
	if (Number(exp) < now) return false;
	return (await hmac(secret, exp)) === sig;
}

// ── the wizard's system prompt. Voice rules applied: reader's problem first, no absolutes,
// no invented numbers — figures ride in from the tools, not from here. ────────────────────────
const SYSTEM_PROMPT = `You are Marian Kamenistak's Mentoring Inquiry Builder — the conversational door to 1:1 engineering-leadership mentoring at marian.coach. You talk to engineering and product leaders (Staff Engineer to CTO) considering a mentor for themselves, and to companies sponsoring their leaders. Your promise, stated early and as a ceiling: no more than 16 minutes from here to a formal itemized offer in their inbox. This is also the only path to the 16% AI-channel price, and that price goes to the first 5 people who claim it. State the cap plainly, once, with no urgency theatre — it is a term, not a countdown. Keep the conversation moving so the 16 minutes is yours to keep.

How to run the conversation:
1. Start from their situation, in their words. Call get_mentoring_options early — it carries the discount data, the qualifying questions, the why-Marian material and every package price. Ask one question at a time: whether this is for themselves or company-sponsored, their role, what brings them to mentoring now. Get their first name early and use it.
2. Match with match_mentoring_focus, then agree the focus areas — they can swap any from the taxonomy. Capture their definition of success in THEIR words; push until it is concrete enough that a closing review could score it.
3. Compose the brief with compose_mentoring_brief after every change. Every number you say comes from a tool response. If you have not called the tool, you do not have the number.
4. When they ask what the engagement looks like, show the dated skeleton: design_mentoring_program.
5. "Why Marian and not another mentor?" — argue from the why_marian data: the track record, the 7+/10-or-free guarantee, the operator background. Deploy the point that answers their objection, not the whole list.
6. "How do I get my company to pay?" is the most common real blocker — 78% of mentees are company-sponsored. Answer it, and hand over the tool that does it properly: ${BOOKING.replace(/\/meet$/, "")}/get-your-company-to-pay-for-mentoring/ builds the ROI math, a manager one-pager and a forwardable approval email from their answers, in EN or CZ. Do NOT do that arithmetic in the chat. You have no ROI tool here, so any payback multiple or attrition figure you produce is invented, and inventing one on the channel that promises the AI cannot invent a number is the worst trade available to you.
7. Price pushback gets the pricing_defense material: ROI, market comparison, risk reversal. There is exactly one discount (the 16% AI channel, intro booked) and, for companies sponsoring 3+ leaders or Mentor-in-Residence, exactly one concession (free sessions, from the catalog progression, always "Marian confirms on the call"). Individuals get a friendly, confident no: the rate is the rate — the same one companies pay.
8. During the practicalities, ask the visibility question from get_mentoring_options: would they want to make the cooperation visible — build their personal brand alongside the mentoring, or announce it as a company story? Frame it as investing in their strengths, never as a condition. "Keep it private" is a first-class answer and changes nothing about the offer.
9. Before sending: read the exact price back and get an explicit yes. Then collect name and email — not earlier — and call send_mentoring_offer with price_agreed true. After success: give them the claim code, tell them to book the free intro at ${BOOKING} and paste the code in the booking note (that locks the price), offer the free Engineering Leaders Community membership as a parting gift, and make ONE optional ask about posting publicly. Optional means optional.
10. Every conversation ends on one of three doors: the offer, the intro call (offer it on any hesitation — it is never a downgrade), or the slot-ping waitlist for anyone not ready. Never let a warm visitor leave with nothing.

Tone: direct, specific, tech-community register — Marian's own style. Short answers, one question at a time. No corporate filler, no exclamation-mark enthusiasm. It is fine to say mentoring is not the right tool: someone who wants a course gets pointed to the free community; someone in crisis therapy territory gets told honestly this is not that.

Money: tool responses carry fixed prices. You have no authority to change prices or invent terms. Prices exclude VAT. Marian confirms all final terms on the free intro call.

Never fabricate statistics, mentee names, or outcomes. The tools carry every number that exists.`;

// ── tool definitions for the Anthropic API ───────────────────────────────────────────────────
const TOOLS = [
	{
		name: "get_mentoring_options",
		description: "The wizard's opening: AI-channel discount data, the 16-minute promise, qualifying questions with valid ids, why-Marian and pricing-defense material, every package with real prices. Call this first.",
		input_schema: { type: "object" as const, properties: {}, required: [] },
	},
	{
		name: "match_mentoring_focus",
		description: "Resolve role_band + motivation through the routing matrix. Returns suggested focus areas + the recommended package with prices.",
		input_schema: {
			type: "object" as const,
			properties: {
				role_band: { type: "string", description: "role id from get_mentoring_options" },
				motivation: { type: "string", description: "motivation id from get_mentoring_options" },
			},
			required: ["role_band", "motivation"],
		},
	},
	{
		name: "compose_mentoring_brief",
		description: "The accumulator: echoes the full brief with the authoritative price. Call after every change, and always before proposing the final price.",
		input_schema: {
			type: "object" as const,
			properties: {
				audience: { type: "string", enum: ["individual", "company"] },
				role_band: { type: "string" },
				motivation: { type: "string" },
				focus_area_ids: { type: "array", items: { type: "string" } },
				success_definition: { type: "string" },
				offer_id: { type: "string", enum: OFFER_IDS },
				leaders_count: { type: "integer" },
				company_context: { type: "string" },
				visibility: { type: "string", enum: ["yes-individual", "yes-company", "maybe-later", "private"] },
			},
			required: ["audience", "role_band", "motivation", "focus_area_ids", "success_definition", "offer_id"],
		},
	},
	{
		name: "design_mentoring_program",
		description: "Deterministic dated session skeleton for a package: bi-weekly sessions, mid-point checkpoint, closing review. Only contains what the package carries.",
		input_schema: {
			type: "object" as const,
			properties: {
				offer_id: { type: "string", enum: OFFER_IDS },
				start_date: { type: "string", description: "YYYY-MM-DD" },
			},
			required: ["offer_id", "start_date"],
		},
	},
	{
		name: "book_intro_call",
		description: "The human step that also locks the discount: direct booking link for the free 30-minute intro with Marian. Offer on hesitation.",
		input_schema: { type: "object" as const, properties: {}, required: [] },
	},
	{
		name: "send_mentoring_offer",
		description: "Send the formal itemized offer with the AI-channel discount and a claim code. HARD GATE: price_agreed must be true after an explicit yes to the exact price. The only tool that takes contact details.",
		input_schema: {
			type: "object" as const,
			properties: {
				name: { type: "string" },
				email: { type: "string" },
				audience: { type: "string", enum: ["individual", "company"] },
				role_band: { type: "string" },
				motivation: { type: "string" },
				focus_area_ids: { type: "array", items: { type: "string" } },
				success_definition: { type: "string" },
				offer_id: { type: "string", enum: OFFER_IDS },
				price_agreed: { type: "boolean" },
				company: { type: "string" },
				leaders_count: { type: "integer" },
				free_sessions_requested: { type: "integer" },
				start_date: { type: "string" },
				visibility: { type: "string", enum: ["yes-individual", "yes-company", "maybe-later", "private"] },
				notes: { type: "string" },
			},
			required: ["name", "email", "audience", "role_band", "motivation", "focus_area_ids", "success_definition", "offer_id", "price_agreed"],
		},
	},
];

type SideEvent = Record<string, unknown>;

async function runTool(env: ChatEnv, name: string, input: any, side: SideEvent[], attribution?: Attribution): Promise<unknown> {
	switch (name) {
		case "get_mentoring_options": {
			const o = mentoringOptions();
			side.push({
				type: "suggestions",
				chips: ["I just became a manager", "I'm an EM and I'm stuck", "We're scaling fast", "My company wants to sponsor leaders", "Why Marian?"],
			});
			return o;
		}
		case "match_mentoring_focus": {
			const r = matchMentoringFocus(String(input.role_band ?? ""), String(input.motivation ?? ""));
			if (r.ok) {
				side.push({ type: "suggestions", chips: ["Those focus areas fit", "Let me adjust the focus", "What does it cost?", "Why Marian?"] });
			}
			return r;
		}
		case "compose_mentoring_brief": {
			const r = composeBrief({
				audience: input.audience === "company" ? "company" : "individual",
				role_band: String(input.role_band ?? ""),
				motivation: String(input.motivation ?? ""),
				focus_area_ids: Array.isArray(input.focus_area_ids) ? input.focus_area_ids.map(String) : [],
				success_definition: String(input.success_definition ?? ""),
				offer_id: String(input.offer_id ?? ""),
				leaders_count: typeof input.leaders_count === "number" ? input.leaders_count : undefined,
				company_context: input.company_context ? String(input.company_context) : undefined,
			});
			if (r.ok) {
				const b = r.brief;
				side.push({
					type: "brief",
					audience: b.audience,
					focus: b.focus_areas.map((f) => f.label),
					success: b.success_definition,
					offer: b.offer.name,
					offer_id: b.offer.id,
					list_price: b.offer.list_price,
					discounted: b.offer.ai_channel_price?.total ?? null,
					pct: b.offer.ai_channel_price?.pct ?? null,
					free_sessions: (b as any).b2b_concession_available?.max_free_sessions ?? null,
				});
				side.push({ type: "suggestions", chips: ["Show me the dated program", "That price works", "Why is it worth it?", "Talk to Marian first"] });
			}
			return r;
		}
		case "design_mentoring_program": {
			const offer = offerById(String(input.offer_id ?? ""));
			if (!offer) return { error: `unknown offer_id — valid: ${OFFER_IDS.join(", ")}` };
			const p = buildProgram(offer, String(input.start_date ?? ""));
			if ("error" in p) return p;
			side.push({ type: "program", sessions: p.sessions, async_access: p.asyncAccess });
			side.push({ type: "suggestions", chips: ["That works, send the offer", "Different start date", "Talk to Marian first"] });
			return { program: p, rendered: renderProgram(p) };
		}
		case "book_intro_call": {
			side.push({ type: "suggestions", chips: ["Book the intro call", "Back to the offer", "Ping me when a slot opens"] });
			return {
				booking_url: BOOKING,
				what: "Free 30 minutes with Marian, direct calendar booking, usually within the same week.",
				locks_discount: "Booking the intro is the requirement for the AI-channel price — paste the claim code into the booking note if an offer was sent.",
				also: "Not ready for a call? The slot-ping waitlist: https://www.marian.coach/#slot-ping",
			};
		}
		case "send_mentoring_offer": {
			const r = await submitInquiry(env, {
				name: String(input.name ?? ""),
				email: String(input.email ?? ""),
				audience: input.audience === "company" ? "company" : "individual",
				role_band: String(input.role_band ?? ""),
				motivation: String(input.motivation ?? ""),
				focus_area_ids: Array.isArray(input.focus_area_ids) ? input.focus_area_ids.map(String) : [],
				success_definition: String(input.success_definition ?? ""),
				offer_id: String(input.offer_id ?? ""),
				price_agreed: input.price_agreed === true,
				company: input.company ? String(input.company) : undefined,
				leaders_count: typeof input.leaders_count === "number" ? input.leaders_count : undefined,
				free_sessions_requested: typeof input.free_sessions_requested === "number" ? input.free_sessions_requested : undefined,
				start_date: input.start_date ? String(input.start_date) : undefined,
				notes: input.notes ? String(input.notes) : undefined,
				channel: "chat",
				attribution,
			});
			if (r.ok) {
				side.push({
					type: "submitted",
					offer: r.offerName,
					claim_code: r.claimCode,
					list_price: r.listPrice,
					final_price: r.finalPrice,
					pct: r.discountPct,
					free_sessions: r.freeSessions,
					test: r.test,
				});
				side.push({ type: "suggestions", chips: ["Book the intro call now", "What happens next?"] });
			}
			return r;
		}
		default:
			return { error: `unknown tool ${name}` };
	}
}

export async function handleChat(request: Request, env: ChatEnv): Promise<Response> {
	const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
	const headers = {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive",
	};
	const fail = (message: string, status = 400) =>
		new Response(sse({ type: "error", message }) + sse({ type: "done" }), { status, headers });

	if ((env.CHAT_ENABLED ?? "true") === "false") {
		return fail(`The chat is asleep right now. Book the free intro instead: ${BOOKING}`, 503);
	}
	if (!env.ANTHROPIC_API_KEY) return fail("chat_not_configured", 503);

	let body: any;
	try {
		body = await request.json();
	} catch {
		return fail("invalid_json");
	}

	const attribution = parseAttributionCookie(request.headers.get("cookie")) ?? undefined;

	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	if (env.CHAT_RATE_LIMITER) {
		const { success } = await env.CHAT_RATE_LIMITER.limit({ key: ip });
		if (!success) return fail("Too many messages too fast. Give it a minute.", 429);
	}

	// ── session gate: Turnstile once, HMAC token after ────────────────────────────────────────
	const now = Date.now();
	const secret = env.CHAT_SESSION_SECRET;
	let sessionEvent: string | null = null;
	if (secret) {
		const hasValidSession = typeof body.session_token === "string" && (await verifySession(secret, body.session_token, now));
		if (!hasValidSession) {
			if (env.CHAT_TURNSTILE_SECRET) {
				const token = String(body.turnstile_token ?? "");
				try {
					const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({ secret: env.CHAT_TURNSTILE_SECRET, response: token, remoteip: ip }),
					});
					const verify: any = await res.json().catch(() => ({ success: false }));
					if (!verify.success) return fail("spam_check_failed", 403);
				} catch (e) {
					// Fail-open on our own network hiccup — same posture as the ELC forms.
					console.error("turnstile exception", String(e));
				}
			}
			sessionEvent = sse({ type: "session", token: await mintSession(secret, now) });
		}
	}

	// ── input caps ────────────────────────────────────────────────────────────────────────────
	let messages: { role: "user" | "assistant"; content: any }[] = Array.isArray(body.messages) ? body.messages : [];
	if (!messages.length) return fail("empty_messages");
	if (messages.length > MAX_MESSAGES) return fail(`This conversation is long enough — book the free intro: ${BOOKING}`);
	messages = messages.slice(-KEEP_LAST).map((m) => ({
		role: m.role === "assistant" ? "assistant" : "user",
		content: typeof m.content === "string" ? m.content.slice(0, MAX_CHARS) : m.content,
	}));

	const model = env.CHAT_MODEL ?? "claude-sonnet-5";
	const stream = new ReadableStream({
		async start(controller) {
			const emit = (o: unknown) => controller.enqueue(new TextEncoder().encode(sse(o)));
			if (sessionEvent) controller.enqueue(new TextEncoder().encode(sessionEvent));
			try {
				let iterations = 0;
				// Manual agent loop: stream each model turn; on tool_use, run the tool, feed the
				// result back, continue until an end_turn or the iteration cap.
				while (iterations < MAX_TOOL_ITERATIONS) {
					iterations++;
					const res = await fetch("https://api.anthropic.com/v1/messages", {
						method: "POST",
						headers: {
							"x-api-key": env.ANTHROPIC_API_KEY!,
							"anthropic-version": "2023-06-01",
							"content-type": "application/json",
						},
						body: JSON.stringify({
							model,
							max_tokens: 1500,
							system: [{ type: "text", text: SYSTEM_PROMPT + "\n\n" + guardrailBlock(), cache_control: { type: "ephemeral" } }],
							tools: TOOLS,
							messages,
							stream: true,
						}),
					});
					if (!res.ok || !res.body) {
						const errText = await res.text().catch(() => "");
						console.error("anthropic error", res.status, errText.slice(0, 300));
						emit({ type: "error", message: "The assistant hiccuped. Say that again?" });
						break;
					}

					// Parse the Anthropic SSE stream: accumulate text + tool_use blocks.
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let buf = "";
					let stopReason: string | null = null;
					const contentBlocks: any[] = [];
					let currentTool: { id: string; name: string; json: string } | null = null;
					let textAcc = "";

					const processLine = (line: string) => {
						if (!line.startsWith("data: ")) return;
						let ev: any;
						try {
							ev = JSON.parse(line.slice(6));
						} catch {
							return;
						}
						if (ev.type === "content_block_start") {
							if (ev.content_block?.type === "tool_use") {
								currentTool = { id: ev.content_block.id, name: ev.content_block.name, json: "" };
							}
						} else if (ev.type === "content_block_delta") {
							if (ev.delta?.type === "text_delta") {
								textAcc += ev.delta.text;
								emit({ type: "text", delta: ev.delta.text });
							} else if (ev.delta?.type === "input_json_delta" && currentTool) {
								currentTool.json += ev.delta.partial_json;
							}
						} else if (ev.type === "content_block_stop") {
							if (currentTool) {
								contentBlocks.push({ type: "tool_use", id: currentTool.id, name: currentTool.name, input: currentTool.json ? JSON.parse(currentTool.json) : {} });
								currentTool = null;
							} else if (textAcc) {
								contentBlocks.push({ type: "text", text: textAcc });
								textAcc = "";
							}
						} else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
							stopReason = ev.delta.stop_reason;
						}
					};

					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						buf += decoder.decode(value, { stream: true });
						let nl;
						while ((nl = buf.indexOf("\n")) >= 0) {
							processLine(buf.slice(0, nl).trim());
							buf = buf.slice(nl + 1);
						}
					}
					if (textAcc) contentBlocks.push({ type: "text", text: textAcc });

					const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
					if (stopReason !== "tool_use" || !toolUses.length) break;

					messages = [...messages, { role: "assistant", content: contentBlocks }];
					const results: any[] = [];
					for (const tu of toolUses) {
						const side: SideEvent[] = [];
						const out = await runTool(env, tu.name, tu.input ?? {}, side, attribution);
						for (const s of side) emit(s);
						results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
					}
					messages = [...messages, { role: "user", content: results }];
				}
				emit({ type: "done" });
			} catch (e) {
				console.error("chat exception", String(e));
				emit({ type: "error", message: "Something broke mid-thought. Try again." });
				emit({ type: "done" });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, { headers });
}
