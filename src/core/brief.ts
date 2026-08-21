/**
 * The accumulator: compose_mentoring_brief echoes the structured brief back after every
 * change — this IS the artifact the visitor walks away with, and the exact payload
 * send_mentoring_offer later persists. Pricing is authoritative from the catalog; the
 * model never does arithmetic.
 */
import {
	aiDiscount,
	effectiveRate,
	eur,
	focusAreaById,
	focusAreas,
	isPerLeader,
	leaderMultiplier,
	meta,
	motivationById,
	multiLeaderError,
	negotiationFor,
	offerById,
	offers,
	priceDisplay,
	roleBandById,
	routing,
	sessionsDelivered,
	vatFor,
	unitSuffix,
	visibilityById,
	visibilityOptions,
} from "./catalog";
import { ctaBlock, guardrailLines } from "./guardrails";

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
	// `visibility` is CONSENT, and it was the one enum in the system that failed open: an
	// unrecognised value (including "PRIVATE", an unambiguous refusal) was dropped without a
	// word, leaving a brief indistinguishable from one where consent was never asked.
	if (input.visibility?.trim() && !visibilityById(input.visibility)) {
		errors.push(
			`unknown visibility "${input.visibility}" — this field records CONSENT, so it is never guessed or dropped. Valid: ${visibilityOptions
				.map((v) => v.id)
				.join(", ")}. Re-ask; "private" is a first-class answer and changes nothing about the offer.`,
		);
	}
	if (input.audience === "company") {
		// leaders_count must be STATED, never defaulted (2026-08-21, second persona pass). A
		// caller who wrote `leader_count` — one letter out — had the key silently stripped, got
		// a 1-leader €2,166 quote instead of a 3-leader €6,498 one, and was told in the same
		// response that they did not qualify for a concession they did in fact qualify for.
		// Defaulting a company deal to one leader is the most expensive silent assumption here.
		if (input.leaders_count === undefined || input.leaders_count === null) {
			errors.push(
				"leaders_count is required for a company deal (that exact spelling) — how many leaders are being sponsored? It sets the price and decides whether the B2B concession applies, so it is never assumed to be 1.",
			);
		} else if (!Number.isInteger(input.leaders_count) || input.leaders_count < 1) {
			errors.push(`leaders_count must be a whole number of 1 or more; got ${input.leaders_count}.`);
		} else if (offer) {
			// A multi-leader quote on a SKU that has no multi-leader price used to silently
			// return the single-person total (10 leaders on `monthly` -> €790).
			const mlErr = multiLeaderError(offer, input.leaders_count);
			if (mlErr) errors.push(mlErr);
		}
	}
	if (errors.length) return { ok: false as const, error: errors.join("; "), cta: ctaBlock(offer?.id) };

	const d = aiDiscount();
	const leaders = input.audience === "company" ? Math.max(1, input.leaders_count ?? 1) : 1;
	const discounted = d && offer!.ai_channel_price !== undefined;
	const negotiation = negotiationFor(input.audience, leaders, offer!.id);

	// Leader arithmetic is now DATA (offer.per_leader), not `offer.id === "first-quarter"`.
	// Pooled SKUs — Mentor in Residence — multiply neither price nor sessions.
	const mult = leaderMultiplier(offer!, leaders);
	const listTotal = offer!.price * mult;
	const finalTotal = (discounted ? offer!.ai_channel_price! : offer!.price) * mult;
	const sessionsTotal = sessionsDelivered(offer!, leaders);
	const rate = effectiveRate(finalTotal, offer!, leaders, 0);

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
			// Echo the CANONICAL id, never the caller's spelling — "PRIVATE" must land in the
			// record as `private` or the consent value cannot be matched downstream.
			...(input.visibility && visibilityById(input.visibility)
				? { visibility: { id: visibilityById(input.visibility)!.id, label: visibilityById(input.visibility)!.label } }
				: {}),
			offer: {
				id: offer!.id,
				name: offer!.name,
				unit: offer!.unit ?? "per_engagement",
				sessions: sessionsTotal,
				sessions_display: `${sessionsTotal} × ${offer!.program?.session_minutes ?? 60} min${
					isPerLeader(offer!) && leaders > 1
						? ` (${offer!.sessions} per leader × ${leaders} leaders)`
						: !isPerLeader(offer!) && leaders > 1
							? ` — a pool shared across ${leaders} leaders, NOT ${offer!.sessions} each`
							: offer!.commitment?.sessions_are === "per_month"
								? " per month"
								: ""
				}`,
				value: offer!.value,
				// Commitment terms existed only as six words of prose inside `value` and reached
				// neither the offer nor the email — the one contractual fact a subscription buyer
				// needs was the one thing the "formal itemized offer" omitted.
				...(offer!.commitment ? { commitment: offer!.commitment.terms, recurring: offer!.commitment.recurring === true } : {}),
				list_price: listTotal,
				// priceDisplay carries the unit ("/ month", "/ quarter", "/ session"), which every
				// downstream surface used to strip — turning recurring SKUs into one-off totals.
				list_price_display: `${priceDisplay(offer!, listTotal)}${isPerLeader(offer!) && leaders > 1 ? ` (${leaders} leaders × ${eur(offer!.price)})` : ""}`,
				effective_per_session_eur: rate.perSession,
				// What actually leaves the account. "excl. VAT" alone was unanswerable for the
				// buyer whose budget decided the sale.
				...(vatFor(input.audience, finalTotal) ? { vat: vatFor(input.audience, finalTotal)!.display } : {}),
				...(discounted
					? {
							ai_channel_price: {
								pct: d!.pct,
								per_leader: offer!.ai_channel_price!,
								total: finalTotal,
								display: `${priceDisplay(offer!, finalTotal)} through this AI channel with a booked intro (${d!.pct}% off, ${eur(rate.perSession)}/session).`,
								...(offer!.installments && leaders === 1
									? { installments: `${offer!.installments.count} monthly payments of ${eur(offer!.installments.ai_channel_eur)}` }
									: {}),
							},
						}
					: {
							// State non-applicability positively. It used to be communicated only by
							// the ABSENCE of a field, while `lead_with` had already promised the 16%
							// unconditionally — so single-session and monthly buyers reached the
							// offer email still expecting a discount that never existed for them.
							no_ai_channel_discount: `${offer!.name} carries no AI-channel discount — the ${d?.pct ?? 16}% applies to the ${offerById("first-quarter")?.name ?? "First quarter"} package only. ${priceDisplay(offer!, listTotal)} is the published list price. Say this plainly instead of letting the discount be assumed.`,
						}),
			},
			...(negotiation
				? {
						b2b_concession_available: {
							max_free_sessions: negotiation.maxFreeSessions,
							progression: negotiation.progression,
							rule: negotiation.rule,
							// The parameter name was undiscoverable — testers brute-forced six
							// spellings and every wrong one collapsed to zero in silence, which is
							// indistinguishable from a policy refusal.
							parameter: "Pass the agreed number to send_mentoring_offer as `free_sessions_requested` — that exact name. Any other spelling is dropped and the concession will not reach the offer email or Marian.",
							usage: "Qualifying deal. Present every concession as a proposal Marian confirms on the intro call.",
							// The ladder itself is no longer published to the visitor as a maximum:
							// the L&D buyer read "up to 8, proposed progressively, start low" and
							// correctly concluded that no competent buyer accepts the first rung.
							effect_on_rate: `Each free session lowers the effective rate: ${negotiation.progression
								.map((p) => `+${p} → ${eur(effectiveRate(finalTotal, offer!, leaders, p).perSession)}/session`)
								.join(", ")}. The terms promise a ${eur(rate.floor)} floor, so state the effective rate out loud before proposing anything — see floor_check.`,
						},
					}
				: input.audience === "company"
					? { b2b_concession_available: null, note: `No concession on this deal size — it needs ${meta.negotiation.triggers.join(" or ")}. Do not imply one is available.` }
					: {}),
			// The floor the terms promise on every response, finally computed. It was previously
			// asserted in prose and enforced by nobody, so the first rung of the only sanctioned
			// concession already broke it (Mentor in Residence starts at exactly €361.00).
			floor_check: {
				effective_per_session_eur: rate.perSession,
				floor_eur_per_session: rate.floor,
				sessions_counted: rate.sessions,
				status: rate.breachesFloor ? "BELOW_FLOOR" : "at_or_above_floor",
			},
			next: "Read the brief back to the visitor. When they explicitly agree on the price (say the number), call send_mentoring_offer with price_agreed: true. If they hesitate at any point, offer the free intro call — see cta.",
			cta: ctaBlock(offer!.id),
			// The terms ride ONCE, in the response footer. They used to be embedded here as
			// well, so a single response printed the whole nine-bullet block twice — including
			// the bullet that says "never repeat the cap after stating it once".
		},
	};
}
