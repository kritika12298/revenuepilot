# RevenuePilot API reference

Base URL: `http://localhost:4000` in development; `https://<your-domain>` behind Nginx in production.

## Conventions

- **Auth.** Every `/api/*` route needs `Authorization: Bearer <token>`. The exceptions are register, login, `/api/public/*` and the signed webhooks. The token carries the active business; membership is re-checked on every request.
- **Tenancy.** Every query is scoped to the token's business. Another tenant's records return `404`, the same as records that don't exist.
- **Roles.** `OWNER` can do everything. `MEMBER` can work leads but **cannot**:
  - approve or reject;
  - change autonomy, business settings or integrations;
  - delete leads.
- **Validation.** Bodies and queries use strict Zod schemas, so unknown fields return `400`.
- **Errors.** Always shaped as `{ "error": { "code", "message", "details?", "requestId" } }`.
- **Pagination.** List responses use `{ data, meta: { page, pageSize, total, totalPages } }`.
- **Money.** Amounts are integer cents (`*Cents`).
- **Times.** ISO-8601 UTC. The business timezone is used only for display and working hours.
- **Rate limits.**
  - Global API limiter.
  - Auth: 10 requests/min per IP at Nginx.
  - Agent runs: 20/min per user.
  - Public form: 10 per 10 min per IP.
  - Website analysis: 6/hour per business.
  - Public form: also at most 3 submissions per email address per business per day (10 across all businesses). Extra submissions get the same response but are discarded.
  - App limits are stored in Redis, so they hold across all API processes.

## Auth & business

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | Creates the user, the business and an OWNER membership. Returns a token |
| POST | `/api/auth/login` | `{ email, password, businessId? }` |
| POST | `/api/auth/switch-business` | Returns a new token for another business you belong to |
| GET | `/api/auth/me` | Current user, role and businesses |
| GET / PATCH | `/api/business` | Current business. PATCH is OWNER only (hours, timezone, preferences). `commsPrefs` is merged, not replaced |
| GET | `/api/business/members` | Members, for assignment |
| GET / POST | `/api/business/services` | Services and published prices: **the only source of pricing the AI may quote** |
| PUT / DELETE | `/api/business/services/:id` | OWNER only |

## Leads

| Method | Path | Notes |
|---|---|---|
| GET | `/api/leads` | Filters: `status`, `source` (comma lists), `minScore`, `maxScore`, `q`, `sort`, `order`, `page`, `pageSize` |
| POST | `/api/leads` | Lead, optional first enquiry message and consent record |
| GET | `/api/leads/:id` | 360° view. Includes: lead, conversations and messages, follow-ups, approvals, appointments, `dealValue` (with its basis), `nextAction`, open `recommendations`, `allowedTransitions` |
| PATCH | `/api/leads/:id` | Contact details, consent, `assignedToId`, `dealValueCents` (owner value). Withdrawing consent cancels follow-ups |
| DELETE | `/api/leads/:id` | OWNER only |
| PATCH | `/api/leads/:id/status` | Validated state machine. `LOST` needs `lostReason`. Closing a lead cancels its follow-ups and expires its approvals |
| PATCH | `/api/leads/:id/score` | Manual score: `{ breakdown }` or `{ score, reason }` |
| GET | `/api/leads/:id/events` | Lifecycle timeline (paginated) |
| GET | `/api/search?q=` | Leads (name, email, company) and message snippets. Minimum 2 characters |

## AI agents

| Method | Path | Notes |
|---|---|---|
| POST | `/api/leads/:id/agent-runs` | `{ agent: "orchestrator" \| "lead_intelligence" \| "conversation", goal?, reason? }`. Runs synchronously. `goal: FOLLOW_UP` is rejected: follow-up drafts come only from scheduled follow-ups |
| GET | `/api/leads/:id/agent-runs` | Decision history for one lead (top-level runs) |
| GET | `/api/agent-runs` | All runs. Filters: `agent`, `status`, `leadId`, `days`, `page` |
| GET | `/api/agent-runs/:id` | Full audit: trigger, input, output, every tool call (validated input, result, duration), child runs, `agentName`, `decision`, `reason` |
| GET | `/api/ai/status` | `{ mode: "live" \| "mock", model, effort }` |
| GET | `/api/dashboard/agents?range=` | Status per agent (running, scheduled, completed, failed or idle), from the audit trail |

