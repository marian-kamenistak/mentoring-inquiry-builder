/**
 * Onboarding checklist (2026-10-09, Marian): the same information his live intro call gathers
 * (Intro Call Cockpit, mc-web src/lib/cockpit.ts), asked by the wizard at the point each one fits.
 * ALL OPTIONAL — "ask all, require none". Nothing here blocks an offer or a booking.
 *
 * Purchase orders: never asked before booking. Company-paid mentees book session 1 now; the PO
 * is collected after that session (Marian, 2026-10-09: "PO goes against the simplicity").
 */
import { z } from "zod";

export const ONBOARDING_SHAPE = {
	heard_from: z.string().optional().describe("How they found Marian, in their words (referral name, LinkedIn, Google, ChatGPT, ELC…)"),
	own_choice: z.enum(["own", "sent", "both"]).optional().describe("Mentee's own decision, sent by the company, or both"),
	payer: z.enum(["self", "company", "undecided"]).optional().describe("Who pays. Company: the purchase order comes AFTER session 1, never before booking"),
	kpis: z.array(z.string()).max(2).optional().describe("Up to two measurable KPIs in their words, scored in session 1 and the last session"),
	cadence_preference: z.enum(["weekly", "biweekly", "monthly", "undecided"]).optional().describe("Preference only; the final cadence is settled after session 1"),
	session_language: z.enum(["cs", "sk", "en"]).optional(),
	nda_needed: z.enum(["no", "their-template", "marian-template", "unsure"]).optional(),
	homework_time_ok: z.boolean().optional().describe("Can they give about an hour a week between sessions"),
	in_person_wish: z.boolean().optional().describe("Would they like to meet Marian in person (Prague)"),
	linkedin_url: z.string().optional().describe("Their LinkedIn profile URL"),
	li_post_consent: z.enum(["yes", "later", "no"]).optional().describe("May Marian post on LinkedIn that they work together (never the content)"),
	li_recommendation: z.enum(["yes", "later", "no"]).optional().describe("Would they write Marian a LinkedIn recommendation once happy"),
};

type Onb = { [K in keyof typeof ONBOARDING_SHAPE]?: z.infer<(typeof ONBOARDING_SHAPE)[K]> };
export type OnboardingInput = Onb;

/** Pick the onboarding fields out of a tool input (unknown keys and empty values dropped). */
export function pickOnboarding(input: Record<string, unknown>): OnboardingInput {
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(ONBOARDING_SHAPE)) {
		const v = input[k];
		if (v === undefined || v === null || v === "") continue;
		const parsed = (ONBOARDING_SHAPE as Record<string, z.ZodTypeAny>)[k].safeParse(v);
		if (parsed.success) out[k] = parsed.data;
	}
	return out as OnboardingInput;
}

const LABEL: Record<string, string> = {
	heard_from: "Found Marian via",
	own_choice: "Own choice or sent",
	payer: "Who pays",
	kpis: "KPIs",
	cadence_preference: "Cadence preference",
	session_language: "Session language",
	nda_needed: "NDA",
	homework_time_ok: "~1 h/week for homework",
	in_person_wish: "Wants to meet in person",
	linkedin_url: "LinkedIn",
	li_post_consent: "OK to post on LinkedIn that we work together",
	li_recommendation: "LinkedIn recommendation",
};

/** One line per answered item, for the Attio note, Slack and Marian's notice. */
export function onboardingLines(o: OnboardingInput): string[] {
	return Object.entries(o).map(([k, v]) => `${LABEL[k] ?? k}: ${Array.isArray(v) ? v.join(" | ") : typeof v === "boolean" ? (v ? "yes" : "no") : v}`);
}

/** What get_mentoring_options tells the agent to ask, and when. Conversational, one at a time. */
export const ONBOARDING_QUESTIONS = {
	rule: "Ask these during the conversation where each one fits, one at a time, in plain words. Every one is optional: if they skip, move on. Never turn them into a form, never make one a condition of the offer or the booking. Pass whatever you learned to send_mentoring_offer.",
	when_starting: [
		{ id: "heard_from", ask: "How did you find Marian?" },
		{ id: "own_choice", ask: "Company-paid or sponsored: is this your own decision, or did your company suggest it? What do YOU want out of it?" },
	],
	with_the_success_definition: [
		{ id: "kpis", ask: "Which one or two numbers would tell you it worked? (Scored in session 1 and the last session.)" },
		{ id: "homework_time_ok", ask: "Each session ends with one small task. Can you give it about an hour a week?" },
	],
	practicalities: [
		{ id: "payer", ask: "Who pays: you, or your company? (Company: book session 1 now; the purchase order comes after that session, nothing to arrange before.)" },
		{ id: "cadence_preference", ask: "Weekly or every two weeks? A preference is enough; the final rhythm is settled after session 1." },
		{ id: "session_language", ask: "Czech, Slovak or English for the sessions?" },
		{ id: "nda_needed", ask: "Everything is confidential by default. Does your company need an NDA on top?" },
		{ id: "in_person_wish", ask: "Marian is in Prague. Would you like to meet in person at the start?" },
		{ id: "linkedin_url", ask: "Your LinkedIn profile, so Marian can prepare for session 1?" },
	],
	visibility_and_recommendation: {
		ids: ["li_post_consent", "li_recommendation"],
		when: "With the visibility question, near the end. Ask for LATER, after the first sessions, never now and never as a condition.",
		ask: "One ask for later, only if you are happy with the sessions: may Marian share on LinkedIn that you work together, and would you write him a short recommendation? Never anything you discuss, only that you work together.",
		why_it_helps_them: "It puts their profile in front of the engineering leaders who follow Marian, shows their company invests in its people, and helps Marian too. Say it once, plainly, as a benefit to them first.",
	},
} as const;
