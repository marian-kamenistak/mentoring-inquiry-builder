/**
 * Which door a prospect leaves by, and how far a booking may move them.
 *
 * THE SECOND DOOR (Marian 2026-08-30). Until now every wizard conversation ended at the same
 * place — the free intro call — including for people who had just read the price back and said
 * yes. That is a step charged to someone who has already decided. A prospect who agrees the
 * exact price on a clean package now books a PAID first session instead and lands on
 * `mentoring_pipeline` at `formal 1st arranged`, skipping three rungs of the ladder.
 *
 * The intro is NOT retired. It stays the fallback for everyone undecided (most people), and the
 * required path for the two deal shapes whose terms the catalog says Marian confirms on a call.
 */
import { meta, offerById } from "./catalog";

/**
 * `mentoring_pipeline.mentee_stage`, in order. This is a STATUS-type attribute in Attio and the
 * only one on the list, so it drives Marian's "Mentoring flow" kanban — the titles here must
 * match Attio exactly or the whole entry write 400s (Attio rejects the request, not the field).
 * Verified against the live list 2026-08-30; mirrors agentic-os ops-newcontact/scripts/routing.py.
 */
export const STAGE_LADDER = [
	"Not yet",
	"intro arranged",
	"intro passed",
	"formal invite sent",
	"formal 1st arranged",
	"mentoring",
	"done",
] as const;

export type Stage = (typeof STAGE_LADDER)[number];

/** Position on the ladder; -1 for blank or anything Attio holds that this list does not know. */
export function stageRank(title: unknown): number {
	if (typeof title !== "string" || !title) return -1;
	const t = title.trim().toLowerCase();
	return STAGE_LADDER.findIndex((s) => s.toLowerCase() === t);
}

/**
 * May a booking move this person from `current` to `target`?
 *
 * FORWARD ONLY, and this replaces a seed-only-when-blank test that could not express the second
 * door. The old rule ("write mentee_stage only if it is still blank") was written to stop a
 * reschedule dragging an active mentee back to `intro arranged`, which it did correctly — but it
 * also meant a booking could never advance anyone who already had a stage. Two consequences:
 *
 *   - every wizard submission writes `Not yet` on create (submit.ts), so a wizard user who then
 *     booked an intro stayed on `Not yet` permanently — the stage was already non-blank;
 *   - a boost booking could not move someone off `intro arranged`, which is the entire point.
 *
 * Ranking both ends fixes all three cases with one rule: forward moves land, backward moves and
 * no-ops are skipped. An unknown current stage (rank -1) is treated as blank and may be seeded.
 */
export function canAdvance(current: unknown, target: Stage): boolean {
	return stageRank(target) > stageRank(current);
}

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

/**
 * Is this deal clean enough to close without a call?
 *
 * Data-driven off `meta.first_session.eligible_offers` rather than an `offer.id === "..."` test —
 * the catalog carries the same warning about `per_leader`, where the same hardcode produced three
 * separate billing defects before it was made data.
 *
 * The two exclusions are not arbitrary; both come from terms the catalog still states:
 *   - `monthly` — "Marian confirms the billing day on the intro call" (catalog.yaml:220)
 *   - a proposed free-sessions concession — "Proposal only. Marian confirms final terms on the
 *     intro call" (catalog.yaml:123), and the effective-rate disclosure at :132
 * `mentor-in-residence` is excluded by omission from `eligible_offers`: it is itself a listed
 * negotiation trigger, so it is never a clean self-serve close.
 */
export function firstSessionEligible(offerId: string, opts: { freeSessionsProposed?: number } = {}): Eligibility {
	const offer = offerById(offerId);
	if (!offer) return { eligible: false, reason: `unknown offer_id "${offerId}"` };

	if ((opts.freeSessionsProposed ?? 0) > 0) {
		return {
			eligible: false,
			reason: `A free-sessions concession is on the table, and the terms say that is a proposal Marian confirms on the intro call — never a settled deal. Book the free intro instead: ${meta.booking_url}`,
		};
	}

	const allowed = meta.first_session?.eligible_offers ?? [];
	if (!allowed.some((id) => id.toLowerCase() === offer.id.toLowerCase())) {
		return {
			eligible: false,
			reason: `${offer.name} is not a self-serve close — its terms are confirmed on a call before anything is invoiced. Book the free intro instead: ${meta.booking_url}`,
		};
	}

	return { eligible: true };
}

/**
 * The paid booking URL, with the claim code riding as a Reclaim attribution param.
 *
 * Reclaim forwards up to five `data-`-prefixed query params from the booking URL into the signed
 * webhook payload as `custom_data.data.<key>`, prefix stripped
 * (help.reclaim.ai/en/articles/10008727). So `?data-claim=AI16-…` gives the hook a deterministic
 * join instead of scanning a free-text booking note for a code the prospect has to remember to
 * paste — which is what the intro hook has always depended on, and the reason bookings made with
 * a different address than the offer went unmatched.
 *
 * UNVERIFIED on api_version v2026-04-13: the payload captured in _mentoring/reclaim-webhook.md
 * predates any `data-` param, so the hook keeps note-scan and email as fallbacks rather than
 * trusting this. Remove the fallbacks only once a real booking has proven custom_data arrives.
 */
