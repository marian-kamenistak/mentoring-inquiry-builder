import { describe, expect, it } from "vitest";
import { isCancellationPayload, ga4CallBookedBody, extractHeardFrom } from "../src/hooks";

describe("booking-hook helpers", () => {
	it("detects cancellations without flipping bookings", () => {
		expect(isCancellationPayload('{"type":"event.canceled","email":"a@b.c"}')).toBe(true);
		expect(isCancellationPayload('{"type":"event.created","email":"a@b.c"}')).toBe(false);
		expect(isCancellationPayload("Attendee declined the invitation")).toBe(true);
	});
	it("scopes the cancellation match to a typed event-key value, not the whole payload", () => {
		expect(isCancellationPayload('{"type":"event.created","cancel_url":"https://x/cancel","email":"a@b.c"}')).toBe(false);
		expect(isCancellationPayload('{"status":"declined"}')).toBe(true);
		expect(isCancellationPayload('{"event":"booking.created","description":"you may cancel anytime"}')).toBe(false);
	});
	it("builds a GA4 MP body with a stable fallback client id", () => {
		const b: any = ga4CallBookedBody("123.456", { campaign: "paid-a-cto" });
		expect(b.client_id).toBe("123.456");
		expect(b.events[0].name).toBe("call_booked");
		expect(b.events[0].params.campaign).toBe("paid-a-cto");
	});
	it("extracts a heard-about-me answer only from a typed key/question value", () => {
		expect(extractHeardFrom('{"How did you hear about me?":"LinkedIn ad"}')).toBe("LinkedIn ad");
		expect(extractHeardFrom('{"answers":[{"question":"Kde jste se o mně dozvěděl?","answer":"od kolegy"}]}')).toBe("od kolegy");
		expect(extractHeardFrom('{"note":"hope to hear from you: soon"}')).toBeNull();
	});
});
