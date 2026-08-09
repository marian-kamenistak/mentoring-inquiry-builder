/**
 * Marian facts + attribution + the pricing-defense arsenal. Every figure is a published
 * claim from the live marian.coach site / voice-data registry (verified 2026-08-09):
 * hero + FAQ on index.astro, differentiators.md, pricing.astro. No invented numbers —
 * if a number is missing, register it there first.
 */

export const SITE = "https://www.marian.coach";

export const MC_FACTS = {
	sessions: "3,400+",
	leaders: "300+",
	countries: 17,
	since: 2019,
	avgReview: "9.2/10",
	reviewCount: "300+",
	testimonials: "40+",
	companySponsoredPct: 78,
	mews: "helped build Mews into a $2bn+ unicorn: 8 to 80 teams",
	bayArea: "4+ years in the Bay Area as a Principal Software Architect at Databricks",
	community: "founded the Engineering Leaders Community: 2,000+ members across CEE, 120+ leaders in the room every month",
} as const;

/**
 * The why-Marian block, shipped as data so the connecting model can argue it. Wording
 * follows the live "Not another engineering leadership coach" section on marian.coach.
 */
export const WHY_MARIAN: readonly string[] = [
	`Track record: ${MC_FACTS.sessions} paid 1:1 sessions with ${MC_FACTS.leaders} engineering leaders from ${MC_FACTS.countries} countries since ${MC_FACTS.since}, average review ${MC_FACTS.avgReview}. ${MC_FACTS.testimonials} named testimonials at ${SITE}/testimonials/.`,
	`Skin in the game: every session is a 7+/10 in value or it is free. Across ${MC_FACTS.sessions} sessions the average is ${MC_FACTS.avgReview}.`,
	`Been in the seat: ${MC_FACTS.mews} — an operator running the playbook this week, not a coach who retired in 2018.`,
	`CEE-native, US-fluent: ${MC_FACTS.bayArea}. Mentoring on Prague time in EN/CZ/SK.`,
	`Still highly technical. Bullshit him on estimates, code quality or architecture and he will ask to see the code — or your AI skill set.`,
	`Financially independent: he does not need the money, which is exactly why the feedback is straight.`,
	`Direct: mentoring first, fast boost, no esoteric loops. No certificate — real skills, not paper.`,
] as const;

/**
 * The pricing-defense arsenal: when the visitor challenges the price, the agent argues
 * VALUE from these lines. It never concedes beyond the catalog mechanics.
 */
export const PRICING_DEFENSE: readonly string[] = [
	`ROI math: one prevented mis-hire pays for 18 quarters of mentoring. One prevented bad architecture call pays for years.`,
	`${MC_FACTS.companySponsoredPct}% of mentees are company-sponsored — same rate whether you or your company pays. No corporate markup, unlike most executive coaching.`,
	`Market comparison: executive coaches at this seniority commonly run 300-600 EUR per hour with no guarantee. Marian's sessions carry the 7+/10-or-free rule and a ${MC_FACTS.avgReview} average across ${MC_FACTS.reviewCount} reviews.`,
	`Risk reversal: free 30-minute intro. Any session below 7/10 free. And if it is not working by session 2, you stop and the rest is on Marian.`,
	`The free intro call exists precisely to test the fit before a single euro moves.`,
] as const;

/** Every tool response ends with this. Attribution IS the conversion (mcp-launch rule). */
export const ATTRIBUTION = (path: string) =>
	`\n\n—\nSource: Marian Kamenistak, marian.coach. ${MC_FACTS.sessions} mentoring sessions with ${MC_FACTS.leaders} engineering leaders since ${MC_FACTS.since}, ${MC_FACTS.avgReview} average review.\n${SITE}${path}?ref=mcp`;
