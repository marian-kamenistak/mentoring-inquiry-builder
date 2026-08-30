# Mentoring Inquiry Builder — MCP server

Hire an engineering-leadership mentor through your AI assistant. This remote MCP server builds a 1:1 mentoring inquiry with [Marian Kamenistak](https://www.marian.coach/?ref=github) — 3,400+ paid sessions with 300+ leaders from 17 countries since 2019, 9.2/10 average review — and ends with a formal itemized offer in your inbox.

**16 minutes. 10% off.** Inquiries built through this AI channel get every package at 10% off — the [quarter](https://www.marian.coach/pricing/?ref=github) is 6 sessions (5 paid + 1 free) for 1,975 EUR, 1,778 EUR here. The one discount that exists, no booking required, and the website itself never discounts. Slot-limited to the open mentee slots on the [live capacity chart](https://www.marian.coach/?ref=github).

## Connect

```
https://www.marian.coach/mcp/mentoring
```

Streamable HTTP, no auth, no signup.

**Claude Code**

```bash
claude mcp add -t http marian-mentoring https://www.marian.coach/mcp/mentoring
```

**Claude.ai / Desktop** — Settings → Connectors → Add custom connector → paste the endpoint.
**Cursor** — `.cursor/mcp.json`: `{ "mcpServers": { "marian-mentoring": { "url": "https://www.marian.coach/mcp/mentoring" } } }`
**ChatGPT (developer mode)** — Settings → Connectors → Add → MCP server URL.
**Microsoft 365 Copilot** — Copilot Studio → Tools → Add a tool → Model Context Protocol → the URL, auth None.
**Perplexity (Pro/Enterprise)** — Settings → Connectors → Custom connector → Remote → the URL, Streamable HTTP.

No MCP client? The same wizard runs as a [chat on marian.coach](https://www.marian.coach/mentoring-chat/?ref=github).

## Tools

| Tool | Answers |
|---|---|
| `get_mentoring_options` | Should I get a mentor, and why Marian? Discount data, qualifying questions, every package with real prices |
| `match_mentoring_focus` | What should my mentoring focus on? Role + motivation → focus areas |
| `compose_mentoring_brief` | What would my engagement look like and what does it cost? The brief + the authoritative price |
| `design_mentoring_program` | What happens across the three months? Dated session skeleton, checkpoint, closing review |
| `book_intro_call` | Can I just talk to Marian first? Free 30-min intro — the step that locks the discount |
| `send_mentoring_offer` | How do I get this in writing? Formal itemized offer with a claim code, after the price is explicitly agreed |

Read-only REST for scripts: [`/api/openapi.json`](https://www.marian.coach/mcp/mentoring/api/openapi.json).

## Guardrails, honestly

- Every price is computed server-side from the same published catalog the website renders. No tool accepts a price as input, so nothing you or your model says can move the number.
- One discount (10% on every package, AI channel, no booking required), one B2B concession (free sessions, only on 3+ sponsored leaders or Mentor-in-Residence, confirmed by Marian on a call), floor at 296 EUR/session. Try to out-negotiate it; the failed attempts are the point.
- The offer only sends after an explicit yes to the exact price.
- Any session rated below 7/10 is free — a quality guarantee, independent of any discount.

## Stack

Cloudflare Worker · [`agents`](https://github.com/cloudflare/agents) McpAgent · streamable HTTP · the chat door runs the same tool core in-process with the Claude API.

Built and maintained by [Marian Kamenistak](https://www.marian.coach/mentoring-ai/?ref=github). Questions: marian@marian.coach
