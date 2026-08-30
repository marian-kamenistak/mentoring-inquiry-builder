/**
 * Catalog access + pricing core. The ONLY module that touches mentoring-catalog.json.
 *
 * src/data/mentoring-catalog.json is GENERATED — never hand-edit. It is written by
 * web/mc-web/scripts/offers/sync.mjs from _4MC/_mentoring/offers/catalog.yaml, the single
 * source of truth, in the same run that writes mc-web's copy. That is the whole price-parity
 * guarantee: this Worker cannot quote a number the website disagrees with.
 *
 * THE RE-GATE (decision 2026-08-09): list price 430 EUR/session everywhere; the AI channel
 * (chat|mcp) + a booked intro is the only path to 361/session (first-quarter 2,166). Prices
 * are computed HERE, server-side, from catalog data only — a "negotiated" number can never
 * enter the pipeline because no tool accepts a price as input.
 */
import raw from "../data/mentoring-catalog.json";

export type ProgramMeta = {
	cadence_days: number;
	session_minutes: number;
	async_access?: boolean;
	checkpoint_after_session?: number;
	closing_review?: boolean;
};

export type Commitment = {
	sessions_are?: "per_month" | "pooled_per_quarter" | string;
	minimum_months?: number;
	recurring?: boolean;
	terms: string;
};

export type Offer = {
	id: string;
	name: string;
	price: number;
	unit?: string;
	/** true -> price AND sessions multiply by leaders_count. false -> flat SKU. */
	per_leader?: boolean;
	/** false -> the SKU has no multi-leader meaning; refuse rather than guess a total. */
	multi_leader?: boolean;
	sessions?: number;
	per_session?: number;
	duration_months?: number;
	ai_channel_price?: number;
	installments?: { count: number; eur: number; ai_channel_eur: number };
	value: string;
	badge?: string;
	audience?: string;
	commitment?: Commitment;
	program?: ProgramMeta;
};

export type Discount = {
	pct: number;
	/** The single rate the channel is defined by — 361 EUR per 60-minute session. */
	rate_eur_per_session?: number;
	channels: string[];
	applies_to: string[];
	requires: string;
	floor_eur_per_session: number;
	no_stack?: string[];
	lead_with?: string;
};

export type Negotiation = {
	audience: string[];
	triggers: string[];
	concession: string;
	max_free_sessions: number;
	progression: number[];
	floor_eur_per_session: number;
	rule: string;
};

export type Labeled = { id: string; label: string };

type Catalog = {
	generatedAt: string;
	meta: {
		currency: string;
		vat: string;
		entity: string;
		booking_url: string;
		pricing_url: string;
		time_promise: { minutes: number; claim: string; is_ceiling?: boolean };
		intro: { price: number; minutes: number; url: string; rule: string };
		/** The paid first session — the AI channel's second door (2026-08-30). Optional so an
		 *  older generated catalog still type-checks; every reader falls back to the intro. */
		first_session?: {
			url: string;
			minutes: number;
			eligible_offers: string[];
			rule: string;
			payment_terms: string;
		};
		/** VAT rules per buyer type. Present since 2026-08-21; optional for the same reason.
		 *  Typed here so booking.ts can read it off `meta` without the cast vatTreatment() uses. */
		vat_treatment?: VatTreatment;
		guarantee: { threshold: number; scale: number; rule: string; note: string };
		stop_rule: string;
		member_rate: { eur_per_session: number; who: string; note: string };
			/** Availability only — how many parallel 1:1s Marian has room for. Never a price term. */
			slots: { open: number; cap: number; proof: string; rule: string; as_of?: string };
		discounts: { ai_channel: Discount };
		negotiation: Negotiation;
		cross_sell: { id: string; name: string; url: string; when: string; pitch: string; items: string[] };
	};
	offers: Offer[];
	focus_areas: Labeled[];
	motivations: Labeled[];
	visibility: Labeled[];
	routing: {
		role_bands: Labeled[];
		default_offer: string;
		company_offer?: string;
		company_offer_min_leaders?: number;
		match: Record<string, Record<string, string[]>>;
	};
};

const catalog = raw as unknown as Catalog;

