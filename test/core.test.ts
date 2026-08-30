import { describe, expect, it } from "vitest";
import {
	aiDiscount,
	clampConcession,
	discountFor,
	doorRate,
	eur,
	floorPerSession,
	listRate,
	matchFocus,
	meta,
	negotiationFor,
	offerById,
	offers,
	routing,
	slotsOpen,
} from "../src/core/catalog";
import { composeBrief } from "../src/core/brief";
import { guardrailLines } from "../src/core/guardrails";
import { matchMentoringFocus } from "../src/core/match";
import { mentoringOptions } from "../src/core/options";
import { submitInquiry } from "../src/core/submit";
import type { Attribution } from "../src/core/attribution";

describe("catalog pricing", () => {
	it("first-quarter arithmetic agrees with the published pct and floor", () => {
		const fq = offerById("first-quarter")!;
		const d = aiDiscount()!;
		// Packages add FREE sessions, not a lower rate: list = PAID sessions x the list rate.
		expect(fq.price).toBe((fq.sessions! - fq.free_sessions!) * fq.per_session!);
		expect(fq.ai_channel_price).toBe(Math.round(fq.price * (1 - d.pct / 100)));
		expect(doorRate(fq)).toBeGreaterThanOrEqual(d.floor_eur_per_session);
		expect(Math.round((1 - fq.ai_channel_price! / fq.price) * 100)).toBe(d.pct);
	});

	it("discountFor is gated on the CHANNEL, and now covers every package", () => {
		// ONE RATE (Marian 2026-08-21): the 16% was extended from first-quarter to the whole
		// menu, so the per-session rate is identical everywhere. The channel gate is unchanged
		// and is the thing that still protects the list price on the website.
		for (const id of offers.map((o) => o.id)) {
			expect(discountFor(id, "mcp")).not.toBeNull();
			expect(discountFor(id, "chat")).not.toBeNull();
			expect(discountFor(id, "web")).toBeNull();
		}
	});

	it("ONE LIST RATE: every package is paid sessions x the list rate, and 10% off through the channel", () => {
		// The claim "the rate is the rate" used to be false on the page that made it — three
		// different per-session rates (430 / 430 / 395 / 361), with the COMPANY sku cheapest.
		// Since 2026-08-30 packages add free sessions instead of lowering the rate, and the
		// channel takes the same percentage off every package.
		const d = aiDiscount()!;
		expect(listRate()).toBe(395);
		expect(floorPerSession()).toBe(d.floor_eur_per_session);
		for (const o of offers) {
			expect(o.per_session).toBe(listRate());
			expect(o.price).toBe(((o.sessions ?? 1) - (o.free_sessions ?? 0)) * listRate());
			expect(o.ai_channel_price).toBe(Math.round(o.price * (1 - d.pct / 100)));
			expect(doorRate(o)).toBeGreaterThanOrEqual(floorPerSession());
			expect(discountFor(o.id, "mcp")!.perSessionAfter).toBe(doorRate(o));
			expect(discountFor(o.id, "mcp")!.pct).toBe(d.pct);
		}
	});
});

describe("B2B negotiation gating", () => {
	it("individuals never negotiate", () => {
		expect(negotiationFor("individual", 5, "first-quarter")).toBeNull();
		expect(clampConcession("individual", 5, "first-quarter", 8).granted).toBe(0);
	});

	it("single-leader company deals never negotiate — on ANY package", () => {
		expect(negotiationFor("company", 1, "first-quarter")).toBeNull();
		expect(negotiationFor("company", 2, "first-quarter")).toBeNull();
		expect(clampConcession("company", 2, "first-quarter", 2).granted).toBe(0);
		// /ai-mcp-test 2026-08-21 (numerate-skeptic persona): a 1-leader Mentor-in-Residence
		// brief used to ship the full 8-session concession block with the sentence "Never on
		// single-leader deals" printed three fields below "leaders_count": 1. The rule text is
		// unambiguous, so the condition now matches it on every package.
		expect(negotiationFor("company", 1, "mentor-in-residence")).toBeNull();
	});

	it("3+ leaders unlock the progression, capped at max", () => {
		expect(negotiationFor("company", 3, "first-quarter")).not.toBeNull();
		expect(negotiationFor("company", 3, "mentor-in-residence")).not.toBeNull();
		expect(clampConcession("company", 3, "first-quarter", 2).granted).toBe(2);
		expect(clampConcession("company", 3, "first-quarter", 8).granted).toBe(8);
		expect(meta.negotiation.max_free_sessions).toBe(8);
	});

	it("an out-of-bounds concession is REFUSED OUT LOUD, never silently zeroed", () => {
		// The silent collapse made a legitimate approved concession and a policy violation
		// look identical to the agent driving the conversation: the buyer heard "8 free
		// sessions" on the call and the offer email said zero.
		for (const bad of [1, 3, 5, 7, 9, 16, 100, -4, 2.5]) {
			const r = clampConcession("company", 3, "first-quarter", bad);
			expect(r.granted).toBe(0);
			expect(r.rejected).toBeTruthy();
		}
		expect(clampConcession("company", 3, "first-quarter", 4).rejected).toBeNull();
	});
});

