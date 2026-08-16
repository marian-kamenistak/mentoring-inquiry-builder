import { describe, expect, it } from "vitest";
import { isCancellationPayload, ga4CallBookedBody } from "../src/hooks";

describe("booking-hook helpers", () => {
	it("detects cancellations without flipping bookings", () => {
		expect(isCancellationPayload('{"type":"event.canceled","email":"a@b.c"}')).toBe(true);
		expect(isCancellationPayload('{"type":"event.created","email":"a@b.c"}')).toBe(false);
		expect(isCancellationPayload("Attendee declined the invitation")).toBe(true);
	});
	it("builds a GA4 MP body with a stable fallback client id", () => {
		const b: any = ga4CallBookedBody("123.456", { campaign: "paid-a-cto" });
		expect(b.client_id).toBe("123.456");
		expect(b.events[0].name).toBe("call_booked");
		expect(b.events[0].params.campaign).toBe("paid-a-cto");
	});
});
