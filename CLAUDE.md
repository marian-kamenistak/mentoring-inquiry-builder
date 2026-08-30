# mentoring-inquiry-builder

## What this is
Mentoring AI Inquiry Wizard for the **mc** stream: authless MCP server at
`https://www.marian.coach/mcp/mentoring` plus the chat backend for `/mentoring-chat/` on
marian.coach. Six tools walk a visitor from options to a formal itemized offer (16% AI-channel
discount, floor 361 EUR/session, prices computed server-side only). Read-only REST at
`/mcp/mentoring/api/openapi.json`. Receives Reclaim booking webhooks.

## Stack
- Cloudflare Worker + Durable Object `MentoringInquiryBuilder` (`MCP_OBJECT`), `McpAgent` (`agents` ^0.17), streamable HTTP
- TypeScript 6, zod 4, vitest 3, `@posthog/mcp` + `posthog-node`; chat via Claude API (`CHAT_MODEL` = `claude-sonnet-5`)
- wrangler ^4.105, npm (pnpm lockfile also present)
- Rate limiters `OFFER_RATE_LIMITER` (3001), `CHAT_RATE_LIMITER` (3002); cron `*/15 * * * *` uptime + route-theft probe

## Run / build / deploy / test
```bash
# dev:    npm run dev
# build:  npm run type-check
# test:   npm test                                   # vitest run (test/)
# tools:  npx vite-node scripts/tool.ts -- list      # persona harness, no side effects
# deploy: set -a && source ~/.env && set +a && npm run deploy   # runs secret-sync first
```

## Sources of truth
| Data | Lives in | Id / path |
|---|---|---|
| Package prices | same published catalog mc-web renders | <!-- TODO: path of the shared catalog file --> |
| Inquiries / bookings | Attio People | |
| Reclaim webhook shape | `_mentoring/reclaim-webhook.md` + `test/hooks.test.ts` | |
| Secrets (1Password → Worker) | `.op-secrets` | `ANTHROPIC_API_KEY`, `ATTIO_TOKEN`, `RESEND_API_KEY` (MC account), `SLACK_WEBHOOK_URL`, `SLACK_BOT_TOKEN_ELC` |
| Secrets (CF Secrets Store `e5f76638…`) | `wrangler.jsonc` | `MC_TURNSTILE_SECRET`, `MC_BOOKING_HOOK_SECRET`, `MC_CHAT_SESSION_SECRET`, `MC_CLAIM_SECRET`, `MC_PREP_INVITE_SECRET` |
| Unmanaged Worker secrets | Cloudflare only | `MCP_USAGE_SLACK_CHANNEL`, `GA4_API_SECRET`, `GA4_MEASUREMENT_ID` |

## Definition of done
- [ ] `npm test` and `npm run type-check` exit 0
- [ ] `wrangler deploy` exits 0
- [ ] `tools/list` POST to `https://www.marian.coach/mcp/mentoring` returns 6 tools; GET returns 200 HTML
- [ ] `wrangler tail --format json` for 60s: zero `console.error`, zero exceptions
- [ ] Sibling `https://www.marian.coach/mcp` still answers (nesting intact)

## Gotchas
- `PREP_INVITE_SECRET` is shared with mc-web via the Secrets Store; a value drift 403s every prep invite silently.
- Never re-push Secrets Store names through `.op-secrets` (collides with the binding, 2026-08-25).
- `BOOKING_HOOK_ECHO=true` posts a booker's name and address to Slack verbatim — keep `false`.
- The booking hook writes **two** ladders on `mentoring_pipeline`: `stage` (select, gates the GA4 `call_booked` de-dup via `shouldFireCallBooked`) and `intro_arranged` (status type, drives Marian's "Mentoring flow" kanban). `intro_arranged` is seeded **only when blank** — never overwrite it, or someone already on `mentoring` gets dragged back to `intro arranged` by a reschedule. It is also the only status-type attribute on that list, so archiving it breaks the kanban outright.
