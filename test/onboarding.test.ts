// Onboarding checklist + first session as the main ending (Marian, 2026-10-09).
import { describe, expect, it } from "vitest";
import { offerById, meta } from "../src/core/catalog";
import { mentoringOptions } from "../src/core/options";
import { onboardingLines, pickOnboarding } from "../src/core/onboarding";
import { offerEmailHtml } from "../src/core/submit";
import { firstSessionUrl } from "../src/core/booking";

describe("onboarding checklist", () => {
	it("keeps only valid, non-empty answers and never requires any", () => {
		const o = pickOnboarding({ heard_from: "Ondra from Mews", payer: "company", kpis: ["1:1 with each lead weekly"], cadence_preference: "weekly", li_post_consent: "later", nda_needed: "bogus", linkedin_url: "", name: "ignored" });
		expect(o).toEqual({ heard_from: "Ondra from Mews", payer: "company", kpis: ["1:1 with each lead weekly"], cadence_preference: "weekly", li_post_consent: "later" });
		expect(pickOnboarding({})).toEqual({});
	});

	it("renders readable lines for the CRM and Slack", () => {
		const lines = onboardingLines({ homework_time_ok: true, kpis: ["a", "b"], li_recommendation: "yes" });
		expect(lines).toEqual(["~1 h/week for homework: yes", "KPIs: a | b", "LinkedIn recommendation: yes"]);
	});

	it("is offered to the agent, optional, with the LinkedIn ask framed for later", () => {
		const opts = mentoringOptions() as any;
		expect(opts.onboarding_questions.rule).toMatch(/optional/i);
		expect(opts.onboarding_questions.visibility_and_recommendation.when).toMatch(/LATER/);
		expect(JSON.stringify(opts.onboarding_questions)).toMatch(/purchase order comes after that session/);
	});
});

describe("first session is the main ending", () => {
	it("leads the endings, ahead of the intro fallback", () => {
		const e = (mentoringOptions() as any).endings;
		expect(Object.keys(e)[0]).toBe("first_session");
		expect(e.first_session).toContain("mentoring-boost");
		expect(e.intro_call).toMatch(/fallback/i);
	});

	const base = {
		first: "Martin",
		offer: offerById("first-quarter")!,
		sessions: 6,
		focus: ["Delegation"],
		successDef: "three decision areas handed to the leads",
		listPrice: 1975,
		finalPrice: 1778,
		discountPct: 10,
		freeSessions: 0,
		leaders: 1,
		effectivePerSession: 296,
		isCompany: true,
		validUntil: "2026-10-23",
		code: "AI10-261009-AAAAAAAA",
		program: null,
	};

	it("an eligible offer email ends on booking the first session, PO after session 1", () => {
		const html = offerEmailHtml({ ...base, bookUrl: firstSessionUrl(base.code) });
		expect(html).toContain("Book your first session");
		expect(html).toContain("mentoring-boost");
		expect(html).toContain("purchase order is collected after session 1");
		expect(html).not.toContain("final terms are confirmed on the free intro call");
	});

	it("an ineligible offer email still sends them to the intro", () => {
		const html = offerEmailHtml(base);
		expect(html).toContain("Book the intro call");
		expect(html).toContain(meta.booking_url);
	});
});
