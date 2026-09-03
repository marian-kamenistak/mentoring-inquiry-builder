import { describe, it, expect } from "vitest";
import { parseAttributionCookie, firstTouchValues, refreshableValues, isMenteeLeadSource, laneFromCampaign, attributionValues, ATTR_COOKIE } from "../src/core/attribution";

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
	it("maps first touch to Attio slugs and nothing else", () => {
		const v = firstTouchValues(parseAttributionCookie(header)!);
		expect(v).toMatchObject({
			first_touch_source: "linkedin", first_touch_medium: "paid-social", first_touch_campaign: "paid-a-cto",
			first_touch_url: sample.first.url, first_touch_referrer: "linkedin.com", first_touch_at: sample.first.at,
		});
		// Click ids, ga_client_id and last touch are refreshable — they must NOT ride in the
		// write-once block, or a second visit would never update them.
		for (const k of ["gclid", "li_fat_id", "fbclid", "ga_client_id", "last_touch_source", "last_touch_at"]) {
			expect(Object.keys(v)).not.toContain(k);
		}
	});
});

describe("refreshableValues", () => {
	it("carries click ids (last wins), ga client id and last touch", () => {
		const v = refreshableValues(parseAttributionCookie(header)!);
		expect(v).toMatchObject({
			li_fat_id: "abc", gclid: "xyz", ga_client_id: "123.456",
			last_touch_source: "google", last_touch_medium: "cpc", last_touch_campaign: "paid-c-em",
			last_touch_at: sample.last.at,
		});
		expect(Object.keys(v)).not.toContain("fbclid");
		expect(Object.keys(v)).not.toContain("first_touch_source");
	});
	it("last click id wins over the first for the same platform", () => {
		const both = {
			...sample,
			first: { ...sample.first, gclid: "first-click" },
			last: { ...sample.last, gclid: "last-click" },
		};
		const v = refreshableValues(parseAttributionCookie(`${ATTR_COOKIE}=${encodeURIComponent(JSON.stringify(both))}`)!);
		expect(v.gclid).toBe("last-click");
		// and a click id present only on the first touch still survives
		expect(v.li_fat_id).toBe("abc");
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

describe("attributionValues — MCP callers carry no cookie", () => {
	const NOW = new Date("2026-09-03T09:00:00.000Z");
	const attributed = { first_touch_at: ["2026-03-01T10:00:00.000Z"], first_touch_source: ["google"] };
	const cookie = parseAttributionCookie(header)!;

	it("labels an MCP inquiry from an unknown person as an MCP first touch", () => {
		const v = attributionValues("mcp", undefined, {}, NOW);
		expect(v.first_touch_source).toBe("mcp");
		expect(v.first_touch_medium).toBe("ai_assistant");
		expect(v.first_touch_url).toBe("https://www.marian.coach/mcp/mentoring");
		expect(v.first_touch_at).toBe("2026-09-03T09:00:00.000Z");
	});

	it("NEVER overwrites a real first touch — read a post in March, asked an assistant in June", () => {
		expect(attributionValues("mcp", undefined, attributed, NOW)).toEqual({});
	});

	it("does not label a cookie-less CHAT visitor as MCP", () => {
		expect(attributionValues("chat", undefined, {}, NOW)).toEqual({});
	});

	it("cookie path is unchanged: first touch written once, refreshables always", () => {
		const fresh = attributionValues("chat", cookie, {}, NOW);
		expect(fresh.first_touch_source).toBe("linkedin");
		expect(fresh.last_touch_source).toBe("google");
		const repeat = attributionValues("chat", cookie, attributed, NOW);
		expect(repeat.first_touch_source).toBeUndefined();
		expect(repeat.last_touch_source).toBe("google");
	});
});