Agent run responses show a short **decision** and a **reason** that faces the user. Private model reasoning is never stored or returned.

## Approvals, follow-ups, messages

| Method | Path | Notes |
|---|---|---|
| GET | `/api/approvals?status=&type=` | Types: `OUTBOUND_MESSAGE`, `DISCOUNT`, `QUOTE`, `APPOINTMENT`, `CONTRACT`, `CUSTOM_PRICE`, `OTHER` |
| POST | `/api/approvals/:id/approve` | OWNER only. `{ subject?, body?, note? }` lets you edit while approving. Queues the send (consent re-checked when sending). Approving an `APPOINTMENT` confirms the booking |
| POST | `/api/approvals/:id/reject` | OWNER only. Rejecting a follow-up draft cancels the follow-up; rejecting an appointment cancels the hold |
| GET | `/api/follow-ups?status=&leadId=` | Follow-ups with draft, approval and delivery status |
| GET | `/api/follow-ups/:id` | |
| POST | `/api/leads/:id/follow-ups` | `{ delayHours? \| scheduledFor?, respectWorkingHours? }`. Consent checked |
| POST | `/api/follow-ups/:id/cancel` · `/reschedule` | |
| GET | `/api/conversations` | Inbox |
| POST | `/api/leads/:id/messages` | Owner-written email (consent checked) |
| POST | `/api/leads/:id/messages/inbound` | Log a reply received elsewhere. Stops follow-ups and re-runs the agents (per autonomy) |
| POST | `/api/webhooks/inbound-email` | HMAC-signed inbound email relay |
| GET / POST | `/u/:token` | Unsubscribe page and one-click opt-out |

## Appointments (Meeting Agent)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/leads/:id/appointments/slots?durationMinutes=&daysAhead=` | Free slots. Built from working hours minus existing appointments (and Google busy times when connected) |
| POST | `/api/leads/:id/appointments` | `{ startsAt, durationMinutes, title, location?, notes? }`. Must match a free slot; the server checks for double-booking under a row lock. Booked by a person, so it is confirmed immediately |
| GET | `/api/appointments?from=&to=&status=` | |
| PATCH | `/api/appointments/:id` | Reschedule: `{ startsAt, durationMinutes? }` |
| POST | `/api/appointments/:id/cancel` · `/outcome` | `outcome`: `COMPLETED` or `NO_SHOW` |

## Website Intelligence & knowledge

| Method | Path | Notes |
|---|---|---|
| GET | `/api/website` | Connected site, crawl status, pages read, summary, item counts |
| POST | `/api/website` | OWNER only. `{ url }`. Validates the URL (public http(s) only, no private or reserved IPs), then queues the analysis. `202` |
| GET | `/api/knowledge?status=` | `PENDING_REVIEW`, `APPROVED` or `REJECTED`. Each item has `sourceUrl` and verbatim `evidence` |
| POST | `/api/knowledge` | OWNER only. Owner-written item (approved immediately) |
| PATCH | `/api/knowledge/:id` | OWNER only. Edit, approve or reject. **Only `APPROVED` items are used in customer conversations** |
| DELETE | `/api/knowledge/:id` | OWNER only. Deletes any item; for website items, *reject* keeps a record that you reviewed it, while delete removes it (a re-analysis may extract it again) |
| POST | `/api/knowledge/:id/promote` | OWNER only. Turns a service item into a priced service: `{ priceType, priceMinCents?, priceMaxCents?, durationMinutes? }` |

## Autonomy

| Method | Path | Notes |
|---|---|---|
| GET | `/api/autonomy` | `{ policy, lockedApprovals }` |
| PUT | `/api/autonomy` | OWNER only, audited. Settable fields: `autoScoreLeads`, `autoGenerateResponses`, `autoSendResponses`, `autoScheduleFollowUps`, `autoApproveFollowUps`, `autoBookAppointments`, `maxAutoEmailsPerDay`. Approvals for discounts, quotes, contracts and custom pricing are fixed and cannot be changed |

## Revenue, recommendations, notifications, live events

