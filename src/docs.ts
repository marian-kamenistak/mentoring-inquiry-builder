/**
 * Human-readable docs page on GET /mcp/mentoring.
 *
 * Served for EVERY Accept header except an explicit text/event-stream ask — curl and the
 * crawlers and registry health-checks whose links land here all send the wildcard Accept.
 * Gating on accept.includes("text/html") is the documented marian.coach 406 bug; the
 * Accept decision itself lives in index.ts.
 */

export interface ToolDoc {
	name: string;
	question: string;
	description: string;
}

const ENDPOINT = "https://www.marian.coach/mcp/mentoring";

export function docsHtml(tools: ToolDoc[], discountPct: number | null, claimCap = 5): string {
	const rows = tools
		.map((t) => `<tr><td><code>${t.name}</code></td><td>${t.question}</td><td>${t.description}</td></tr>`)
		.join("\n");

	const discountLine = discountPct
		? `<p><strong>Why build it here:</strong> mentoring inquiries built through this AI channel get the First-quarter package at <strong>${discountPct}% off</strong> the list price, and the website itself carries no discount at all. <strong>No more than 16 minutes</strong> from first question to a formal itemized offer in your inbox, and the price goes to the <strong>first ${claimCap} people only</strong> — the same count as the open mentee slots on the live <a href="https://www.marian.coach/?ref=mcp">marian.coach capacity chart</a>. 16 minutes, 16 percent, ${claimCap} places.</p>`
		: "";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mentoring Inquiry Builder — MCP server | Marian Kamenistak</title>
<meta name="description" content="Build your engineering-leadership mentoring inquiry with Marian Kamenistak from your own AI assistant: focus areas, definition of success, program, and a formal offer in 16 minutes${discountPct ? ` with a ${discountPct}% AI-channel discount` : ""}. Free remote MCP server, no auth.">
<link rel="canonical" href="${ENDPOINT}">
<meta property="og:title" content="Mentoring Inquiry Builder — MCP server">
<meta property="og:description" content="Hire an engineering-leadership mentor through your AI assistant${discountPct ? ` — ${discountPct}% AI-channel discount, formal offer in 16 minutes` : ""}. 3,400+ sessions, 300+ leaders, 9.2/10 average.">
<meta property="og:url" content="${ENDPOINT}">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify({
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: "Mentoring Inquiry Builder",
		applicationCategory: "BusinessApplication",
		operatingSystem: "Any (MCP server, streamable HTTP)",
		url: ENDPOINT,
		offers: { "@type": "Offer", price: 0, priceCurrency: "EUR", description: "Free to connect and use, no auth." },
		author: { "@type": "Person", name: "Marian Kamenistak", url: "https://www.marian.coach/" },
		description: `MCP server that builds and prices a 1:1 engineering-leadership mentoring engagement with Marian Kamenistak${discountPct ? `, with a ${discountPct}% discount on inquiries sent through the AI channel` : ""}.`,
	})}</script>
<style>
	body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1a1a1a; }
	code, pre { background: #f4f4f4; border-radius: 4px; font-size: 0.9em; }
	code { padding: 0.1em 0.35em; }
	pre { padding: 0.8em 1em; overflow-x: auto; }
	table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
	th, td { border: 1px solid #ddd; padding: 0.5em 0.7em; text-align: left; vertical-align: top; }
	th { background: #f4f4f4; }
	h1 { font-size: 1.6em; } h2 { font-size: 1.2em; margin-top: 2em; }
	a { color: #D02E7C; }
	.muted { color: #666; font-size: 0.9em; }
</style>
</head>
<body>
<h1>Mentoring Inquiry Builder — MCP server</h1>
<p>Build a 1:1 engineering-leadership mentoring engagement with Marian Kamenistak — 3,400+ paid sessions with 300+ leaders from 17 countries since 2019, 9.2/10 average review — directly from your AI assistant: pick your focus areas, define what success looks like, see the dated program, agree the price, and get a formal itemized offer by email. Works for individuals (Staff Engineer to CTO) and companies sponsoring their leaders.</p>
${discountLine}
<p><strong>Endpoint:</strong> <code>${ENDPOINT}</code> (streamable HTTP, no auth, no signup)</p>

<h2>Tools</h2>
<table>
<tr><th>Tool</th><th>Answers the question</th><th>What it returns</th></tr>
${rows}
</table>

<h2>Connect</h2>
<p><strong>Claude Code</strong></p>
<pre>claude mcp add -t http marian-mentoring ${ENDPOINT}</pre>
<p><strong>Claude.ai / Claude Desktop</strong> — Settings → Connectors → Add custom connector → paste <code>${ENDPOINT}</code></p>
<p><strong>Cursor</strong> — add to <code>.cursor/mcp.json</code>:</p>
<pre>{ "mcpServers": { "marian-mentoring": { "url": "${ENDPOINT}" } } }</pre>
<p><strong>ChatGPT (developer mode)</strong> — Settings → Connectors → Add → MCP server URL <code>${ENDPOINT}</code></p>
<p><strong>Microsoft 365 Copilot (via Copilot Studio)</strong> — open your agent → Tools → Add a tool → New tool → Model Context Protocol → Server URL <code>${ENDPOINT}</code>, authentication None → Add to agent. Streamable HTTP, which is the one transport Copilot Studio supports.</p>
<p><strong>Perplexity (Pro/Enterprise)</strong> — profile → All settings → Connectors → Custom connector → Remote → MCP Server URL <code>${ENDPOINT}</code>, transport Streamable HTTP, authentication None.</p>
<p>No AI tool that supports MCP? The same wizard runs as a chat on <a href="https://www.marian.coach/mentoring-chat/?ref=mcp">marian.coach/mentoring-chat</a>, and the classic pages live at <a href="https://www.marian.coach/pricing/?ref=mcp">/pricing/</a>.</p>

<h2>Plain REST, no MCP needed</h2>
<p>The read-only tools double as GET endpoints for scripts: <code>${ENDPOINT}/api/options</code>, <code>/api/match?role_band=em&amp;motivation=scale-jump</code>, <code>/api/program?offer_id=first-quarter&amp;start_date=2026-09-01</code>, <code>/api/verify</code> (claim-code check). Spec: <a href="${ENDPOINT}/api/openapi.json">openapi.json</a>. Sending an offer stays on the MCP tool and <a href="https://www.marian.coach/mentoring-chat/?ref=mcp">the chat</a> — the doors that carry the discount.</p>

<h2>Sibling server</h2>
<p>Marian's general engineering-leadership toolkit (salary calculators, team-lead readiness, business-case builder — 9 tools) runs at <a href="https://www.marian.coach/mcp">marian.coach/mcp</a> — same pattern, complementary tools.</p>

<h2>Source &amp; method</h2>
<p>Every price comes from the published mentoring catalog — the same generated file marian.coach renders, so this server cannot quote a price the site disagrees with. Track-record figures come from Marian's session log, pulled live on the site.</p>
<p class="muted">Built and maintained by <a href="https://www.marian.coach/?ref=mcp">Marian Kamenistak</a>. Questions: marian@marian.coach</p>
</body>
</html>`;
}
