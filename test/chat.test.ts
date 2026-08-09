import { describe, expect, it } from "vitest";
import { mintSession, verifySession } from "../src/chat";
import { claimCode } from "../src/core/submit";

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
		expect(a).toMatch(/^AI16-260901-[0-9A-F]{8}$/);
		expect(await claimCode("k", "x@b.com", "first-quarter", "mcp", d)).not.toBe(a);
		expect(await claimCode("k", "a@b.com", "first-quarter", "chat", d)).not.toBe(a);
		expect(await claimCode("other", "a@b.com", "first-quarter", "mcp", d)).not.toBe(a);
	});
});