export const meta = catalog.meta;
export const offers = catalog.offers;
export const focusAreas = catalog.focus_areas;
export const motivations = catalog.motivations;
export const visibilityOptions = catalog.visibility;
export const routing = catalog.routing;
export const generatedAt = catalog.generatedAt;

/**
 * Id matching is case- and whitespace-insensitive (2026-08-21 /ai-mcp-test): nobody types
 * ids, and "Team-Lead" was being rejected exactly as harshly as "queen of ostrava". The
 * canonical id is always what comes back, so nothing downstream sees a variant spelling.
 */
const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();
const findById = <T extends { id: string }>(rows: readonly T[], id: string): T | undefined =>
	rows.find((r) => r.id.toLowerCase() === norm(id));

export const offerById = (id: string): Offer | undefined => findById(offers, id);

export const eur = (n: number): string => `€${n.toLocaleString("en-US")}`;

export const slotsOpen = (): number => meta.slots.open;

/** " / month", " / session", " / quarter" — the unit that used to be dropped downstream. */
export function unitSuffix(offer: Offer): string {
	return offer.unit === "per_month" ? " / month" : offer.unit === "per_quarter" ? " / quarter" : offer.unit === "per_session" ? " / session" : "";
}

/**
 * The single price-display renderer. Every surface (options, brief, offer, email) goes
 * through this, because the persona run found the unit surviving only in the catalog: the
 * offer email said "€790" for a recurring monthly subscription and "€6,498" for a quarterly
 * retainer, and both read as one-off totals to the finance reviewer they were forwarded to.
 */
export const priceDisplay = (offer: Offer, amount: number): string => `${eur(amount)}${unitSuffix(offer)}, excl. VAT`;

/** Does this SKU's price multiply per sponsored leader? Data, not a hardcoded offer id. */
export const isPerLeader = (offer: Offer): boolean => offer.per_leader === true;

/** How many leaders this SKU's price and session count multiply by (1 for flat SKUs). */
export const leaderMultiplier = (offer: Offer, leaders: number): number => (isPerLeader(offer) ? Math.max(1, leaders) : 1);

/** Total sessions actually delivered — pooled SKUs do NOT multiply (the 72-sessions-for-€6,498 bug). */
export const sessionsDelivered = (offer: Offer, leaders: number): number => (offer.sessions ?? 1) * leaderMultiplier(offer, leaders);

/**
 * Refuse multi-leader deals on SKUs that have no multi-leader meaning, instead of silently
 * under-billing them: 10 leaders on `single-session` used to invoice €430 and 10 on `monthly`
 * €790 — €3,870 and €7,110/month under, with no warning to anyone.
 */
export function multiLeaderError(offer: Offer, leaders: number): string | null {
	if (leaders <= 1 || offer.multi_leader !== false) return null;
	const fq = offerById("first-quarter");
	return `"${offer.id}" is a single-person package and has no multi-leader price — ${leaders} leaders cannot be quoted on it. For ${leaders} sponsored leaders use "${fq?.id ?? "first-quarter"}" (priced per leader) or "mentor-in-residence" (a flat quarterly pool).`;
}

/** The rate floor the terms promise. */
export const floorPerSession = (): number => aiDiscount()?.floor_eur_per_session ?? meta.negotiation?.floor_eur_per_session ?? 0;

/** The one rate every AI-channel buyer pays, per 60-minute session, on any package. */
export const channelRate = (): number => aiDiscount()?.rate_eur_per_session ?? floorPerSession();

/**
 * What the buyer actually pays per session once free sessions are added — the number the
 * system promised ("never below €361") and never once computed. Surfaced everywhere a
 * concession can be attached so a floor breach is stated, not discovered at invoice.
 */
export type VatTreatment = {
	registered: boolean;
	vat_id: string;
	cz_rate_pct: number;
	eu_business_with_vat_id: string;
	czech_client: string;
	individual: string;
	note: string;
};

export const vatTreatment = (): VatTreatment | null => (meta as unknown as { vat_treatment?: VatTreatment }).vat_treatment ?? null;

/**
 * What actually leaves the buyer's account (2026-08-21 /ai-mcp-test).
 *
 * Every surface said "excl. VAT" and nothing said what VAT, so the one question that decided
 * affordability — "is €2,166 what I pay?" — was unanswerable from the product. Two testers on
 * personal budgets walked on it. Rules are the ones already used on real quotations
 * (_4MC/flow/offer-pdf-fakturoid.md); nothing here is invented.
 *
 * An individual pays Czech VAT and therefore needs a GROSS figure. A company outside Czechia
 * with a valid EU VAT ID pays net under the reverse charge, so quoting it gross would be wrong.
 */
