import { describe, expect, it } from "vitest";
import { isCancellationPayload, ga4CallBookedBody, extractHeardFrom, shouldFireCallBooked } from "../src/hooks";

// Shape of a real Attio list-entry read: entry_values.<slug>[0].option.title for a select.
const entryAtStage = (title: string) => ({
	entry_id: "e1",
	list_api_slug: "mentoring_pipeline",
	entry_values: { stage: [{ option: { title } }] },
});

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
	it("fires call_booked only on the transition into Intro call", () => {
		expect(shouldFireCallBooked(null)).toBe(true);
		expect(shouldFireCallBooked(undefined)).toBe(true);
		expect(shouldFireCallBooked(entryAtStage("Lead"))).toBe(true);
		expect(shouldFireCallBooked(entryAtStage("Intro call"))).toBe(false);
		// Unknown shape (entry_values missing) fails open — better a duplicate than a lost conversion.
		expect(shouldFireCallBooked({ entry_id: "e1" })).toBe(true);
	});
});
