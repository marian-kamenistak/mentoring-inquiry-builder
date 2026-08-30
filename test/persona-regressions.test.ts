/**
 * Regression tests for the /ai-mcp-test persona run, 2026-08-21.
 *
 * Ten black-box testers went through the wizard in character. Every defect below was found by
 * more than one of them independently, and none of them were visible in the 35-test suite that
 * was green at the time — they are all "confident, plausible, wrong" failures rather than
 * crashes. Each test names the persona finding it locks down.
 */
import { describe, expect, it } from "vitest";
import {
	clampConcession,
	effectiveRate,
	focusAreaById,
	focusAreas,
	aiDiscount,
	discountFor,
	doorRate,
	eur,
	floorPerSession,
	listRate,
	matchFocus,
	motivations,
	multiLeaderError,
	offerById,
	offers,
	priceDisplay,
	roleBandById,
	routing,
	sessionsDelivered,
	visibilityById,
} from "../src/core/catalog";
import { composeBrief } from "../src/core/brief";
import { matchMentoringFocus } from "../src/core/match";
import { mentoringOptions } from "../src/core/options";
import { buildProgram } from "../src/core/program";
import { offerEmailHtml, submitInquiry } from "../src/core/submit";
import { ctaBlock, guardrailLines } from "../src/core/guardrails";

const BASE = {
	audience: "individual" as const,
	role_band: "em",
	motivation: "stuck-plateau",
	focus_area_ids: ["delivery-performance"],
	success_definition: "stop firefighting every week",
};

describe("CTA: every response can convert a lead into a booked call (Marian, 2026-08-21)", () => {
	it("options, match, brief and errors all carry the booking URL", () => {
		const url = ctaBlock().book_intro_call;
		expect(url).toContain("marian.coach");

		// Success payloads carry the CTA through the response envelope (src/index.ts adds
		// ctaBlock once, and only once — it used to appear nested AND at top level, which a
		// tester counted as duplication). Options and the brief also name the call inline.
		expect(JSON.stringify(mentoringOptions())).toContain(url);

		const b = composeBrief({ ...BASE, offer_id: "first-quarter" });
		expect(b.ok).toBe(true);
		if (b.ok) expect(JSON.stringify(b.brief.cta)).toContain(url);

		// The path a tester quit on: an error used to offer no way out at all.
		const bad = matchMentoringFocus("em", "i-dont-know");
		expect(bad.ok).toBe(false);
		expect(JSON.stringify(bad)).toContain(url);

		const badBrief = composeBrief({ ...BASE, offer_id: "first-quarter", focus_area_ids: [] });
		expect(badBrief.ok).toBe(false);
		expect(JSON.stringify(badBrief)).toContain(url);
	});

	it("names the right discount for the package on the table", () => {
		// Tomáš (single session) and Sofia (monthly) were both told that booking "locks the 16%"
		// on packages that carried none. Since 2026-08-30 every package carries the same 10%, so
		// the line names THAT package's AI-door price — and the per-package branch is retained
		// so it stays true if `applies_to` ever narrows again.
		for (const o of offers) {
			expect(ctaBlock(o.id).locks_discount).toContain(eur(o.ai_channel_price!));
			expect(ctaBlock(o.id).locks_discount!.toLowerCase()).toContain("no booking");
		}
	});
});