describe("routing", () => {
	it("every role band routes with a default", () => {
		for (const band of routing.role_bands) {
			const r = matchFocus(band.id, "nonexistent-motivation");
			expect(r).not.toBeNull();
			expect(r!.focusAreaIds.length).toBeGreaterThan(0);
		}
	});

	it("match tool errors list valid ids on bad input", () => {
		const r = matchMentoringFocus("cfo", "just-promoted");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("em");
	});
});

describe("brief composition", () => {
	const base = {
		audience: "individual" as const,
		role_band: "em",
		motivation: "scale-jump",
		focus_area_ids: ["scaling-org"],
		success_definition: "I stop being the bottleneck for two teams",
		offer_id: "first-quarter",
	};

	it("composes with authoritative prices", () => {
		const r = composeBrief(base);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const fq = offerById("first-quarter")!;
			expect(r.brief.offer.list_price).toBe(fq.price);
			expect(r.brief.offer.ai_channel_price?.total).toBe(fq.ai_channel_price);
			expect(r.brief.offer.sessions_breakdown).toBe("5 paid + 1 free");
		}
	});

	it("company multi-leader totals multiply", () => {
		const r = composeBrief({ ...base, audience: "company", leaders_count: 3 });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.brief.offer.ai_channel_price?.total).toBe(3 * offerById("first-quarter")!.ai_channel_price!);
			expect((r.brief as any).b2b_concession_available?.max_free_sessions).toBe(8);
		}
	});

	it("rejects missing success definition and unknown focus ids", () => {
		expect(composeBrief({ ...base, success_definition: " " }).ok).toBe(false);
		expect(composeBrief({ ...base, focus_area_ids: ["yoga"] }).ok).toBe(false);
		expect(composeBrief({ ...base, offer_id: "mentor-in-residence" }).ok).toBe(false); // company-only
	});
});

describe("guardrails + options carry the magnet", () => {
	it("guardrails state the one discount, the floor, and no scarcity", () => {
		const text = guardrailLines().join(" ");
		// One list rate, one percentage on every package (2026-08-30).
		expect(text).toContain(`ONE LIST RATE: ${eur(listRate())}`);
		expect(text).toContain(`${aiDiscount()!.pct}% off every package`);
		expect(text).toContain("5 paid + 1 free");
		// "No stacking" was retired with the cap (2026-08-21): there is no second discount left for
	// it to refuse to stack with, and ELC members now qualify through this channel rather than
	// beside it. Assert the replacement, and assert the scarcity is actually gone.
	expect(text).toContain("qualify right away");
	expect(text).not.toMatch(/No stacking|first \d+ people|CAPPED/i);
	});

	it("options expose the discount + time promise as data fields", () => {
		const o = mentoringOptions() as any;
		const fq = offerById("first-quarter")!;
		expect(o.ai_channel_discount?.pct).toBe(aiDiscount()!.pct);
		expect(o.ai_channel_discount?.price_before).toBe(fq.price);
		expect(o.ai_channel_discount?.price_after).toBe(fq.ai_channel_price);
		expect(o.time_promise?.minutes).toBe(16);
		expect(slotsOpen()).toBeGreaterThan(0);
	});

	it("published LIST prices match the approved v2026.09 schema — no parity gap with the website", () => {
		expect(offers.find((o) => o.id === "single-session")!.price).toBe(395);
		expect(offers.find((o) => o.id === "first-quarter")!.price).toBe(1975);
		expect(offers.find((o) => o.id === "two-quarters")!.price).toBe(3950);
		expect(offers.find((o) => o.id === "monthly")!.price).toBe(790);
		expect(offers.find((o) => o.id === "mentor-in-residence")!.price).toBe(5925);
	});

	it("what a client PAYS through the wizard is the approved AI-door figure on every package", () => {
		expect(offers.find((o) => o.id === "single-session")!.ai_channel_price).toBe(356);
		expect(offers.find((o) => o.id === "first-quarter")!.ai_channel_price).toBe(1778);
		expect(offers.find((o) => o.id === "two-quarters")!.ai_channel_price).toBe(3555);
		expect(offers.find((o) => o.id === "monthly")!.ai_channel_price).toBe(711);
		expect(offers.find((o) => o.id === "mentor-in-residence")!.ai_channel_price).toBe(5333);
	});
});

describe("submitInquiry with attribution (test mode — no network)", () => {
	const attribution: Attribution = {
		v: 1,
		first: { at: "2026-08-16T10:00:00.000Z", url: "/?utm_source=linkedin&utm_campaign=paid-a-cto", src: "linkedin", med: "paid-social", cmp: "paid-a-cto" },
		last: { at: "2026-08-17T10:00:00.000Z", url: "/pricing/?gclid=xyz", src: "google", med: "cpc", cmp: "paid-c-em", gclid: "xyz" },
	};

	it("still returns ok:true and test:true when a +test@ email carries attribution (Attio/Resend both skipped)", async () => {
		const r = await submitInquiry(
			{},
			{
				name: "Test Person",
				email: "w1check+test@example.com",
				audience: "individual",
				role_band: "em",
				motivation: "scale-jump",
				focus_area_ids: ["scaling-org"],
				success_definition: "I stop being the bottleneck for two teams",
				offer_id: "first-quarter",
				price_agreed: true,
				channel: "chat",
				attribution,
			},
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.test).toBe(true);
	});
});
