import { describe, expect, it } from "vitest";
import {
	aiDiscount,
	clampConcession,
	discountFor,
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
		expect(fq.price).toBe(fq.sessions! * fq.per_session!);
		expect(fq.ai_channel_price).toBe(fq.sessions! * d.floor_eur_per_session);
		expect(Math.round((1 - fq.ai_channel_price! / fq.price) * 100)).toBe(d.pct);
	});

	it("discountFor only fires on ai channels + applies_to offers", () => {
		expect(discountFor("first-quarter", "mcp")).not.toBeNull();
		expect(discountFor("first-quarter", "chat")).not.toBeNull();
		expect(discountFor("first-quarter", "web")).toBeNull();
		expect(discountFor("single-session", "mcp")).toBeNull();
		expect(discountFor("monthly", "mcp")).toBeNull();
		expect(discountFor("mentor-in-residence", "mcp")).toBeNull();
	});

	it("discounted price never breaks the floor", () => {
		const d = discountFor("first-quarter", "mcp")!;
		expect(d.perSessionAfter).toBeGreaterThanOrEqual(aiDiscount()!.floor_eur_per_session);
	});
});

describe("B2B negotiation gating", () => {
	it("individuals never negotiate", () => {
		expect(negotiationFor("individual", 5, "first-quarter")).toBeNull();
		expect(clampConcession("individual", 5, "first-quarter", 8)).toBe(0);
	});

	it("single-leader company deals never negotiate", () => {
		expect(negotiationFor("company", 1, "first-quarter")).toBeNull();
		expect(negotiationFor("company", 2, "first-quarter")).toBeNull();
		expect(clampConcession("company", 2, "first-quarter", 2)).toBe(0);
	});

	it("3+ leaders or MiR unlock the progression, capped at max", () => {
		expect(negotiationFor("company", 3, "first-quarter")).not.toBeNull();
		expect(negotiationFor("company", 1, "mentor-in-residence")).not.toBeNull();
		expect(clampConcession("company", 3, "first-quarter", 2)).toBe(2);
		expect(clampConcession("company", 3, "first-quarter", 8)).toBe(8);
		expect(clampConcession("company", 3, "first-quarter", 16)).toBe(0); // off-progression collapses
		expect(clampConcession("company", 3, "first-quarter", 5)).toBe(0);
		expect(meta.negotiation.max_free_sessions).toBe(8);
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
			expect(r.brief.offer.list_price).toBe(2580);
			expect(r.brief.offer.ai_channel_price?.total).toBe(2166);
		}
	});

	it("company multi-leader totals multiply", () => {
		const r = composeBrief({ ...base, audience: "company", leaders_count: 3 });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.brief.offer.ai_channel_price?.total).toBe(3 * 2166);
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
	it("guardrails state the one discount, the floor, and the no-stack rule", () => {
		const text = guardrailLines().join(" ");
		expect(text).toContain("16%");
		expect(text).toContain("€361");
		expect(text).toContain("No stacking");
	});

	it("options expose the discount + time promise as data fields", () => {
		const o = mentoringOptions() as any;
		expect(o.ai_channel_discount?.pct).toBe(16);
		expect(o.ai_channel_discount?.price_before).toBe(2580);
		expect(o.ai_channel_discount?.price_after).toBe(2166);
		expect(o.time_promise?.minutes).toBe(16);
		expect(slotsOpen()).toBeGreaterThan(0);
	});

	it("offers list carries the re-gated list prices", () => {
		expect(offers.find((o) => o.id === "single-session")!.price).toBe(430);
		expect(offers.find((o) => o.id === "monthly")!.price).toBe(790);
		expect(offers.find((o) => o.id === "mentor-in-residence")!.price).toBe(6498);
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
