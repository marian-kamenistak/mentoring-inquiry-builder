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

export type Offer = {
	id: string;
	name: string;
	price: number;
	unit?: string;
	sessions?: number;
	per_session?: number;
	duration_months?: number;
	ai_channel_price?: number;
	installments?: { count: number; eur: number; ai_channel_eur: number };
	value: string;
	badge?: string;
	audience?: string;
	program?: ProgramMeta;
};

export type Discount = {
	pct: number;
	channels: string[];
	applies_to: string[];
	requires: string;
	slots_limited?: boolean;
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
		guarantee: { threshold: number; scale: number; rule: string; note: string };
		stop_rule: string;
		member_rate: { eur_per_session: number; who: string; note: string };
		slots: { open: number; cap: number; proof: string; rule: string; claim_cap: number };
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

export const offerById = (id: string): Offer | undefined => offers.find((o) => o.id === id);

export const eur = (n: number): string => `€${n.toLocaleString("en-US")}`;

export const slotsOpen = (): number => meta.slots.open;

/** The publicly stated claim cap: "the first N people only". Enforced by Marian at confirmation. */
export const claimCap = (): number => meta.slots.claim_cap ?? meta.slots.open;

/** The AI-channel discount from catalog meta. Null when unconfigured (fail closed). */
export function aiDiscount(): Discount | null {
	return meta.discounts?.ai_channel ?? null;
}

/**
 * The discount as it applies to ONE offer for ONE submission channel. Server-side only —
 * model and client prices are never trusted. Null when: channel not in [chat, mcp], the
 * offer is not in applies_to, the offer carries no ai_channel_price, or the slots are gone
 * (slot-limited scarcity is real: at 0 open slots the discount stops existing server-side
 * and the wizard routes to the slot-ping waitlist instead).
 */
export function discountFor(
	offerId: string,
	channel: string,
): { pct: number; priceBefore: number; priceAfter: number; perSessionAfter: number } | null {
	const d = aiDiscount();
	const offer = offerById(offerId);
	if (!d || !offer || !d.channels.includes(channel)) return null;
	if (!d.applies_to.includes(offerId) || offer.ai_channel_price === undefined) return null;
	if (d.slots_limited && slotsOpen() <= 0) return null;
	return {
		pct: d.pct,
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
	const bigDeal = offerId === "mentor-in-residence" || (offerId === "first-quarter" && leadersCount >= 3);
	if (!bigDeal) return null;
	return { maxFreeSessions: n.max_free_sessions, progression: n.progression, rule: n.rule };
}

/**
 * Validate a client-proposed b2b concession (free sessions). Anything not on the catalog
 * progression, above the max, or outside a qualifying deal collapses to 0.
 */
export function clampConcession(audience: string, leadersCount: number, offerId: string, requested: number): number {
	const n = negotiationFor(audience, leadersCount, offerId);
	if (!n || !Number.isInteger(requested) || requested <= 0) return 0;
	const allowed = n.progression.filter((p) => p <= n.maxFreeSessions);
	return allowed.includes(requested) ? requested : 0;
}

/** Focus-area routing: role band x motivation -> focus area ids + recommended offer. */
export function matchFocus(roleBand: string, motivation: string): { focusAreaIds: string[]; offerId: string } | null {
	const rows = routing.match[roleBand];
	if (!rows) return null;
	const focusAreaIds = rows[motivation] ?? rows.default;
	if (!focusAreaIds) return null;
	return { focusAreaIds, offerId: routing.default_offer };
}

export const focusAreaById = (id: string): Labeled | undefined => focusAreas.find((f) => f.id === id);
export const visibilityById = (id: string): Labeled | undefined => visibilityOptions.find((v) => v.id === id);
export const motivationById = (id: string): Labeled | undefined => motivations.find((m) => m.id === id);
export const roleBandById = (id: string): Labeled | undefined => routing.role_bands.find((b) => b.id === id);
