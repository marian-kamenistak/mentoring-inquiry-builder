# Plan — the paid first session as the AI channel's second door

**Date:** 2026-08-30 · **Approach:** C (AI channel gets a paid door; public site unchanged)

## The change in one sentence

A prospect who reaches explicit price agreement inside the MCP wizard books a **paid first
mentoring session** on the `mentoring-boost` Reclaim link and lands on `mentoring_pipeline`
at `formal 1st arranged` — skipping the free intro entirely. The intro stays as the fallback
for everyone who does not reach agreement, and as the required path for the two deal shapes
whose terms are still confirmed on a call.

## Routing rule

| Prospect | Exit | `mentee_stage` |
|---|---|---|
| Price agreed, `single-session` or `first-quarter`, no concession | `mentoring-boost` | `formal 1st arranged` |
| Concession proposed (B2B free sessions) | intro | `intro arranged` |
| `monthly` (billing day unset) or `mentor-in-residence` (inherently negotiated) | intro | `intro arranged` |
| No agreement / hesitant / not a fit | intro (fallback) | `intro arranged` |

Eligibility is a pure function, `firstSessionEligible()`, so the rule is data-driven and
testable rather than an `offer.id ===` scattered across call sites — the same mistake
`per_leader` was introduced to fix (catalog.yaml:135-141).

## Definition of Success

Concrete checks, run at the end:

1. `npm test` exits 0, including new tests for the boost payload, the stage ladder and eligibility.
2. `npm run type-check` exits 0.
3. `POST /mcp/mentoring/api/mentoring-boost?secret=$MC_BOOKING_HOOK_SECRET` with a Reclaim
   `SchedulingLink.Meeting.Created` fixture returns `{"ok":true,"path":"boost"}`.
4. Wrong secret on that route → 403. `GET` on it → 405.
5. `tools/list` on `https://www.marian.coach/mcp/mentoring` returns **8** tools.
6. A live `test@…` boost booking writes nothing to Attio and posts a 🧪 Slack line.
7. `wrangler tail --format json` for 60s after deploy: zero `console.error`, zero exceptions.
   (Parse with the decoder loop — the output is concatenated pretty-printed JSON, not JSONL.)

## Prerequisite done before coding

`mentoring_ai_inquiries.status` is a **select** with only `Awaiting intro / Intro booked /
Won / Lost`. Attio 400s the whole entry write on one unknown option, so the option
**`First session booked`** was added via the API first (option_id `1d09bb6e…`).
`mentee_stage` needed nothing — `formal 1st arranged` already exists on the ladder.

## Tasks

1. **`_mentoring/offers/catalog.yaml`** → add `meta.first_session` (url, minutes, rule,
   eligibility ids); resolve the stale header claim that the discount requires a booked intro
   (lines 13-14, 87) against the live rule at line 50. → verify: `npm run offers:sync` in
   mc-web exits 0 and both generated JSONs carry `meta.first_session`.
2. **`src/core/booking.ts`** (new) → `STAGE_LADDER`, `stageRank()`, `firstSessionEligible()`,
   `firstSessionUrl()`. → verify: unit tests.
3. **`src/hooks.ts`** → `handleBookingHook(..., kind)`; boost branch writes
   `formal 1st arranged` + `First session booked`, fires GA4 `first_session_booked`, Slack 💶.
   Replace the seed-only-when-blank test with a **rank** test so a booking can advance a stage
   forward but never drag one backward. → verify: `test/hooks.test.ts`.
4. **`src/index.ts`** → route `POST /api/mentoring-boost`; register `book_first_session` and
   `check_booking`; fix the three copy sites that still claim the intro locks the discount
   (`index.ts:193`, `:336`, `submit.ts:226`). → verify: `tools/list` returns 8.
5. **`src/core/submit.ts`** → `next_step` branches on eligibility; offer email states payment
   terms (net, VAT rule for the buyer, issuing entity, invoiced after the session is booked).
6. **`src/chat.ts`** → mirror the two new tools and the branching exit.
7. **`_mentoring/reclaim-webhook.md`** → document the second webhook, its endpoint, and the
   `data-claim` attribution param.

## Why `data-claim` and not the booking note

Reclaim passes up to five `data-`-prefixed query params from the booking URL through into the
signed webhook as `custom_data.data.<key>` (help.reclaim.ai/en/articles/10008727). So
`book_first_session` returns the boost URL with `?data-claim=AI16-…` already appended and the
join becomes deterministic, instead of depending on the prospect pasting a code into a free-text
note — which is the fragile path the intro hook has always relied on.

Kept as a **fallback chain**, not a replacement: `custom_data.data.claim` → note-scanned
`AI16-…` → attendee email. The captured payload in `reclaim-webhook.md` predates any `data-`
param, so `custom_data` is unverified on `api_version v2026-04-13` until a real booking proves it.

## Out of scope (deliberate)

marian.coach public pages, the CZ/PL mirrors, JSON-LD, `llms.txt`, `nlweb.json`. The website
keeps selling the free intro as the front door for non-AI visitors. Fakturoid stays a manual
runbook — `flow/offer-pdf-fakturoid.md` gets its trigger reworded, not automated.

## Known risk carried

Reclaim's webhook delivery has a **10-second timeout** and the config **auto-suspends after 24h
of failures**. The handler is sequential and now does more work on the boost path. If p95
approaches the limit, the fix is `ctx.waitUntil` for the non-critical tail (Slack, prep email,
GA4) — noted, not done, because the intro path has run inside budget for months and this adds
one comparable branch.
