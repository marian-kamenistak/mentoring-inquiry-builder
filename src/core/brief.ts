/**
 * The accumulator: compose_mentoring_brief echoes the structured brief back after every
 * change — this IS the artifact the visitor walks away with, and the exact payload
 * send_mentoring_offer later persists. Pricing is authoritative from the catalog; the
 * model never does arithmetic.
 */
import {
	aiDiscount,
	eur,
	focusAreaById,
	focusAreas,
	meta,
	motivationById,
	negotiationFor,
	offerById,
	offers,
	roleBandById,
	routing,
	slotsOpen,
	visibilityById,
} from "./catalog";
import { guardrailLines } from "./guardrails";

export type BriefInput = {
	audience: "individual" | "company";
	role_band: string;
	motivation: string;
	focus_area_ids: string[];
	success_definition: string;
	offer_id: string;
	leaders_count?: number;
	company_context?: string;
	visibility?: string;
};

export function composeBrief(input: BriefInput) {
	const errors: string[] = [];
	if (!roleBandById(input.role_band)) {
		errors.push(`unknown role_band "${input.role_band}" (valid: ${routing.role_bands.map((b) => b.id).join(", ")})`);
	}
	if (!motivationById(input.motivation)) {
		errors.push(`unknown motivation "${input.motivation}"`);
	}
	const offer = offerById(input.offer_id);
	if (!offer) {
		errors.push(`unknown offer_id "${input.offer_id}" (valid: ${offers.map((o) => o.id).join(", ")})`);
	}
	if (offer?.audience === "company" && input.audience !== "company") {
		errors.push(`offer "${offer.id}" is company-only`);
	}
	const badFocus = input.focus_area_ids.filter((id) => !focusAreaById(id));
	if (badFocus.length) {
		errors.push(`unknown focus areas: ${badFocus.join(", ")} (valid: ${focusAreas.map((f) => f.id).join(", ")})`);
	}
	if (!input.focus_area_ids.length) errors.push("pick at least one focus area");
	if (!input.success_definition?.trim()) {
		errors.push("success_definition is required — capture it in the visitor's own words first");
	}
	if (errors.length) return { ok: false as const, error: errors.join("; ") };

	const d = aiDiscount();
	const open = slotsOpen();
	const leaders = input.audience === "company" ? Math.max(1, input.leaders_count ?? 1) : 1;
	const discounted = d && offer!.ai_channel_price !== undefined && open > 0;
	const negotiation = negotiationFor(input.audience, leaders, offer!.id);

	return {
		ok: true as const,
		brief: {
			audience: input.audience,
			role_band: input.role_band,
			motivation: input.motivation,
			focus_areas: input.focus_area_ids.map((id) => ({ id, label: focusAreaById(id)!.label })),
			success_definition: input.success_definition.trim(),
			...(input.audience === "company" ? { leaders_count: leaders } : {}),
			...(input.company_context?.trim() ? { company_context: input.company_context.trim() } : {}),
			...(input.visibility && visibilityById(input.visibility)
				? { visibility: { id: input.visibility, label: visibilityById(input.visibility)!.label } }
				: {}),
			offer: {
				id: offer!.id,
				name: offer!.name,
				sessions: offer!.sessions,
				value: offer!.value,
				list_price: offer!.price,
				list_price_display: `${eur(offer!.price * (offer!.id === "first-quarter" ? leaders : 1))}${leaders > 1 ? ` (${leaders} leaders × ${eur(offer!.price)})` : ""}, excl. VAT`,
				...(discounted
					? {
							ai_channel_price: {
								pct: d!.pct,
								per_leader: offer!.ai_channel_price!,
								total: offer!.ai_channel_price! * (offer!.id === "first-quarter" ? leaders : 1),
								display: `${eur(offer!.ai_channel_price! * (offer!.id === "first-quarter" ? leaders : 1))} through this AI channel with a booked intro (${d!.pct}% off, ${eur(d!.floor_eur_per_session)}/session).`,
								...(offer!.installments && leaders === 1
									? { installments: `${offer!.installments.count} monthly payments of ${eur(offer!.installments.ai_channel_eur)}` }
									: {}),
							},
						}
					: {}),
			},
			...(negotiation
				? {
						b2b_concession_available: {
							max_free_sessions: negotiation.maxFreeSessions,
							progression: negotiation.progression,
							rule: negotiation.rule,
							usage: "Qualifying deal. You may propose free sessions progressively (start low). Present every concession as a proposal Marian confirms on the intro call.",
						},
					}
				: input.audience === "company"
					? { b2b_concession_available: null, note: `No concession on this deal size — it needs ${meta.negotiation.triggers.join(" or ")}.` }
					: {}),
			slots_note:
				open > 0
					? `The first ${meta.slots.claim_cap} people get this price, which is exactly the ${open} mentee slots open right now (cap ${meta.slots.cap}).`
					: "All slots taken — route to the waitlist.",
			next: "Read the brief back to the visitor. When they explicitly agree on the price (say the number), call send_mentoring_offer with price_agreed: true.",
			guardrails: guardrailLines(),
		},
	};
}
