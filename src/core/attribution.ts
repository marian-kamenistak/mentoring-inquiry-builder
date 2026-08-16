// Server-side reader for the first-party attribution cookie written by Tracking.astro.
// MIRRORED (keep identical) in mc-web's src/utils/attribution.ts — two repos, no shared
// package; the cookie format is the contract.
export const ATTR_COOKIE = "mc_attr";

export type TouchData = {
	at: string; url: string; ref?: string;
	src?: string; med?: string; cmp?: string; cnt?: string; term?: string;
	gclid?: string; gbraid?: string; wbraid?: string; fbclid?: string; li_fat_id?: string; msclkid?: string; ttclid?: string;
};
export type Attribution = { v: 1; first: TouchData; last: TouchData; ga_cid?: string };

export function parseAttributionCookie(cookieHeader: string | null): Attribution | null {
	if (!cookieHeader) return null;
	const m = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${ATTR_COOKIE}=`));
	if (!m) return null;
	try {
		const a = JSON.parse(decodeURIComponent(m.slice(ATTR_COOKIE.length + 1)));
		if (!a || a.v !== 1 || typeof a.first?.url !== "string" || typeof a.last?.url !== "string") return null;
		return a as Attribution;
	} catch { return null; }
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
