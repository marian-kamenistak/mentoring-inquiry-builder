/**
 * Plain-REST layer over the same tool core: reaches non-MCP consumers and the OpenAPI spec
 * unlocks docs-generated tooling plus API-directory listings. Near-zero marginal cost.
 *
 * Read-only BY DESIGN: offer submission stays on the MCP tool and the chat backend, where
 * rate limiting and the Turnstile/session gate live.
 *
 * /verify is the claim-code audit endpoint: recomputes the HMAC server-side so Marian can
 * check any emailed code at invoice time even if the Attio write ever failed. Read-only,
 * no secret exposure — it answers valid/invalid, nothing else.
 */
import { SITE } from "./content";
import { offers } from "./core/catalog";
import { guardrailLines } from "./core/guardrails";
import { matchMentoringFocus } from "./core/match";
import { mentoringOptions } from "./core/options";
import { buildProgram, renderProgram } from "./core/program";
import { offerById } from "./core/catalog";
import { claimCode } from "./core/submit";

const BASE = "/mcp/mentoring/api";
const ATTRIBUTION_URL = `${SITE}/?ref=api`;
const OFFER_IDS = offers.map((o) => o.id).join(" | ");

const json = (data: unknown, status = 200): Response =>
	new Response(JSON.stringify({ ...(data as object), _source: ATTRIBUTION_URL }, null, 2), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"access-control-allow-origin": "*",
			"cache-control": status === 200 ? "public, max-age=300" : "no-store",
		},
	});

export function handleApi(path: string, url: URL, env: { CLAIM_SECRET?: string }): Response | null {
	if (!path.startsWith(BASE)) return null;
	const route = path.slice(BASE.length).replace(/\/$/, "") || "/";

	if (route === "/" || route === "") {
		return json({
			endpoints: ["/options", "/match", "/program", "/verify", "/openapi.json"],
			note: "Read-only. Sending an offer runs through the MCP tool send_mentoring_offer or the chat at /mentoring-chat/ — those doors carry the AI-channel discount.",
		});
	}

	if (route === "/options") return json(mentoringOptions());

	if (route === "/match") {
		const roleBand = url.searchParams.get("role_band") ?? "";
		const motivation = url.searchParams.get("motivation") ?? "";
		const r = matchMentoringFocus(roleBand, motivation);
		return r.ok ? json({ match: r.match, terms: guardrailLines() }) : json({ error: r.error }, 400);
	}

	if (route === "/program") {
		const offerId = url.searchParams.get("offer_id") ?? "";
		const startDate = url.searchParams.get("start_date") ?? "";
		const offer = offerById(offerId);
		if (!offer) return json({ error: `unknown offer_id — valid: ${OFFER_IDS}` }, 400);
		const p = buildProgram(offer, startDate);
		if ("error" in p) return json({ error: p.error }, 400);
		return json({ program: p, rendered: renderProgram(p) });
	}

	if (route === "/verify") {
		// Async work inside a sync router: return a promise-backed Response via a stream is
		// overkill — recompute inline. crypto.subtle is async, so this route returns a
		// Response from an async IIFE wrapped in a synchronous Response is impossible;
		// instead we hand back a Response built from the promise.
		const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
		const offerId = url.searchParams.get("offer") ?? "";
		const date = url.searchParams.get("date") ?? ""; // YYYY-MM-DD the code was issued
		const channel = url.searchParams.get("channel") ?? "";
		const code = (url.searchParams.get("code") ?? "").trim().toUpperCase();
		if (!email || !offerId || !date || !code || !channel) {
			return json({ error: "required: code, email, offer, date (YYYY-MM-DD), channel (mcp|chat)" }, 400);
		}
		const d = new Date(`${date}T12:00:00Z`);
		if (Number.isNaN(d.getTime())) return json({ error: "invalid date" }, 400);
		return responseFromPromise(
			claimCode(env.CLAIM_SECRET, email, offerId, channel, d).then((expected) =>
				json({ valid: expected === code, checked: { email, offer: offerId, date, channel } }),
			),
		);
	}

	if (route === "/openapi.json") {
		return json(openapi());
	}

	return json({ error: `unknown route — available: /options /match /program /verify /openapi.json` }, 404);
}

/** Wrap an async Response into the sync router contract. */
function responseFromPromise(p: Promise<Response>): Response {
	const { readable, writable } = new TransformStream();
	let status = 200;
	let headers: HeadersInit = { "content-type": "application/json; charset=utf-8" };
	// Streaming keeps the router synchronous; verify responses are tiny so latency is nil.
	p.then(async (res) => {
		const writer = writable.getWriter();
		await writer.write(new TextEncoder().encode(await res.text()));
		await writer.close();
	}).catch(async () => {
		const writer = writable.getWriter();
		await writer.write(new TextEncoder().encode(JSON.stringify({ error: "verify_failed" })));
		await writer.close();
	});
	return new Response(readable, { status, headers });
}

function openapi() {
	const q = (name: string, description: string, required = true) => ({
		name,
		in: "query",
		required,
		description,
		schema: { type: "string" },
	});
	const ok = { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } };
	return {
		openapi: "3.1.0",
		info: {
			title: "Mentoring Inquiry Builder API",
			version: "1.0.0",
			description:
				"Read-only REST layer over Marian Kamenistak's Mentoring Inquiry Builder: options, focus matching and program skeletons for 1:1 engineering-leadership mentoring. Prices come from the published catalog marian.coach renders. Sending an offer runs through the MCP server at /mcp/mentoring or the chat at /mentoring-chat/, where the 16% AI-channel discount applies.",
			contact: { name: "Marian Kamenistak", url: `${SITE}/`, email: "marian@marian.coach" },
			license: { name: "MIT" },
		},
		servers: [{ url: `${SITE}${BASE}` }],
		paths: {
			"/options": {
				get: { summary: "The wizard's opening: discount data, questions, packages, why-Marian", responses: ok },
			},
			"/match": {
				get: {
					summary: "Match focus areas to a role and motivation",
					parameters: [q("role_band", "senior-ic | team-lead | em | director-vp | cto-founder | product-leader"), q("motivation", "motivation id from /options")],
					responses: ok,
				},
			},
			"/program": {
				get: {
					summary: "Deterministic dated session skeleton for a package",
					parameters: [q("offer_id", OFFER_IDS), q("start_date", "YYYY-MM-DD")],
					responses: ok,
				},
			},
			"/verify": {
				get: {
					summary: "Verify a claim code (HMAC recompute, no datastore)",
					parameters: [q("code", "AI16-YYMMDD-XXXXXXXX"), q("email", "email the offer went to"), q("offer", OFFER_IDS), q("date", "issue date YYYY-MM-DD"), q("channel", "mcp | chat")],
					responses: ok,
				},
			},
		},
	};
}