describe("unit integrity: recurring SKUs must not read as one-off totals (Sofia, Ravi, Petra, Jonas)", () => {
	it("price display carries the unit for every package", () => {
		expect(priceDisplay(offerById("monthly")!, 790)).toBe("€790 / month, excl. VAT");
		expect(priceDisplay(offerById("mentor-in-residence")!, 5925)).toBe("€5,925 / quarter, excl. VAT");
		expect(priceDisplay(offerById("single-session")!, 395)).toBe("€395 / session, excl. VAT");
		expect(priceDisplay(offerById("first-quarter")!, 1975)).toBe("€1,975, excl. VAT");
	});

	it("the brief and the offer email both keep the unit and the commitment", () => {
		const b = composeBrief({ ...BASE, offer_id: "monthly" });
		expect(b.ok).toBe(true);
		if (!b.ok) return;
		expect(b.brief.offer.list_price_display).toContain("/ month");
		expect(b.brief.offer.commitment).toContain("Minimum 3 months");

		const html = offerEmailHtml({
			first: "Sofia",
			offer: offerById("monthly")!,
			sessions: 2,
			focus: ["Delivery, estimates and team performance"],
			successDef: "a sparring partner",
			listPrice: 790,
			finalPrice: 790,
			discountPct: null,
			freeSessions: 0,
			leaders: 1,
			effectivePerSession: 395,
			validUntil: "2026-09-20",
			code: "MC-260821-AAAAAAAA",
			program: null,
		});
		expect(html).toContain("/ month");
		expect(html).toContain("Minimum 3 months");
	});
});

describe("multi-leader arithmetic (Jonas, Lena, Ravi, Petra)", () => {
	it("a pooled SKU never multiplies its sessions by the leader count", () => {
		// The worst artifact the system could produce: an itemized offer promising 72 sessions
		// (or 900, at 50 leaders) for a flat €6,498 — €90/session against a €361 floor.
		const mir = offerById("mentor-in-residence")!;
		expect(sessionsDelivered(mir, 1)).toBe(18);
		expect(sessionsDelivered(mir, 5)).toBe(18);
		expect(sessionsDelivered(mir, 50)).toBe(18);
	});

	it("a per-leader SKU multiplies both price and sessions", () => {
		const fq = offerById("first-quarter")!;
		expect(sessionsDelivered(fq, 5)).toBe(30);
		const b = composeBrief({ ...BASE, audience: "company", offer_id: "first-quarter", leaders_count: 5 });
		expect(b.ok).toBe(true);
		if (!b.ok) return;
		expect(b.brief.offer.list_price).toBe(5 * fq.price);
	});

	it("the MiR price label never claims a multiplication it did not perform", () => {
		// It used to read "€6,498 (5 leaders × €6,498)" — and totalled €6,498.
		const b = composeBrief({ ...BASE, audience: "company", offer_id: "mentor-in-residence", leaders_count: 5 });
		expect(b.ok).toBe(true);
		if (!b.ok) return;
		expect(b.brief.offer.list_price).toBe(offerById("mentor-in-residence")!.price); // flat regardless of leaders
		expect(b.brief.offer.list_price_display).not.toContain("5 leaders ×");
		expect(b.brief.offer.sessions_display).toContain("pool");
	});

	it("SKUs with no multi-leader price REFUSE rather than silently under-billing", () => {
		// 10 leaders used to invoice €430 (single session) and €790 (monthly).
		expect(multiLeaderError(offerById("single-session")!, 10)).toBeTruthy();
		expect(multiLeaderError(offerById("monthly")!, 10)).toBeTruthy();
		expect(multiLeaderError(offerById("first-quarter")!, 10)).toBeNull();
		expect(multiLeaderError(offerById("monthly")!, 1)).toBeNull();

		const b = composeBrief({ ...BASE, audience: "company", offer_id: "monthly", leaders_count: 10 });
		expect(b.ok).toBe(false);
	});

	it("submitInquiry refuses the under-billing case too", async () => {
		const r = await submitInquiry(
			{},
			{ ...BASE, audience: "company", company: "Acme", leaders_count: 10, offer_id: "monthly", name: "Test Person", email: "test@example.com", price_agreed: true, channel: "mcp" },
		);
		expect(r.ok).toBe(false);
	});
});