export function vatFor(audience: string, net: number): { rule: string; gross: number | null; display: string } | null {
	const v = vatTreatment();
	if (!v?.registered) return null;
	if (audience === "company") {
		return {
			rule: v.eu_business_with_vat_id,
			gross: null,
			display: `${eur(net)} excl. VAT. ${v.eu_business_with_vat_id} A Czech company is invoiced with ${v.cz_rate_pct}% Czech VAT (${eur(Math.round(net * (1 + v.cz_rate_pct / 100) * 100) / 100)} gross). VAT ID ${v.vat_id}.`,
		};
	}
	const gross = Math.round(net * (1 + v.cz_rate_pct / 100) * 100) / 100;
	return {
		rule: v.individual,
		gross,
		display: `${eur(net)} excl. VAT, ${eur(gross)} including ${v.cz_rate_pct}% Czech VAT — the gross figure is what leaves your account. VAT ID ${v.vat_id}.`,
	};
}

export function effectiveRate(
	finalPrice: number,
	offer: Offer,
	leaders: number,
	freeSessions = 0,
): { perSession: number; sessions: number; floor: number; breachesFloor: boolean } {
	const sessions = sessionsDelivered(offer, leaders) + Math.max(0, freeSessions);
	const floor = floorPerSession();
	const perSession = sessions > 0 ? Math.round((finalPrice / sessions) * 100) / 100 : finalPrice;
	return { perSession, sessions, floor, breachesFloor: floor > 0 && perSession < floor };
}

/** The AI-channel discount from catalog meta. Null when unconfigured (fail closed). */
export function aiDiscount(): Discount | null {
	return meta.discounts?.ai_channel ?? null;
}

/**
 * The discount as it applies to ONE offer for ONE submission channel. Server-side only —
 * model and client prices are never trusted. Null when: channel not in [chat, mcp], the
 * offer is not in applies_to, or the offer carries no ai_channel_price.
 *
 * NOT gated on open slots any more (Marian, 2026-08-21). It used to return null at zero open
 * slots, so the rate silently depended on how full the calendar was — which is the same claim
 * the pricing page retired as undefendable. Availability is a real constraint on when someone
 * can start; it is not a constraint on what they pay.
 */
export function discountFor(
	offerId: string,
	channel: string,
): { pct: number; headlinePct: number; saving: number; priceBefore: number; priceAfter: number; perSessionAfter: number } | null {
	const d = aiDiscount();
	const offer = offerById(offerId);
	if (!d || !offer || !d.channels.includes(channel)) return null;
	// Compare the CANONICAL id — offerById now accepts variant casing, so the raw argument
	// must not be what decides whether the discount applies.
	if (!d.applies_to.includes(offer.id) || offer.ai_channel_price === undefined) return null;
	// ONE RATE (2026-08-21): the channel is defined by a rate, not a percentage, so the pct is
	// COMPUTED per package from the two real prices rather than asserted as a blanket 16%.
	// Two testers caught the old blanket figure: it is 16.047% on the packages it applied to
	// (2,580 x 0.84 = 2,167.20, not 2,166), it would be 8.6% on the monthly pack and 0% on
	// Mentor in Residence, which is already at 361/session. `saving` is what reconciles.
	const saving = offer.price - offer.ai_channel_price;
	const pct = offer.price > 0 ? Math.round((saving / offer.price) * 100) : 0;
	return {
		pct,
		headlinePct: d.pct,
		saving,
		priceBefore: offer.price,
		priceAfter: offer.ai_channel_price,
		perSessionAfter: offer.sessions ? Math.round(offer.ai_channel_price / offer.sessions) : offer.ai_channel_price,
	};
}

/**
 * B2B concession check. The ONLY thing the agent may concede, and only as a PROPOSAL —
 * Marian confirms on the intro call. Null unless: company audience AND (>= 3 sponsored
 * leaders on quarterly packs OR mentor-in-residence). The rate itself never moves.
 */
