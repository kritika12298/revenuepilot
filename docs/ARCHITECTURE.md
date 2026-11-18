# RevenuePilot architecture

RevenuePilot is an AI sales assistant for small businesses. It captures enquiries, qualifies them, drafts grounded replies, follows up, books appointments and reports on pipeline. Every action that faces a customer, or commits money, runs through server-side policy and owner approval.

```
 Browser (React SPA)  ──HTTPS──▶  Nginx ──▶ API (Express, PM2 cluster ×2) ──▶ PostgreSQL (localhost)
   │  ▲ SSE /api/events/stream          │            │  ▲
   │  └──────────────────────────────── │ ◀─ Redis pub/sub (live events)
   │                                     │            │
 Hosted form /f/:slug, signed webhooks ──┘            ▼
                                              Redis (BullMQ queues, localhost)
                                                      │
                                              Worker (PM2 fork ×1)
                                     process-lead · send-message · draft-follow-up · sweep
                                     analyze-website · appointment-reminder · insights/recommendations
                                                      │
                     Claude API · Resend · Google Calendar · GoDaddy Domains API · customer websites (SSRF-guarded)
```

## Repository layout

```
apps/api            Node 22, ESM JavaScript, Express 5, Prisma 6 (PostgreSQL), BullMQ, Zod 4, pino
  prisma/           schema.prisma, migrations/, seed.js (demo data)
  src/ai/           runAgent (tool-use loop), toolExecutor, agents/, tools/, policy/, guards/, mock/
  src/modules/      one folder per domain: routes → service → repository (Prisma)
  src/jobs/         BullMQ processors; src/worker.js registers them and the schedulers
  src/website/      netGuard (SSRF), safeFetch, crawler, bundled demo site
  src/calendar/     slot finder, built-in calendar, Google Calendar adapter
  src/integrations/ GoDaddy, Resend and Claude checks
  test/             Vitest + Supertest against a real Postgres and Redis (test DB)
apps/web            React 19, Vite, TanStack Query, React Router, Tailwind v4, Vitest + Testing Library
deploy/             Nginx, PM2, VPS setup, deploy/restart/backup scripts
scripts/demo.mjs    end-to-end hackathon demo over the HTTP API
```

## Request path and tenancy

1. `authenticate` verifies the JWT, then re-loads the membership. A revoked membership loses access immediately.
2. `req.auth = { userId, businessId, role }`. **`businessId` comes only from the verified token**, never from the request.
3. Zod validates params, query and body (strict objects).
4. Services check the role (`requireRole('OWNER')` for approvals, autonomy, integrations and settings) and pass `businessId` into every repository query. Cross-tenant records surface as `404`.

## AI agents

| Agent | Kind | What it does | Side effects it may request |
|---|---|---|---|
| Sales Orchestrator | `ORCHESTRATION` | Observes the lead, delegates to the specialist agents, records the next action | `record_next_action`, `request_owner_approval` |
| Lead Intelligence | `QUALIFICATION` | Requirements, budget, timeline, intent, sentiment, score 0–100 with reasons | `record_lead_analysis`, `update_lead_score` |
| Conversation | `CONVERSATION` | Drafts replies from published prices and approved knowledge only | `send_customer_email` (always policy-checked) |
| Follow-up | `FOLLOW_UP_PLANNING` / `FOLLOW_UP` | Decides whether and when to follow up, within cadence, quiet hours and working hours; drafts the follow-up | `schedule_followup`, `cancel_followup` |
| Meeting | `MEETING` | Offers free slots and books or holds appointments | `check_calendar_availability`, `book_appointment` |
| Sales Intelligence | `SALES_INSIGHTS` | Pipeline insights that must cite facts computed from the data | none |
| Website Intelligence | `WEBSITE_ANALYSIS` | Extracts services, prices, FAQs and policies from the crawled site, with verbatim evidence | `record_business_knowledge` (always `PENDING_REVIEW`) |
| Policy & Approval | `POLICY_CHECK` | **Deterministic code, not an LLM.** Applies autonomy, consent, daily limits, pricing and commitment rules | n/a |

### How a tool call is executed

`runAgent` drives a manual Claude tool-use loop (at most `AI_MAX_ITERATIONS`, default 12, model calls; a run whose work is already recorded on the last allowed turn finishes instead of failing). It uses `claude-opus-5-5` by default (`ANTHROPIC_MODEL`), adaptive effort and a refusal fallback. Live requests are streamed (`stream()` + `finalMessage()`) with eager tool-input streaming, so long turns don't hit HTTP timeouts. Unparseable tool input re-issues the turn; every input is still Zod-validated. Mock mode swaps in deterministic heuristics with the same tool calls. Every tool call goes through `toolExecutor`:

1. Is the tool allowlisted for this agent? Otherwise it is rejected.
2. Zod input validation. Errors go back to the model as `is_error` tool results so it can correct itself.
3. Scoping: the lead must belong to the run's business. Writes to closed leads are blocked.
4. Domain guards:
   - `outboundGuard`: every price in a customer email must match the published price list; no invented discounts, guarantees or availability.
   - Consent and opt-out checks.
   - Slot verification.
   - Idempotency keys.
5. **Policy & Approval Agent** verdict for side effects:
   - `ALLOW`: executes. For example, auto-send when the owner enabled it and all checks pass.
   - `REQUIRE_APPROVAL`: creates an `Approval` and notifies the owner.
   - `BLOCK`: refused with the reason.
6. The call is recorded in `agent_tool_calls` (input, result, duration, status). Each run records its trigger, model, token usage and a short decision and reason that face the user. Private chain-of-thought is not stored.