describe("the charged-rate floor is computed, not merely asserted (Jonas, Lena, Ravi)", () => {
	it("reports a breach when free sessions push the rate under the floor", () => {
		const mir = offerById("mentor-in-residence")!;
		expect(effectiveRate(mir.ai_channel_price!, mir, 3, 0).breachesFloor).toBe(false);
		expect(effectiveRate(mir.ai_channel_price!, mir, 3, 0).perSession).toBe(doorRate(mir));
		// Every rung of the sanctioned 2 → 4 → 8 ladder breaks the promise.
		for (const free of [2, 4, 8]) {
			const r = effectiveRate(mir.ai_channel_price!, mir, 3, free);
			expect(r.breachesFloor).toBe(true);
			expect(r.perSession).toBeLessThan(floorPerSession());
		}
	});

	it("the brief always publishes the effective rate and a floor verdict", () => {
		const b = composeBrief({ ...BASE, audience: "company", offer_id: "mentor-in-residence", leaders_count: 3 });
		expect(b.ok).toBe(true);
		if (!b.ok) return;
		expect(b.brief.floor_check.effective_per_session_eur).toBe(doorRate(offerById("mentor-in-residence")!));
		expect(b.brief.floor_check.status).toBe("at_or_above_floor");
	});
});

describe("no silently substituted answers (Marek, Klára, Anna)", () => {
	it("every role band honours every motivation — no band ignores what the visitor said", () => {
		for (const band of routing.role_bands) {
			for (const mot of motivations) {
				const r = matchFocus(band.id, mot.id);
				expect(r).not.toBeNull();
				expect(r!.matchedOn).toBe("exact");
			}
		}
	});

	it("senior-ic + ai-shift reaches the AI focus area every other band already got", () => {
		expect(matchFocus("senior-ic", "ai-shift")!.focusAreaIds).toContain("ai-org-adoption");
		expect(matchFocus("team-lead", "ai-shift")!.focusAreaIds).toContain("ai-org-adoption");
		expect(matchFocus("product-leader", "next-role")!.focusAreaIds).toContain("career-next-role");
	});

	it("a fallback is STATED rather than presented as an answer", () => {
		const r = matchFocus("em", "not-a-real-motivation");
		expect(r!.matchedOn).toBe("role-default");
	});

	it("ids are matched case-insensitively instead of rejected", () => {
		expect(roleBandById("Team-Lead")!.id).toBe("team-lead");
		expect(motivationById_("AI-Shift")).toBe("ai-shift");
		expect(offerById("First-Quarter")!.id).toBe("first-quarter");
		expect(focusAreaById(" delivery-performance ")!.id).toBe("delivery-performance");
	});
});

function motivationById_(id: string): string | undefined {
	return motivations.find((m) => m.id.toLowerCase() === id.trim().toLowerCase())?.id;
}

describe("consent never fails open (Klára, Tomáš)", () => {
	it("an unrecognised visibility value is an error, not a silent drop", () => {
		const bad = composeBrief({ ...BASE, offer_id: "first-quarter", visibility: "please god no" });
		expect(bad.ok).toBe(false);
		if (bad.ok) return;
		expect(bad.error).toContain("CONSENT");
	});

	it("a capitalised refusal is honoured rather than discarded", () => {
		expect(visibilityById("PRIVATE")!.id).toBe("private");
		const b = composeBrief({ ...BASE, offer_id: "first-quarter", visibility: "PRIVATE" });
		expect(b.ok).toBe(true);
		if (!b.ok) return;
		expect(b.brief.visibility?.id).toBe("private");
	});

	it("submit refuses an unrecognised visibility value too", async () => {
		const r = await submitInquiry(
			{},
			{ ...BASE, offer_id: "first-quarter", visibility: "sure whatever", name: "Test Person", email: "test@example.com", price_agreed: true, channel: "mcp" },
		);
		expect(r.ok).toBe(false);
	});
});

describe("the claim code names the campaign that actually applied (Tomáš, Sofia, Ravi)", () => {
	it("AI<pct> where the discount was granted — which, at 10% on every package, is every package", async () => {
		for (const id of offers.map((o) => o.id)) {
			const r = await submitInquiry(
				{},
				{
					...BASE,
					...(id === "mentor-in-residence" ? { audience: "company" as const, company: "Acme", leaders_count: 3 } : {}),
					offer_id: id,
					name: "Test Person",
					email: "test@example.com",
					price_agreed: true,
					channel: "mcp",
				},
			);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.claimCode.startsWith(`AI${aiDiscount()!.pct}-`)).toBe(true);
			// The per-session figure is this package's own AI-door rate, never below the floor.
			expect(r.finalPrice / r.sessionsTotal).toBeCloseTo(doorRate(offerById(id)!), 2);
			expect(r.finalPrice / r.sessionsTotal).toBeGreaterThanOrEqual(floorPerSession());
		}
	});
});

