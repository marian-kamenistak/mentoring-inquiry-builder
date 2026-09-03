// Server-side reader for the first-party attribution cookie written by Tracking.astro.
// MIRRORED (keep identical) in mc-web's src/utils/attribution.ts — two repos, no shared
// package; the cookie format is the contract.
export const ATTR_COOKIE = "mc_attr";

/**
* Durable FIRST-TOUCH cookie, set server-side by POST www.marian.coach/api/attr.
*
* Why a second cookie exists. `mc_attr` is written with document.cookie, and Safari's ITP caps
* every script-written cookie at 7 days no matter what Max-Age says. Tracking.astro rewrites it on
* every pageload, so the window rolls forward — but only while the visitor keeps coming back. Seven
* days away and the first touch is gone, and their next visit re-registers them as "direct".
*
* That is precisely the pattern this business runs on: someone reads a post, thinks about it for
* three weeks, then books. The visit that converts is the one where the original source is already
* lost. So the first touch — the only part that has to survive absence — is mirrored into a cookie
* the SERVER sets. Server-set cookies are not subject to the document.cookie cap.
*
* It carries `first` only: `last` and the click IDs describe the conversion happening right now, so
* the live cookie always has them fresh and there is no reason to double the header weight.
* HttpOnly, because nothing on the client reads it — and HttpOnly puts it beyond any doubt about
* the script-written cap.
*/
export const ATTR_COOKIE_FIRST = "mc_attr_f";

export type TouchData = {
	at: string; url: string; ref?: string;
	src?: string; med?: string; cmp?: string; cnt?: string; term?: string;
	gclid?: string; gbraid?: string; wbraid?: string; fbclid?: string; li_fat_id?: string; msclkid?: string; ttclid?: string;
};
/**
 * `plan` — which pricing tier they clicked on the way to the calendar (2026-08-21).
 *
 * Top level, not inside `first`/`last`, because it describes an ACTION rather than a touch: it has
 * no `at`, no `url`, and it does not belong to a source. Optional, so an already-written cookie
 * stays valid and nothing needs a version bump. Written by mc-web's Tracking.astro; nothing in this
 * repo sets it, but the type has to accept it or the shared cookie stops round-tripping.
 */
export type Attribution = { v: 1; first: TouchData; last: TouchData; ga_cid?: string; plan?: string };

function readCookieJson(cookieHeader: string, name: string): any | null {
	const m = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
	if (!m) return null;
	try {
		return JSON.parse(decodeURIComponent(m.slice(name.length + 1)));
	} catch { return null; }
}

/** A first touch we are willing to trust: the shape parseAttributionCookie already demanded. */
function validFirst(a: any): boolean {
	return Boolean(a) && a.v === 1 && typeof a.first?.url === "string" && typeof a.first?.at === "string";
}

export function parseAttributionCookie(cookieHeader: string | null): Attribution | null {
	if (!cookieHeader) return null;
	const live = readCookieJson(cookieHeader, ATTR_COOKIE);
	const durable = readCookieJson(cookieHeader, ATTR_COOKIE_FIRST);

	const liveOk = Boolean(live) && live.v === 1 && typeof live.first?.url === "string" && typeof live.last?.url === "string";
	const durableOk = validFirst(durable);

	// The durable first touch OUTRANKS the live one whenever both exist. After the live cookie lapses
	// on Safari, the next visit writes a brand-new `first` that is really a later touch — so trusting
	// the live copy is how a 3-week-old organic search result gets relabelled "direct". The durable
	// cookie is the original and never gets overwritten (see POST www.marian.coach/api/attr).
	if (liveOk) return (durableOk ? { ...live, first: durable.first } : live) as Attribution;

	// Live cookie gone entirely but the durable one survived — still enough to attribute the
	// conversion. `last` mirrors `first` because no later touch was recorded.
	if (durableOk) return { v: 1, first: durable.first, last: durable.first } as Attribution;

	return null;
}

const CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "li_fat_id", "msclkid"] as const;

// Write-once block: whatever brought the person here the FIRST time. Never overwritten on a
// later visit, so the callers guard it with `hasFirst`.
export function firstTouchValues(a: Attribution): Record<string, string> {
	const f = a.first;
	const out: Record<string, string> = {};
	const put = (k: string, v?: string) => { if (v) out[k] = String(v).slice(0, 500); };
	put("first_touch_source", f.src); put("first_touch_medium", f.med); put("first_touch_campaign", f.cmp);
	put("first_touch_content", f.cnt); put("first_touch_url", f.url); put("first_touch_referrer", f.ref);
	put("first_touch_at", f.at);
	return out;
}

