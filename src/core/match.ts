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
	eur,
	focusAreaById,
	matchFocus,
	motivationById,
	motivations,
	offerById,
	roleBandById,
	routing,
	slotsOpen,
} from "./catalog";

export type FocusMatch = {
	role_band: string;
	motivation: string;
	focus_areas: { id: string; label: string }[];
	recommended_offer: {
		id: string;
		name: string;
		price: number;
		price_display: string;
		ai_channel_price?: { pct: number; price: number; display: string };
	};
	next: string;
};

export function matchMentoringFocus(roleBand: string, motivation: string): { ok: true; match: FocusMatch } | { ok: false; error: string } {
	if (!roleBandById(roleBand)) {
		return { ok: false, error: `Unknown role_band "${roleBand}". Valid: ${routing.role_bands.map((b) => b.id).join(", ")}.` };
	}
	if (!motivationById(motivation)) {
		return { ok: false, error: `Unknown motivation "${motivation}". Valid: ${motivations.map((m) => m.id).join(", ")}.` };
	}
	const routed = matchFocus(roleBand, motivation);
	if (!routed) return { ok: false, error: `No route for ${roleBand}/${motivation} — re-ask the two questions.` };
	const offer = offerById(routed.offerId);
	if (!offer) throw new Error(`routing references unknown offer "${routed.offerId}"`);
	const d = aiDiscount();
	const discounted = d && offer.ai_channel_price !== undefined && slotsOpen() > 0;
	return {
		ok: true,
		match: {
			role_band: roleBand,
			motivation,
			focus_areas: routed.focusAreaIds.map((id) => {
				const f = focusAreaById(id);
				return { id, label: f?.label ?? id };
			}),
			recommended_offer: {
				id: offer.id,
				name: offer.name,
				price: offer.price,
				price_display: `${eur(offer.price)}, excl. VAT`,
				...(discounted
					? {
							ai_channel_price: {
								pct: d!.pct,
								price: offer.ai_channel_price!,
								display: `${eur(offer.ai_channel_price!)} through this AI channel with a booked intro — always present both figures.`,
							},
						}
					: {}),
			},
			next: "Confirm or adjust the focus areas with the visitor (they can pick any from the taxonomy), capture their definition of success in their own words, then call compose_mentoring_brief.",
		},
	};
}