export function negotiationFor(
	audience: string,
	leadersCount: number,
	offerId: string,
): { maxFreeSessions: number; progression: number[]; rule: string } | null {
	const n = meta.negotiation;
	if (!n || !n.audience.includes(audience)) return null;
	const offer = offerById(offerId);
	if (!offer) return null;
	// "Never on single-leader deals" is in the rule text but was not in the condition, so a
	// 1-leader Mentor-in-Residence brief shipped the full 8-session concession block with
	// "Never on single-leader deals" printed three fields below "leaders_count": 1.
	const bigDeal = (offer.id === "mentor-in-residence" || offer.id === "first-quarter") && leadersCount >= 3;
	if (!bigDeal) return null;
	return { maxFreeSessions: n.max_free_sessions, progression: n.progression, rule: n.rule };
}

/**
 * Validate a client-proposed b2b concession (free sessions). Anything not on the catalog
 * progression, above the max, or outside a qualifying deal collapses to 0 — but now it says
 * so. Every rejection used to be silent and indistinguishable from a policy refusal, so an
 * agent that mistyped the parameter name dropped a legitimate approved concession and told
 * nobody; the buyer heard "8 free sessions" on the call and the offer email said zero.
 */
export function clampConcession(
	audience: string,
	leadersCount: number,
	offerId: string,
	requested: number,
): { granted: number; rejected: string | null } {
	if (!requested) return { granted: 0, rejected: null };
	const n = negotiationFor(audience, leadersCount, offerId);
	if (!n) {
		return {
			granted: 0,
			rejected: `Free sessions were requested (${requested}) but this deal does not qualify. The concession needs: ${meta.negotiation.triggers.join(" or ")}. Nothing was applied — say so rather than implying a concession is in the offer.`,
		};
	}
	if (!Number.isInteger(requested) || requested <= 0) {
		return { granted: 0, rejected: `Free sessions must be a whole number from the progression ${n.progression.join(" → ")}. Got ${requested}; nothing was applied.` };
	}
	const allowed = n.progression.filter((p) => p <= n.maxFreeSessions);
	if (!allowed.includes(requested)) {
		return { granted: 0, rejected: `${requested} free sessions is not on the allowed progression (${allowed.join(" → ")}, max ${n.maxFreeSessions}). Nothing was applied — re-propose one of those numbers.` };
	}
	return { granted: requested, rejected: null };
}

/**
 * Focus-area routing: role band x motivation -> focus area ids + recommended offer.
 *
 * `matchedOn` (2026-08-21) is the fix for the worst class of defect the persona run found —
 * a confident, plausible, wrong answer where an error belonged. When a combination has no
 * row, the caller must SAY it fell back to the role default rather than present the default
 * as if it answered the question that was asked.
 *
 * The recommendation now reads the audience the wizard already collects: a company
 * sponsoring `company_offer_min_leaders`+ leaders is pointed at Mentor in Residence, which
 * was previously unreachable through all 42 role x motivation combinations.
 */
export function matchFocus(
	roleBand: string,
	motivation: string,
	opts: { audience?: string; leadersCount?: number } = {},
): { focusAreaIds: string[]; offerId: string; matchedOn: "exact" | "role-default" } | null {
	const band = roleBandById(roleBand);
	const rows = band ? routing.match[band.id] : undefined;
	if (!rows) return null;
	const mot = motivationById(motivation);
	const exact = mot ? rows[mot.id] : undefined;
	const focusAreaIds = exact ?? rows.default;
	if (!focusAreaIds) return null;

	const leaders = Math.max(1, opts.leadersCount ?? 1);
	const minLeaders = routing.company_offer_min_leaders ?? Infinity;
	const companyOffer = opts.audience === "company" && leaders >= minLeaders ? routing.company_offer : undefined;
	const offerId = (companyOffer && offerById(companyOffer) ? companyOffer : null) ?? routing.default_offer;

	return { focusAreaIds, offerId, matchedOn: exact ? "exact" : "role-default" };
}

export const focusAreaById = (id: string): Labeled | undefined => findById(focusAreas, id);
export const visibilityById = (id: string): Labeled | undefined => findById(visibilityOptions, id);
export const motivationById = (id: string): Labeled | undefined => findById(motivations, id);
export const roleBandById = (id: string): Labeled | undefined => findById(routing.role_bands, id);