export function firstSessionUrl(claimCode?: string): string {
	const base = meta.first_session?.url ?? meta.booking_url;
	if (!claimCode) return base;
	const sep = base.includes("?") ? "&" : "?";
	return `${base}${sep}data-claim=${encodeURIComponent(claimCode)}`;
}

/**
 * Read the person's pipeline stage back out of Attio.
 *
 * This is what makes "confirmed before the conversation ends" mean something. The wizard cannot
 * see Reclaim, and a visitor saying "done, I booked it" is not evidence — the only fact worth
 * reporting is that the webhook wrote the stage. So this reads the same row the webhook writes,
 * and reports what is actually there.
 *
 * Deliberately read-only and NON-CREATING: it must never mint a Person as a side effect of
 * someone mistyping their address — the same rule /api/booking-attr carries for the same reason.
 * An unknown address returns "no record", never an error.
 *
 * Every failure path returns prose telling the model NOT to report a failed booking. A CRM
 * timeout is not evidence that a booking did not happen, and the expensive mistake here is
 * telling a buyer who just paid attention that their booking did not work.
 */
export async function lookupBookingStage(env: { ATTIO_TOKEN?: string }, rawEmail: string): Promise<Record<string, unknown>> {
	const email = rawEmail.trim().toLowerCase();
	if (!env.ATTIO_TOKEN) return { booked: false, checked: false, why: "CRM lookup is not configured on this server — ask the visitor to forward the calendar invite instead of guessing." };
	if (!email.includes("@")) return { booked: false, checked: false, why: "That does not look like an email address — ask again." };
	try {
		const headers = { Authorization: `Bearer ${env.ATTIO_TOKEN}`, "content-type": "application/json" };
		const personRes = await fetch("https://api.attio.com/v2/objects/people/records/query", {
			method: "POST",
			headers,
			body: JSON.stringify({ filter: { email_addresses: email }, limit: 1 }),
		});
		if (!personRes.ok) {
			console.error("check_booking person query failed", personRes.status, await personRes.text().catch(() => ""));
			return { booked: false, checked: false, why: "The CRM did not answer. Do not tell the visitor the booking failed — it may well have worked." };
		}
		const personId: string | undefined = ((await personRes.json().catch(() => null)) as any)?.data?.[0]?.id?.record_id;
		if (!personId) return { booked: false, checked: true, stage: null, why: "No record for that address yet. If they booked seconds ago, wait and check once more; the webhook is not instant." };

		const entriesRes = await fetch(`https://api.attio.com/v2/objects/people/records/${personId}/entries?limit=100`, { headers });
		if (!entriesRes.ok) {
			console.error("check_booking entries failed", entriesRes.status, await entriesRes.text().catch(() => ""));
			return { booked: false, checked: false, why: "The CRM did not answer on the pipeline read." };
		}
		const entries: any[] = ((await entriesRes.json().catch(() => ({ data: [] }))) as any)?.data ?? [];
		const pipe = entries.find((e) => e.list_api_slug === "mentoring_pipeline");
		let stage: string | null = pipe?.entry_values?.mentee_stage?.[0]?.status?.title ?? null;
		// The memberships payload does not always carry entry_values; one GET reads the stage.
		if (pipe && !stage) {
			const one = await fetch(`https://api.attio.com/v2/lists/mentoring_pipeline/entries/${pipe.entry_id}`, { headers });
			if (one.ok) stage = ((await one.json().catch(() => null)) as any)?.data?.entry_values?.mentee_stage?.[0]?.status?.title ?? null;
		}
		const firstSessionBooked = stageRank(stage) >= stageRank("formal 1st arranged");
		const introBooked = stageRank(stage) >= stageRank("intro arranged");
		return {
			checked: true,
			stage,
			first_session_booked: firstSessionBooked,
			intro_booked: introBooked && !firstSessionBooked,
			booked: introBooked,
			what_to_say: firstSessionBooked
				? "Confirmed — the paid first session is on Marian's calendar and on the board. Say so, restate when the invoice arrives, and close the conversation."
				: introBooked
					? "Their intro call is booked, but not a paid first session. Do not describe this as the paid booking."
					: "Nothing has landed yet. Wait a few seconds and check once. If it is still empty, say plainly that you cannot see it and offer to have Marian confirm by email — never claim a booking you cannot see.",
		};
	} catch (e) {
		console.error("check_booking exception", String(e));
		return { booked: false, checked: false, why: "The CRM lookup threw. Do not report a failed booking on the strength of this." };
	}
}

/**
 * The payment terms shown at the point of booking. Stated, never collected — no billing data
 * enters the conversation (Marian, 2026-08-30). Every fact is read from the catalog; this
 * function asserts nothing of its own.
 *
 * `audience` picks which VAT sentence is true for THIS buyer. Saying only "excl. VAT" is the
 * documented failure that left two individual buyers unable to answer whether they could afford
 * the package — see meta.vat_treatment.
 */
export function paymentTerms(audience: "individual" | "company", hasEuVatId = false): {
	invoiced_by: string;
	vat: string;
	when: string;
} {
	const v = meta.vat_treatment;
	const vat = !v?.registered
		? "Prices are net."
		: audience === "individual"
			? v.individual
			: hasEuVatId
				? v.eu_business_with_vat_id
				: v.czech_client;
	return {
		invoiced_by: meta.entity,
		vat,
		when: meta.first_session?.payment_terms ?? "Invoiced by Marian after the session is booked.",
	};
}
