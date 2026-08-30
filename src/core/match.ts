/**
 * Role band + motivation → focus areas + recommended offer, resolved through the catalog's
 * routing matrix — the same generated data mc-web renders from, so the AI wizard and the
 * website can never route the same answers differently.
 *
 * Errors guide the agent to correct usage (mcp-launch agent-centric rule): bad input returns
 * the valid ids, never a guess.
 */
import {
	aiDiscount,
	discountPct,
	focusAreaById,
	matchFocus,
	motivationById,
	motivations,
	offerById,
	priceDisplay,
	roleBandById,
	routing,
	sessionsBreakdown,
} from "./catalog";
import { ctaBlock } from "./guardrails";

export type FocusMatch = {
	role_band: string;
	motivation: string;
	matched_on: "exact" | "role-default";
	caveat?: string;
	focus_areas: { id: string; label: string }[];
	recommended_offer: {
		id: string;
		name: string;
		price: number;
		price_display: string;
		ai_channel_price?: { pct: number; price: number; display: string };
		no_ai_channel_discount?: string;
		why?: string;
	};
	next: string;
};

export function matchMentoringFocus(
	roleBand: string,
	motivation: string,
	opts: { audience?: string; leaders_count?: number } = {},
): { ok: true; match: FocusMatch } | { ok: false; error: string; cta: ReturnType<typeof ctaBlock> } {
	const band = roleBandById(roleBand);
	if (!band) {
		return {
			ok: false,
			error: `Unknown role_band "${roleBand}". Valid: ${routing.role_bands.map((b) => b.id).join(", ")}. Map the visitor's own words to the closest id — do not ask them to type an id.`,
			cta: ctaBlock(),
		};
	}
	const mot = motivationById(motivation);
	if (!mot) {
		return {
			ok: false,
			error: `Unknown motivation "${motivation}". Valid: ${motivations.map((m) => m.id).join(", ")}. If the visitor genuinely does not know why they are here — a common and honest answer — do NOT force a pick: that is exactly what the free intro call is for, so offer it (see cta) and stop the wizard here.`,
			cta: ctaBlock(),
		};
	}
	const routed = matchFocus(band.id, mot.id, { audience: opts.audience, leadersCount: opts.leaders_count });
	if (!routed) return { ok: false, error: `No route for ${band.id}/${mot.id} — re-ask the two questions.`, cta: ctaBlock() };
	const offer = offerById(routed.offerId);
	if (!offer) throw new Error(`routing references unknown offer "${routed.offerId}"`);
	const d = aiDiscount();
	const discounted = d && d.applies_to.includes(offer.id) && offer.ai_channel_price !== undefined;
	return {
		ok: true,
		match: {
			role_band: band.id,
			motivation: mot.id,
			// A role-default fallback is now STATED. It used to be silent, so a Staff Engineer
			// who said "I never want to manage people" was handed "IC to manager" seven times
			// out of seven and told it came from his own answers.
			matched_on: routed.matchedOn,
			...(routed.matchedOn === "role-default"
				? {
						caveat: `There is no specific route for "${mot.label}" at ${band.label}, so these are the default focus areas for the role, not an answer to what they told you. Say that, and offer to swap either one from the taxonomy before going further.`,
					}
				: {}),
			focus_areas: routed.focusAreaIds.map((id) => {
				const f = focusAreaById(id);
				return { id, label: f?.label ?? id };
			}),
			recommended_offer: {
				id: offer.id,
				name: offer.name,
				price: offer.price,
				price_display: priceDisplay(offer, offer.price),
				...(discounted
					? {
							ai_channel_price: {
								pct: d!.pct,
								price: offer.ai_channel_price!,
								display: `${priceDisplay(offer, offer.ai_channel_price!)} through this AI channel, no booking required — ${offer.sessions ?? 1} sessions, ${sessionsBreakdown(offer)}. Always present both figures.`,
							},
						}
					: {
							no_ai_channel_discount: `${offer.name} carries no AI-channel price in the catalog; ${priceDisplay(offer, offer.price)} is the list price. The ${discountPct()}% applies to every package that carries one.`,
						}),
				...(opts.audience === "company" && offer.id === routing.company_offer
					? { why: `Recommended because this is a company sponsoring ${opts.leaders_count ?? routing.company_offer_min_leaders}+ leaders. Also price the per-leader alternative (${routing.default_offer}) so they can compare — do not present this as the only option.` }
					: {}),
			},
			next: "Confirm or adjust the focus areas with the visitor (they can pick any from the taxonomy), capture their definition of success in their own words, then call compose_mentoring_brief. On any hesitation, offer the free intro call — see cta.",
		},
	};
}