| Method | Path | Notes |
|---|---|---|
| GET | `/api/dashboard/summary?range=` | KPIs, funnel, pipeline by status, leads per day, pipeline value |
| GET | `/api/dashboard/activity?category=` | Recent lead events |
| GET / POST | `/api/dashboard/insights` | Sales Intelligence analysis. Each insight cites facts computed from your data |
| GET | `/api/revenue?range=` | Pipeline and weighted value, intent tiers, at-risk leads, lost reasons, weekly trend, methodology, data sufficiency. **Estimates, not guaranteed revenue** |
| GET | `/api/recommendations?status=` | Deterministic, data-backed recommendations |
| POST | `/api/recommendations/refresh` | Re-detect now (the worker also runs this every 15 min) |
| POST | `/api/recommendations/:id/done` · `/dismiss` | `204` |
| GET | `/api/notifications?unread=` | |
| GET | `/api/notifications/unread-count` | |
| POST | `/api/notifications/:id/read` · `/read-all` | |
| GET | `/api/events/stream` | Server-Sent Events, scoped to the business. Events: `ready`, `agent-run`, `lead-event`, `notification`, `recommendations` The client sends the bearer token through `fetch` streaming |

## Simulator

`POST /api/simulations` takes `{ scenario, range, params }`. Scenarios:

- `RESPONSE_TIME`: params `{ targetMinutes, segment }`.
- `FIRST_FOLLOW_UP_DELAY`: params `{ delayHours }`.
- `FOLLOW_UP_FREQUENCY`: params `{ maxFollowUps }`.
- `PRIORITISATION`: params `{ by }`.

How results work:

- Results are labelled `SIMULATION`.
- An impact estimate is given only when each comparison group has at least 5 leads; otherwise you get `estimate: null` with the reason.
- A simulation never changes settings. Applying a strategy is a separate, explicit owner action in Settings or Autonomy.

## Integrations

| Method | Path | Notes |
|---|---|---|
| GET | `/api/integrations` | Status per provider, computed from configuration and recent results. Statuses: `CONNECTED`, `ERROR`, `NOT_CONFIGURED`, `DISABLED` (server not configured), `MOCK` (mock provider active), and for the GoDaddy website form `AVAILABLE` / `RECEIVING` (no GoDaddy API exists, so it never claims `CONNECTED`). Secrets are never returned |
| PUT | `/api/integrations/godaddy_domains` | OWNER only. `{ token }`: a GoDaddy Personal Access Token. Checked against `GET https://api.godaddy.com/v1/domains` before it is stored (AES-256-GCM) |
| POST | `/api/integrations/:provider/test` | OWNER only. Live check of the provider |
| GET | `/api/integrations/google_calendar/connect` | OWNER only. Returns the Google OAuth URL and sets an httpOnly cookie binding the sign-in to this browser. The state is a signed, single-use JWT |
| GET | `/api/integrations/google/callback` | OAuth redirect target. Refused unless the cookie matches, the state is unused, and the person who started it is still an owner |
| POST | `/api/integrations/website_webhook/rotate` | OWNER only. Returns a new signing secret **once** |
| DELETE | `/api/integrations/:provider` | OWNER only |

### Lead intake (no auth)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/public/forms/:slug` | Business name and consent text for the hosted form at `/f/:slug` |
| POST | `/api/public/forms/:slug/leads` | `{ name, email, phone?, company?, message, consent, website }`. `website` is a honeypot and must be empty. The lead is queued for the agents |
| POST | `/api/webhooks/leads/:slug` | Signed JSON lead webhook (details below) |

To sign a webhook request, send two headers:

- `X-RevenuePilot-Timestamp`: Unix seconds, within 5 minutes of server time.
- `X-RevenuePilot-Signature`: `sha256=` followed by `HMAC_SHA256(secret, "<timestamp>.<raw body>")` in hex.

Each signed delivery is accepted once: replaying it returns `409`. Webhooks are limited to 60 requests/min per IP.

```bash
ts=$(date +%s); body='{"name":"Alex Rivera","email":"alex@example.com","message":"Need a garden redesign","consent":true}'
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST https://app.example.com/api/webhooks/leads/evergreen-landscaping \
  -H 'Content-Type: application/json' -H "X-RevenuePilot-Timestamp: $ts" -H "X-RevenuePilot-Signature: sha256=$sig" -d "$body"
```

## Operations

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness (database) |
| GET | `/ops/queues` | Queue counts and failed jobs. Needs `OPS_TOKEN`; Nginx blocks `/ops` publicly |
| POST | `/ops/queues/:queue/jobs/:id/retry` | Retry a failed job |