/**
 * Does this record already carry a first touch? Guards the write-once block above.
 *
 * Keyed on `first_touch_at`, NEVER on `first_touch_source`. A direct visit — address typed, untagged
 * bookmark, an app that strips the referrer — has no source, so `touch()` leaves `src` unset and
 * `put` skips the field entirely. That is the correct record of "direct" (`hooks.ts` reads the same
 * absence as `"direct"` when it builds the GA4 conversion), and it is the majority shape here.
 *
 * Reading source as the sentinel therefore made every direct visitor look permanently
 * un-attributed: the daily pipeline-health job alerted on two healthy bookings on 2026-08-30, and
 * the write-once guard re-sent `firstTouchValues` on every later submission — harmless while the
 * durable cookie survives and returns the same original, but an overwrite of the real first touch
 * once it has lapsed or the person submits from a second device. `at` and `url` are written on every
 * successful attribution, so `at` is present exactly when a first touch exists.
 *
 * Takes either shape: the flat map `firstTouchValues` returns, or an Attio `values` object.
 */
export function hasFirstTouch(values: any): boolean {
	const v = values?.first_touch_at;
	return Array.isArray(v) ? v.length > 0 : Boolean(v);
}

// Refreshed on EVERY submission, first touch or not: the click IDs an offline conversion upload
// needs, the GA4 client id, and the last touch that actually preceded this conversion.
export function refreshableValues(a: Attribution): Record<string, string> {
	const l = a.last;
	const out: Record<string, string> = {};
	const put = (k: string, v?: string) => { if (v) out[k] = String(v).slice(0, 500); };
	// Click IDs: the most recent one wins per platform — an offline conversion needs the click that
	// preceded the conversion, which is usually the last, not the first.
	for (const k of CLICK_IDS) put(k, (a.last as any)[k] ?? (a.first as any)[k]);
	put("ga_client_id", a.ga_cid);
	put("last_touch_source", l.src); put("last_touch_medium", l.med);
	put("last_touch_campaign", l.cmp); put("last_touch_at", l.at);
	// Refreshable, not write-once: someone who booked the single session in March and the quarter
	// pack in June chose the quarter pack. The latest click is the one that describes this booking.
	put("plan_clicked", a.plan);
	return out;
}

/**
 * The first touch for an inquiry that arrived through an AI assistant.
 *
 * MCP clients carry no cookie, so `submitInquiry` skipped the whole attribution block for
 * channel "mcp" and the person landed in Attio with NO first touch at all — shaped exactly like
 * a direct visit and permanently un-attributed. For an inquiry that came in through an
 * assistant the MCP endpoint really is the first touch: there is no earlier one being lost.
 *
 * `source: "mcp"` matches the `?ref=mcp` tag the web funnel already uses, so assistant traffic
 * reads as one channel whether it converted through a tool call or through the site.
 */
export const MCP_FIRST_TOUCH = {
	first_touch_source: "mcp",
	first_touch_medium: "ai_assistant",
	first_touch_campaign: "mcp-mentoring-inquiry-builder",
	first_touch_url: "https://www.marian.coach/mcp/mentoring",
} as const;

/**
 * Everything we are willing to write to the person's Attio record for THIS submission.
 *
 * Two guards, both load-bearing:
 * - The synthetic MCP touch stays behind `hasFirstTouch`, same as the cookie path. Someone who
 *   read a post in March and only asked their assistant in June keeps the March source. Writing
 *   it unconditionally is the `first_touch_source='app.reclaim.ai'` failure again: a
 *   self-referral overwriting the real origin.
 * - It is gated on `channel === "mcp"`, not merely on a missing cookie. A chat visitor who
 *   blocks cookies also arrives with `attribution` undefined, and labelling them "mcp" would
 *   invent a channel they never used.
 */
export function attributionValues(
	channel: "chat" | "mcp",
	attribution: Attribution | undefined,
	existing: any,
	now: Date,
): Record<string, string> {
	const attributed = hasFirstTouch(existing);
	if (attribution) {
		return { ...(attributed ? {} : firstTouchValues(attribution)), ...refreshableValues(attribution) };
	}
	if (channel === "mcp" && !attributed) return { ...MCP_FIRST_TOUCH, first_touch_at: now.toISOString() };
	return {};
}

export function isMenteeLeadSource(source: string): boolean {
	return !source.startsWith("blog-");
}

export function laneFromCampaign(cmp?: string) {
	if (!cmp) return null;
	if (cmp.startsWith("paid-a")) return "A · First-time CTO" as const;
	if (cmp.startsWith("paid-b")) return "B · Promotion" as const;
	if (cmp.startsWith("paid-c")) return "C · New EM" as const;
	if (cmp.startsWith("paid-d")) return "D · MiR" as const;
	return null;
}
