import { describe, it, expect } from "vitest";
import { parseAttributionCookie, firstTouchValues, isMenteeLeadSource, laneFromCampaign, ATTR_COOKIE } from "../src/core/attribution";

const sample = {
	v: 1,
	first: { at: "2026-08-16T10:00:00.000Z", url: "/new-cto-first-90-days/?utm_source=linkedin&utm_campaign=paid-a-cto&li_fat_id=abc", ref: "linkedin.com", src: "linkedin", med: "paid-social", cmp: "paid-a-cto", li_fat_id: "abc" },
	last: { at: "2026-08-17T10:00:00.000Z", url: "/pricing/?gclid=xyz", src: "google", med: "cpc", cmp: "paid-c-em", gclid: "xyz" },
	ga_cid: "123.456",
};
const header = `foo=bar; ${ATTR_COOKIE}=${encodeURIComponent(JSON.stringify(sample))}; ph_x=1`;

describe("parseAttributionCookie", () => {
	it("returns null on missing/garbage", () => {
		expect(parseAttributionCookie(null)).toBeNull();
		expect(parseAttributionCookie("a=b")).toBeNull();
		expect(parseAttributionCookie(`${ATTR_COOKIE}=%7Bnot-json`)).toBeNull();
	});
	it("parses a valid cookie", () => {
		const a = parseAttributionCookie(header)!;
		expect(a.first.cmp).toBe("paid-a-cto");
		expect(a.last.gclid).toBe("xyz");
		expect(a.ga_cid).toBe("123.456");
	});
	it("rejects wrong version", () => {
		expect(parseAttributionCookie(`${ATTR_COOKIE}=${encodeURIComponent(JSON.stringify({ ...sample, v: 2 }))}`)).toBeNull();
	});
});

describe("firstTouchValues", () => {
	it("maps first touch to Attio slugs and carries click ids from first OR last", () => {
		const v = firstTouchValues(parseAttributionCookie(header)!);
		expect(v).toMatchObject({
			first_touch_source: "linkedin", first_touch_medium: "paid-social", first_touch_campaign: "paid-a-cto",
			first_touch_url: sample.first.url, first_touch_referrer: "linkedin.com", first_touch_at: sample.first.at,
			li_fat_id: "abc", gclid: "xyz", ga_client_id: "123.456",
		});
		expect(Object.keys(v)).not.toContain("fbclid");
	});
});

describe("isMenteeLeadSource / laneFromCampaign", () => {
	it("blog subscribers are not mentee leads", () => {
		expect(isMenteeLeadSource("blog-index")).toBe(false);
		expect(isMenteeLeadSource("coaching-cost-calculator")).toBe(true);
	});
	it("lane from utm_campaign", () => {
		expect(laneFromCampaign("paid-a-cto")).toBe("A · First-time CTO");
		expect(laneFromCampaign("paid-d-mir")).toBe("D · MiR");
		expect(laneFromCampaign("c1-cz")).toBeNull();
		expect(laneFromCampaign(undefined)).toBeNull();
	});
});