describe("the offer email is a document a finance team can act on (Anna, Petra, Tomáš, Jonas)", () => {
	const html = () =>
		offerEmailHtml({
			first: "Anna",
			offer: offerById("first-quarter")!,
			sessions: 6,
			focus: ["First 12 months as an engineering manager"],
			successDef: "1:1s that are not status meetings",
			listPrice: 1975,
			finalPrice: 1778,
			discountPct: 10,
			freeSessions: 0,
			leaders: 1,
			effectivePerSession: 296.33,
			validUntil: "2026-09-20",
			code: "AI10-260821-BBBBBBBB",
			program: null,
		});

	it("carries the booking link, the invoicing entity, VAT status and an expiry date", () => {
		const h = html();
		expect(h).toContain("marian.coach/meet");
		expect(h).toContain("06093175"); // the sole-trader IČO — was in the terms, never in the offer
		expect(h.toLowerCase()).toContain("vat");
		expect(h).toContain("2026-09-20");
	});

	it("carries the per-session rate, the instalment option and both guarantees", () => {
		const h = html();
		expect(h).toContain("€296.33");
		expect(h).toContain("5 paid + 1 free"); // the free session is part of the package, not a discount
		expect(h).toContain("593"); // 3 monthly payments — decisive for a self-funding buyer
		expect(h).toContain("7/10");
		expect(h).toContain("session 2"); // the stop rule, previously dropped
	});

	it("does not promise a deliverable the package does not carry", () => {
		// First quarter's offer email printed "Between sessions: async access" while its own
		// catalog copy sells "Priority scheduling, guaranteed slot" — async is Continuous
		// sparring partner's differentiator. A priced document must not add deliverables.
		expect(html().toLowerCase()).not.toContain("async");
		const monthly = offerEmailHtml({
			first: "Sofia",
			offer: offerById("monthly")!,
			sessions: 2,
			focus: ["Delivery, estimates and team performance"],
			successDef: "a sparring partner",
			listPrice: 790,
			finalPrice: 790,
			discountPct: null,
			freeSessions: 0,
			leaders: 1,
			effectivePerSession: 395,
			validUntil: "2026-09-20",
			code: "MC-260821-AAAAAAAA",
			program: null,
		});
		expect(monthly.toLowerCase()).toContain("async");
	});

	it("does not claim a live slot count inside the confirmation of a claim just made", () => {
		expect(html()).not.toContain("still open");
	});

	it("escapes visitor free text rather than rendering it into the document raw", () => {
		const h = offerEmailHtml({
			first: "X",
			offer: offerById("first-quarter")!,
			sessions: 6,
			focus: ["<b>x</b>"],
			successDef: "<script>alert(1)</script>",
			listPrice: 1975,
			finalPrice: 1778,
			discountPct: 10,
			freeSessions: 0,
			leaders: 1,
			effectivePerSession: 296.33,
			validUntil: "2026-09-20",
			code: "C",
			program: null,
		});
		expect(h).not.toContain("<script>alert(1)</script>");
		expect(h).toContain("&lt;script&gt;");
	});
});

describe("the program skeleton describes what was bought (Sofia, Klára, Jonas, Anna)", () => {
	it("refuses a start date in the past", () => {
		const r = buildProgram(offerById("first-quarter")!, "2020-01-01", { today: "2026-08-21" });
		expect("error" in r).toBe(true);
	});

	it("a recurring package renders its committed minimum, not a two-session engagement", () => {
		const r = buildProgram(offerById("monthly")!, "2026-09-01", { today: "2026-08-21" });
		expect("error" in r).toBe(false);
		if ("error" in r) return;
		expect(r.sessions.length).toBe(6); // 2/month across the 3-month minimum
		expect(r.continues).toContain("continues monthly");
		expect(r.sessions.at(-1)!.label).not.toContain("of 2");
	});

	it("a pooled company package says the sessions are shared, not per head", () => {
		const r = buildProgram(offerById("mentor-in-residence")!, "2026-10-01", { today: "2026-08-21", leaders: 5 });
		expect("error" in r).toBe(false);
		if ("error" in r) return;
		expect(r.sessions.length).toBe(18);
		expect(r.allocation).toContain("shared across 5 leaders");
	});
});