The model can only *propose*. The backend validates permissions, ownership, schemas and policy before anything changes. Discounts, quotations, contracts and custom pricing **always** need owner approval; that setting is fixed. The system claims an email was sent only after the provider confirms it (`EmailDelivery.status = SENT`), and claims an appointment was booked only after the calendar write succeeds.

## Background work (BullMQ)

| Queue / job | Trigger | Notes |
|---|---|---|
| `process-lead` | Public form, webhook, inbound reply | Runs the orchestrator if autonomy allows; deduplicated by job id |
| `send-message` | Approval, or auto-send | Re-checks consent and opt-out immediately before sending; retries with backoff; records `EmailDelivery` |
| `draft-follow-up` | Follow-up scheduled | Follow-up Agent drafts; auto-approved only if `autoApproveFollowUps` and the policy allows |
| `sweep` | Every `FOLLOW_UP_SWEEP_INTERVAL_MS` | Self-healing: re-enqueues lost jobs, plans follow-ups, marks agent runs stuck in RUNNING for over 15 minutes as failed |
| `analyze-website` | Owner connects a URL | Crawl, then Website Intelligence |
| `appointment-reminder` | 24 h before | Reminder email to the customer (consent re-checked; skipped if opted out) |
| `insights-refresh`, `refresh-recommendations` | Every 15 min | Only when there is new activity |

The database is the source of truth; queues hold only timers. Job ids are deterministic, so re-enqueueing is idempotent.

## Website Intelligence safety

- URLs: http(s) only, no credentials, ports 80/443. DNS is resolved through `guardedLookup`, which rejects private, loopback, link-local, CGNAT, multicast and reserved ranges (IPv4 and IPv6) **when the connection is made**, which defeats DNS rebinding.
- Redirects are re-validated, same site only. Limits: 1.5 MB and a hard 10 s deadline per page, 8 pages, at most 20 requests (failed ones count) and 60 s per crawl, 50 links followed per page, HTML only. `robots.txt` is respected.
- Content is stripped of scripts and styles and passed to the model as untrusted data. Every extracted fact needs verbatim evidence present on the page, and quoted prices must appear verbatim too.
- Items stay `PENDING_REVIEW` until the owner approves them. Only approved items reach customers. Prices are used only after they are promoted to the price list.
- `DEMO_MODE` serves a bundled site for `evergreen-landscaping.test` without any network access.

## Revenue, recommendations, simulator

- **Deal value**, in order of preference: owner-entered → midpoint of the budget the lead stated → published prices of matched services. Otherwise *unknown*. The system never guesses.
- **Win probability per stage**: conservative defaults until a stage has 10 or more closed leads, then the business's own history. The methodology is shown in the UI.
- **Recommendations**: deterministic detectors: high-intent leads waiting for a reply, leads ready for an appointment, potentially lost leads (gone quiet), overdue follow-ups and approvals left waiting, with dedupe keys. They resolve automatically when the condition clears.
- **Simulator**: compares historical groups of your leads. No estimate below 5 leads per group. Labelled *Simulation*; never applied automatically.

## Live updates

The API publishes `agent-run`, `lead-event`, `notification` and `recommendations` events to Redis pub/sub, one channel per business. `GET /api/events/stream` (SSE) relays them to the browser, which invalidates the matching TanStack Query caches. Nginx disables buffering for `/api/events/`. Polling remains as a fallback.

## Data model (main tables)

| Area | Tables |
|---|---|
| Tenancy | `User`, `Business`, `Membership` |
| Pipeline | `Lead` (status, score, `qualification` JSON, `dealValueCents`, consent fields), `LeadEvent` (lifecycle timeline) |
| Conversations | `Conversation`, `Message`, `EmailDelivery` |
| Agents | `AgentRun` (parent/child, trigger, decision), `AgentToolCall` |
| Automation | `Approval`, `FollowUpJob`, `Appointment`, `AutonomyPolicy`, `Notification`, `Recommendation` |
| Website and knowledge | `BusinessWebsite`, `KnowledgeItem`, `Service` |
| Integrations and audit | `IntegrationConnection` (AES-256-GCM `secretsEnc`), `AuditLog` |

## Security summary

- **Secrets**: only in environment variables (`apps/api/.env`, not committed). Integration secrets are encrypted at rest with `INTEGRATIONS_ENCRYPTION_KEY`, which production requires, and are never returned by the API.
- **Network**: Postgres and Redis listen on 127.0.0.1. The firewall allows 22/80/443 only. The API binds to 127.0.0.1 in production. `/ops` is blocked at Nginx.
- **Web**:
  - Helmet and a CORS allowlist; strict Zod validation; JSON bodies capped at 100 kB.
  - Rate limits in Nginx and in the app. App limits use a Redis store, so they hold across the PM2 cluster.
  - Request logs redact OAuth codes, tokens, search text and unsubscribe tokens. The Nginx access log uses the same rules (`rp_safe` format).
  - Honeypot and a per-address cap on the public form.
  - HMAC-signed webhooks with a 5-minute timestamp window; each delivery is accepted once (replay protection in Redis).
  - The live event stream re-checks membership every 60 s.
  - Google sign-in is bound to the browser that started it and can be used once.
- **Email**: consent is required. Unsubscribe uses one-click `List-Unsubscribe`. Opt-out is checked when the email is sent. There is a daily cap on automatic emails. It counts every auto-approved email, queued or sent, and is re-checked at send time; a held email goes back to the owner for approval.
