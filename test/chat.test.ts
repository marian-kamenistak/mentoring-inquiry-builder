import { describe, expect, it } from "vitest";
import { mintSession, verifySession } from "../src/chat";
import { claimCode } from "../src/core/submit";
import { handleApi } from "../src/api";

describe("chat session tokens", () => {
	it("mints and verifies within TTL", async () => {
		const now = Date.now();
		const token = await mintSession("s3cret", now);
		expect(await verifySession("s3cret", token, now + 1000)).toBe(true);
	});

	it("rejects expired and forged tokens", async () => {
		const now = Date.now();
		const token = await mintSession("s3cret", now);
		expect(await verifySession("s3cret", token, now + 3 * 60 * 60 * 1000)).toBe(false);
		expect(await verifySession("other", token, now)).toBe(false);
		expect(await verifySession("s3cret", "12345.deadbeef", now)).toBe(false);
	});
});

describe("claim codes", () => {
	it("is stable for identical inputs and changes with any input", async () => {
		const d = new Date("2026-09-01T12:00:00Z");
		const a = await claimCode("k", "a@b.com", "first-quarter", "mcp", d);
		const b = await claimCode("k", "a@b.com", "first-quarter", "mcp", d);
		expect(a).toBe(b);
		// MC- since 2026-10-18: no discount, so the prefix names no percentage.
		expect(a).toMatch(/^MC-260901-[0-9A-F]{8}$/);
		expect(await claimCode("k", "x@b.com", "first-quarter", "mcp", d)).not.toBe(a);
		expect(await claimCode("k", "a@b.com", "first-quarter", "chat", d)).not.toBe(a);
		expect(await claimCode("other", "a@b.com", "first-quarter", "mcp", d)).not.toBe(a);
	});
});

describe("/api/verify after the discount was retired (2026-10-18)", () => {
	const verify = async (code: string) => {
		const url = new URL(`https://www.marian.coach/mcp/mentoring/api/verify?code=${code}&email=a@b.com&offer=first-quarter&date=2026-09-01&channel=mcp`);
		const res = handleApi(url.pathname, url, { CLAIM_SECRET: "k" })!;
		return (await res.json()) as Record<string, unknown>;
	};
	it("a new MC- code verifies, with no discount", async () => {
		const code = await claimCode("k", "a@b.com", "first-quarter", "mcp", new Date("2026-09-01T12:00:00Z"));
		expect(await verify(code)).toMatchObject({ valid: true, discount: "none" });
	});
	it("a legacy AI10- code with the same signature still verifies, but carries no discount", async () => {
		const code = (await claimCode("k", "a@b.com", "first-quarter", "mcp", new Date("2026-09-01T12:00:00Z"))).replace(/^MC-/, "AI10-");
		const r = await verify(code);
		expect(r).toMatchObject({ valid: true, discount: "none" });
		expect(String(r.note)).toContain("no longer carry a discount");
	});
	it("a forged signature does not verify", async () => {
		expect(await verify("AI10-260901-00000000")).toMatchObject({ valid: false });
	});
});