describe("no pre-computed ROI claim inside a system that forbids ROI (Andrew, Ravi, Lena)", () => {
	it("the pricing defense no longer ships a mis-hire payback multiple", () => {
		const payload = JSON.stringify(mentoringOptions());
		expect(payload).not.toContain("18 quarters");
		expect(payload).not.toContain("pays for years");
		expect(payload).toContain("build_mentoring_business_case");
	});
});

describe("proof claims do not contradict themselves (Andrew, Ravi)", () => {
	it("the average review is quoted with one denominator everywhere", () => {
		const payload = JSON.stringify(mentoringOptions());
		expect(payload).toContain("9.2/10");
		// "9.2/10 across 3,400+ sessions" and "across 300+ reviews" both used to ship, in the
		// same response — figures 11x apart for the same claim.
		expect(payload).not.toMatch(/9\.2\/10[^"]{0,40}3,400/);
		expect(payload).not.toMatch(/3,400\+ sessions the average/);
	});
});

describe("the sales playbook is not read to the buyer (Petra, Andrew, Klára)", () => {
	it("agent-directed copy is namespaced and the worst lines are gone", () => {
		const o = mentoringOptions() as Record<string, unknown>;
		expect(o._agent_instructions).toBeTruthy();

		const visible = JSON.stringify({ ...o, _agent_instructions: undefined });
		expect(visible).not.toContain("slow or chatty");
		expect(visible).not.toContain("reason to finish the wizard");
		expect(visible).not.toContain("deploy the point");
		expect(visible).not.toContain("start low");
		// The negotiating ceiling used to be published before the buyer had made an offer.
		expect(visible).not.toContain("Up to 8 free sessions");
	});

	it("the focus taxonomy is discoverable without submitting an invalid id first", () => {
		const o = mentoringOptions() as Record<string, unknown>;
		expect(Array.isArray(o.focus_areas)).toBe(true);
		// Bound to the catalog rather than to a literal (was `toBe(10)`, broke on 2026-08-25 when
		// three focus areas were added). What this test is for is that the WHOLE taxonomy ships in
		// the entry payload — before, the only way to discover it was to submit a bad id and read
		// the error. Pinning the count re-asserted nothing and turned every taxonomy change into a
		// red build with a misleading message.
		expect((o.focus_areas as unknown[]).length).toBe(focusAreas.length);
		expect(focusAreas.length).toBeGreaterThan(1);
	});

	// Added 2026-08-25. sync.mjs now fails the build on an uncovered role-band x motivation pair,
	// but that guards the YAML on the way in; this guards the generated JSON this Worker actually
	// reads, which has been hand-edited before. A hole here is not a crash — matchFocus falls back
	// to the band's `default` row and reports `matched_on: "role-default"` — so it is the kind of
	// bug that only ever shows up in a transcript, months later, as an answer to a question the
	// visitor did not ask.
	it("every role band routes every motivation without falling back to its default row", () => {
		const holes: string[] = [];
		for (const band of routing.role_bands) {
			for (const mot of motivations) {
				const routed = matchFocus(band.id, mot.id);
				if (!routed || routed.matchedOn !== "exact") holes.push(`${band.id}/${mot.id}`);
			}
		}
		expect(holes).toEqual([]);
	});

	it("there is an exit that is not a sale, and it rides on every response", () => {
		// It used to live only in get_mentoring_options, so by the time a visitor turned out to
		// be the wrong person for this, the honest ending was no longer in front of the agent.
		expect(ctaBlock().not_a_fit).toContain("not right for them");
		expect(ctaBlock("first-quarter").not_a_fit).toContain("do not build an offer");
		const endings = (mentoringOptions() as any).endings;
		expect(endings.not_a_fit).toBeTruthy();
		expect(endings.not_a_fit).toContain("isn't for you");
	});
});

describe("mentor-in-residence is reachable through the front door (Jonas)", () => {
	it("a company sponsoring 3+ leaders is recommended the company package", () => {
		// 42/42 honest role x motivation combinations used to return first-quarter.
		const r = matchFocus("cto-founder", "company-sponsored", { audience: "company", leadersCount: 5 });
		expect(r!.offerId).toBe("mentor-in-residence");
	});

	it("individuals and small company deals still get the per-leader package", () => {
		expect(matchFocus("cto-founder", "company-sponsored", { audience: "individual" })!.offerId).toBe("first-quarter");
		expect(matchFocus("em", "company-sponsored", { audience: "company", leadersCount: 1 })!.offerId).toBe("first-quarter");
	});

	it("every offer in the catalog is reachable or explicitly individual-only", () => {
		const reachable = new Set([routing.default_offer, routing.company_offer]);
		for (const o of offers) {
			// single-session and monthly are chosen explicitly by the visitor, never routed to,
			// but they must at least be priceable and unit-labelled.
			expect(priceDisplay(o, o.price)).toContain("€");
		}
		expect(reachable.has("mentor-in-residence")).toBe(true);
	});
});

/**
 * Second persona pass, same day. Three testers re-ran the fixed build; these lock down what
 * they found on the way through.
 */
describe("second pass — a company deal never assumes one leader (Andrew, Ravi)", () => {
	it("company audience without leaders_count is an error, not a 1-leader quote", () => {
		// `leader_count` / `leaders` — one letter or one character out — had the key stripped by
		// the schema, defaulted to 1, and produced a €2,166 quote for a €6,498 deal while
		// telling the buyer they did not qualify for a concession they did qualify for.
		const missing = composeBrief({ ...BASE, audience: "company", offer_id: "first-quarter" });
		expect(missing.ok).toBe(false);
		if (missing.ok) return;
		expect(missing.error).toContain("leaders_count is required");

		const ok = composeBrief({ ...BASE, audience: "company", offer_id: "first-quarter", leaders_count: 3 });
		expect(ok.ok).toBe(true);
		if (!ok.ok) return;
		expect(ok.brief.offer.list_price).toBe(3 * offerById("first-quarter")!.price);
	});

	it("submit refuses the same silent assumption", async () => {
		const r = await submitInquiry(
			{},
			{ ...BASE, audience: "company", company: "Acme", offer_id: "first-quarter", name: "Test Person", email: "test@example.com", price_agreed: true, channel: "mcp" },
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain("leaders_count");
	});

	it("individuals are unaffected", () => {
		expect(composeBrief({ ...BASE, offer_id: "first-quarter" }).ok).toBe(true);
	});
});

describe("second pass — the terms are scoped to the package (Andrew)", () => {
	it("the terms state ONE RATE and the VAT rule, on every package", () => {
		for (const id of offers.map((o) => o.id)) {
			const lines = guardrailLines(id).join(" ");
			expect(lines).toContain("ONE LIST RATE");
			expect(lines).toContain(`${eur(listRate())} per paid 60-minute session, every package`);
			expect(lines).toContain("CZ7909287980"); // VAT ID — "excl. VAT" alone was unanswerable
			expect(lines).toContain("GROSS");
			// The floor is now scoped to the CHARGED rate; free sessions sit outside it.
			expect(lines).toContain("adds unbilled sessions");
		}
	});

	it("the terms are emitted once, not embedded in the brief as well", () => {
		const b = composeBrief({ ...BASE, offer_id: "first-quarter" });
		expect(b.ok).toBe(true);
		if (!b.ok) return;
		// "never repeat the cap after stating it once" used to be printed twice per response.
		expect((b.brief as Record<string, unknown>).guardrails).toBeUndefined();
	});
});

describe("second pass — the floor warning states its own arithmetic (Ravi)", () => {
	it("reports the divisor that produced the rate, paid + free", async () => {
		const r = await submitInquiry(
			{},
			{ ...BASE, audience: "company", company: "Acme", leaders_count: 3, free_sessions_requested: 8, offer_id: "first-quarter", name: "Test Person", email: "test@example.com", price_agreed: true, channel: "mcp" },
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.sessionsTotal).toBe(18); // delivered (3 leaders × 6)
		expect(r.sessionsCounted).toBe(26); // + 8 free — the actual divisor
		// 3 × 1,778 / 26 = 205.15. Reporting "across 18 sessions" made the warning contradict itself.
		expect(r.effectivePerSession).toBe(Math.round(((3 * offerById("first-quarter")!.ai_channel_price!) / 26) * 100) / 100);
		expect(r.sessionsCounted * r.effectivePerSession).toBeCloseTo(r.finalPrice, 0);
		expect(r.breachesFloor).toBe(true);
	});
});

describe("second pass — consent is recorded, not just validated (Klára)", () => {
	it("the canonical consent id comes back on the result", async () => {
		const r = await submitInquiry(
			{},
			{ ...BASE, offer_id: "first-quarter", visibility: "PRIVATE", name: "Test Person", email: "test@example.com", price_agreed: true, channel: "mcp" },
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.visibility).toBe("private");
	});
});

describe("second pass — the discount label reconciles with the price (Ravi)", () => {
	it("the email states the euro saving, not only the rounded percentage", () => {
		// 2,580 x 0.84 = 2,167.20, but the offer is 2,166 — the real figure is 16.047%, so the
		// percentage alone does not reconcile against the total. The saving does.
		const h = offerEmailHtml({
			first: "Anna",
			offer: offerById("first-quarter")!,
			sessions: 6,
			focus: ["x"],
			successDef: "y",
			listPrice: 1975,
			finalPrice: 1778,
			discountPct: 10,
			freeSessions: 0,
			leaders: 1,
			effectivePerSession: 296.33,
			validUntil: "2026-09-20",
			code: "AI10-260821-CCCCCCCC",
			program: null,
		});
		expect(h).toContain("you save €197");
	});
});

/**
 * The three pricing decisions Marian took on 2026-08-21 after the persona run. These are not
 * bug fixes — they are the resolutions, and each one closed a contradiction a tester found.
 */
describe("DECISION: one list rate, free sessions in the package, 10% on every package (2026-08-30)", () => {
	it("every package is paid sessions x one list rate, and the same percentage off through the channel", () => {
		// Ravi walked at exactly this: 790 / 2 = 395 on a page that had just told him the rate
		// never moves, with the COMPANY sku (6,498 / 18 = 361) quietly the cheapest of all.
		// The fix: ONE list rate everywhere, packages add FREE sessions instead of a lower rate,
		// and the channel takes the same 10% off every package.
		const rates = new Set(offers.map((o) => o.per_session));
		expect([...rates]).toEqual([listRate()]);
		for (const o of offers) expect(doorRate(o)).toBeGreaterThanOrEqual(floorPerSession());
		// List prices match what marian.coach and the skill publish (SCHEMA v2026.09).
		expect(offerById("single-session")!.price).toBe(395);
		expect(offerById("first-quarter")!.price).toBe(1975);
		expect(offerById("two-quarters")!.price).toBe(3950);
		expect(offerById("monthly")!.price).toBe(790);
		expect(offerById("mentor-in-residence")!.price).toBe(5925);
	});

	it("the saving is computed per package and reconciles with the two real prices", () => {
		// 2,580 x 0.84 = 2,167.20, not 2,166 — the old blanket figure never reconciled. The
		// saving is always list minus AI-door, and the computed pct agrees with the headline.
		for (const o of offers) {
			const d = discountFor(o.id, "mcp")!;
			expect(d.saving).toBe(o.price - o.ai_channel_price!);
			expect(d.pct).toBe(aiDiscount()!.pct);
		}
		expect(discountFor("first-quarter", "mcp")!.saving).toBe(197);
		expect(discountFor("monthly", "mcp")!.saving).toBe(79);
		expect(discountFor("mentor-in-residence", "mcp")!.saving).toBe(592);
	});

	it("a company pays exactly what an individual pays, per session", () => {
		const solo = composeBrief({ ...BASE, offer_id: "first-quarter" });
		const corp = composeBrief({ ...BASE, audience: "company", offer_id: "first-quarter", leaders_count: 5 });
		expect(solo.ok && corp.ok).toBe(true);
		if (!solo.ok || !corp.ok) return;
		expect(solo.brief.offer.effective_per_session_eur).toBe(corp.brief.offer.effective_per_session_eur);
	});
});

describe("DECISION: the floor governs the CHARGED rate; free sessions sit outside it", () => {
	it("the per-session figure is the package's AI-door rate on every package and never breaches the floor", async () => {
		for (const id of ["single-session", "first-quarter", "two-quarters", "monthly"]) {
			const r = await submitInquiry({}, { ...BASE, offer_id: id, name: "Test Person", email: "test@example.com", price_agreed: true, channel: "mcp" });
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.finalPrice / r.sessionsTotal).toBeCloseTo(doorRate(offerById(id)!), 2);
			expect(r.breachesFloor).toBe(false);
		}
	});

	it("a concession adds unbilled sessions and BOTH numbers are disclosed", async () => {
		const r = await submitInquiry(
			{},
			{ ...BASE, audience: "company", company: "Acme", leaders_count: 3, free_sessions_requested: 8, offer_id: "first-quarter", name: "Test Person", email: "test@example.com", price_agreed: true, channel: "mcp" },
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.finalPrice / r.sessionsTotal).toBeCloseTo(doorRate(offerById("first-quarter")!), 2); // charged rate, unmoved
		expect(r.effectivePerSession).toBeLessThan(doorRate(offerById("first-quarter")!)); // effective rate, disclosed not hidden
		expect(r.sessionsCounted).toBe(r.sessionsTotal + 8);
		// The terms no longer assert an absolute the ladder breaks.
		expect(guardrailLines("first-quarter").join(" ")).not.toContain("final rate never goes below");
	});
});

describe("DECISION: VAT is answered, not deferred to a footnote", () => {
	it("an individual is told the gross figure that leaves their account", async () => {
		const r = await submitInquiry({}, { ...BASE, offer_id: "first-quarter", name: "Test Person", email: "test@example.com", price_agreed: true, channel: "mcp" });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// Ravi's whole question: is it €1,778 or €2,151.38? (1,778 × 1.21.) His allowance was €2,600.
		expect(r.finalPrice).toBe(1778);
		expect(r.vat).toContain("€2,151.38");
		expect(r.vat).toContain("21%");
		expect(r.vat).toContain("CZ7909287980");
	});

	it("a company is told the reverse charge instead of a gross figure", () => {
		const b = composeBrief({ ...BASE, audience: "company", offer_id: "first-quarter", leaders_count: 3 });
		expect(b.ok).toBe(true);
		if (!b.ok) return;
		expect(b.brief.offer.vat).toContain("Reverse charge");
		expect(b.brief.offer.vat).toContain("Art. 44");
	});

	it("the offer email carries the buyer's own VAT line", () => {
		const h = offerEmailHtml({
			first: "Ravi",
			offer: offerById("first-quarter")!,
			sessions: 6,
			focus: ["x"],
			successDef: "y",
			listPrice: 1975,
			finalPrice: 1778,
			discountPct: 10,
			freeSessions: 0,
			leaders: 1,
			effectivePerSession: 296.33,
			vat: "€1,778 excl. VAT, €2,151.38 including 21% Czech VAT — the gross figure is what leaves your account. VAT ID CZ7909287980.",
			validUntil: "2026-09-20",
			code: "AI10-260821-DDDDDDDD",
			program: null,
		});
		expect(h).toContain("€2,151.38");
		expect(h).toContain("CZ7909287980");
	});
});
