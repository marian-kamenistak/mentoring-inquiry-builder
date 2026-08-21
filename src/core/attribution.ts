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
