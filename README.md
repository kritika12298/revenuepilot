# GoDaddy RevenuePilot

An AI sales assistant that helps small businesses turn website enquiries into customers.

It captures enquiries (hosted form, signed webhooks, API), and a team of AI agents takes it from there:

- qualifies and scores each enquiry;
- drafts replies that quote only the published price list and approved website knowledge;
- follows up within working hours;
- offers real appointment slots;
- flags revenue at risk.

Deterministic server-side policy and owner approval wrap every action that faces a customer or commits money.

**Docs:**

- [Architecture](docs/ARCHITECTURE.md)
- [API reference](docs/API.md)
- [Hackathon demo](docs/DEMO.md)
- [Deploying to a GoDaddy VPS](docs/DEPLOYMENT.md)
- [CLAUDE.md](CLAUDE.md), for contributors and AI coding assistants

**Fastest way to see it:** follow steps 1–5 below, then run `npm run demo`. It works in mock mode, with no API keys.

| Area | What's included |
|---|---|
| Lead 360° | Profile, explainable score, AI analysis with sentiment, deal value with its basis, recommended next action, assignee, and a timeline of every AI decision and tool call |
| Agents | Sales Orchestrator, Lead Intelligence, Conversation, Follow-up, Meeting, Sales Intelligence, Website Intelligence; plus the deterministic **Policy & Approval Agent** |
| Website Intelligence | SSRF-guarded crawler (robots.txt, same-site, size, time and page limits). Extracted facts need verbatim evidence and owner review before use |
| Autonomy Control Center | The owner chooses what agents may do alone: score, draft, send, plan or approve follow-ups, book, and a daily email cap. Discounts, quotes, contracts and custom pricing always need approval |
| Revenue intelligence | Pipeline and weighted value (estimates, methodology shown), intent tiers, revenue at risk, lost reasons, conversion trend, proactive recommendations, notification centre |
| Simulator | What-if analysis of follow-up strategies against your own history. Labelled as a simulation; minimum sample sizes; never applied automatically |
| Integrations | GoDaddy Domains (PAT), GoDaddy Websites + Marketing (embeddable form; GoDaddy has no public API for it), signed website webhooks, Claude, Resend, Google Calendar. Statuses reflect real configuration |
| UX | Global search (⌘K), live updates (SSE), notification bell, light and dark mode, responsive layout |

```
apps/web/            React 19 + Vite dashboard
  src/api/hooks.js   TanStack Query hooks, one per API resource (cache invalidation on writes)
  src/lib/api.js     fetch client: bearer token, ApiError, 401 handling
  src/components/    ui/ (Button, Card, Dialog, Field, Toast, States…), charts/, domain components
  src/pages/         Overview, Leads, LeadDetail (360°), Conversations, FollowUps, Revenue, Simulator,
                     AiActivity, Knowledge, Autonomy, Integrations, Settings, PublicForm (/f/:slug), Auth
  src/lib/liveEvents.js  SSE client; invalidates queries when agents act
apps/api/
  prisma/            schema.prisma · migrations/ · seed.js
  src/
    config/          env.js (validated env) · logger.js (pino, PII redaction)
    lib/             prisma client · error classes · validators · pagination
    middleware/      authenticate · validate (Zod) · rateLimit · requestLogger · errorHandler
    modules/
      auth/          routes → controller → service → repository (+ JWT, schemas)
      business/      current business settings, services
      leads/         lead CRUD, status state machine, explainable scoring
      leadEvents/    followUps/  approvals/   (repositories used by the lead service)
      health/        /healthz, /readyz
      agents/        start runs, run history and audit view
      notifications/ owner alerts raised by the agents
      appointments/  autonomy/  knowledge/  revenue/  recommendations/  simulator/
      integrations/  events/ (SSE)  search/  public/ (hosted form)
    ai/
      client.js      Anthropic SDK client (live) or mock, chosen by AI_MODE
      runAgent.js    the tool-use loop: request → tool_use → validate/authorise/execute → tool_result
      toolExecutor.js  allowlist, Zod validation, lead scoping and audit for every tool call
      tools/         backend tools Claude can propose (one Zod schema each)
      agents/        orchestrator, lead intelligence, conversation, follow-up, meeting, sales and
                     website intelligence (prompts + tool allowlists)
      policy/        Policy & Approval Agent (deterministic autonomy/consent/pricing rules)
      guards/        outbound message guard (published prices only, no commitments)
      mock/          offline Claude stand-in for development and tests
    website/         SSRF guard, safe fetcher, crawler, bundled demo site
    calendar/        slot finder, built-in calendar, Google Calendar adapter
    integrations/    GoDaddy Domains, Resend and Claude connection checks
    queue/           BullMQ queues, deterministic job ids, Redis connection
    jobs/            worker processors: process lead, draft follow-up, send message, plan follow-up,
                     analyse website, sweep
    email/           provider abstraction: mock (dev) and Resend, plus email composer
    lib/workingHours.js  time-zone- and DST-aware business hours
    app.js           Express app factory
    worker.js        background worker entry point (separate process)
    server.js        entry point with graceful shutdown
  test/              Vitest + Supertest integration tests (real PostgreSQL)
deploy/              nginx.conf · ecosystem.config.cjs (PM2) · setup-vps.sh · deploy.sh · restart.sh · backup.sh
docs/                ARCHITECTURE.md · API.md · DEMO.md · DEPLOYMENT.md
scripts/demo.mjs     end-to-end demo over the HTTP API (`npm run demo`)
```

## Prerequisites

- **Node.js 20.11 or newer** (tested on 26): `brew install node`
- **PostgreSQL 14 or newer.** Use one of the two options below.
- **Redis 6.2 or newer** for the job queue (`docker compose up -d redis` or `brew install redis && brew services start redis`).

## 1. Install dependencies

```bash
cd revenuepilot
npm install          # also runs `prisma generate`
```

## 2. Start PostgreSQL

**Option A: Docker** (needs Docker Desktop)

```bash
docker compose up -d postgres redis
```

This creates the `revenuepilot` user, password and database used by `.env.example`.

**Option B: Homebrew**

```bash
brew install postgresql@16
brew services start postgresql@16          # or run in the foreground: see `brew info postgresql@16`
/opt/homebrew/opt/postgresql@16/bin/psql -d postgres \
  -c "CREATE ROLE revenuepilot LOGIN PASSWORD 'revenuepilot' CREATEDB;"
/opt/homebrew/opt/postgresql@16/bin/createdb -O revenuepilot revenuepilot
```

`CREATEDB` lets Prisma create the shadow database used by `migrate dev` and the test database.

## 3. Configure the environment

```bash
cp apps/api/.env.example apps/api/.env
# Generate a real JWT secret and paste it into JWT_SECRET in apps/api/.env:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Every variable is documented in `apps/api/.env.example`. The app checks its configuration at
startup and refuses to start if anything is missing or invalid.

## 4. Migrate and seed the database

```bash
npm run db:deploy    # apply committed migrations (use db:migrate when changing the schema)
npm run db:seed      # demo data; safe to re-run
```

Demo logins use the password `DemoPass123!`, or whatever `SEED_DEMO_PASSWORD` is set to:

| Email | Role | Business |
|---|---|---|
| maria@evergreen.example | OWNER | Evergreen Landscaping Co. (11 leads across every pipeline stage) |
| sam@evergreen.example | MEMBER | Evergreen Landscaping Co. |
| dev@northside.example | OWNER | Northside Plumbing (2 leads; used to demo isolation) |

## 5. Run the API, the worker and the dashboard

Three processes in development: the HTTP API, the background worker (follow-ups and email), and
the Vite dev server for the dashboard.

```bash
npm run dev          # API on http://localhost:4000, restarts on file changes
npm run dev:worker   # worker (second terminal)
npm run dev:web      # dashboard on http://localhost:5173 (third terminal)
```

Open http://localhost:5173 and sign in as `maria@evergreen.example` / `DemoPass123!`. Vite proxies
`/api` and `/u` to the API, so the browser talks to one origin and no CORS setup is needed.

Production:

```bash
npm run build        # dashboard static files -> apps/web/dist

npm start            # production mode
npm run worker
```

In production, PM2 runs the API and the worker (`pm2 start deploy/ecosystem.config.cjs --env production`).
Nginx serves `apps/web/dist` and proxies `/api`, `/u` and `/readyz` to the API; see
`deploy/nginx.conf`. It also adds rate limits and TLS, and blocks `/ops` from the public internet.

Quick check:

```bash
curl localhost:4000/readyz
TOKEN=$(curl -s -X POST localhost:4000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"maria@evergreen.example","password":"DemoPass123!"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s "localhost:4000/api/leads?sort=score" -H "Authorization: Bearer $TOKEN"
```

## AI agents

| Agent | What it does | Tools it may use |
|---|---|---|
| **Lead intelligence** | Extracts requirements, budget, timeline, intent and missing information. Saves an explainable 0–100 score: urgency ≤35 + budget fit ≤35 + conversion likelihood ≤30, with reasons | `get_lead_details`, `get_business_pricing`, `record_lead_analysis`, `update_lead_score` |
| **Conversation** | Drafts a reply with qualification questions, using the business profile, published prices and conversation history. The draft waits for owner approval and is **never sent** | `get_lead_details`, `get_business_pricing`, `draft_reply`, `notify_business_owner` |
| **Sales orchestrator** | Decides the next best action, runs the other two agents as tools, and records a decision (`AWAIT_OWNER_APPROVAL`, `AWAIT_LEAD_REPLY`, `OWNER_ACTION_REQUIRED`, …) | `get_lead_details`, `run_lead_intelligence`, `run_conversation_agent`, `update_lead_status`, `notify_business_owner`, `record_next_action` |

**How a run works.** The backend calls the Messages API with the agent's tool definitions,
which are generated from the same Zod schemas used for validation. Claude replies with `tool_use`
blocks. The backend checks each one and sends back `tool_result` blocks, repeating until the agent
has done its required work. Claude never touches the database: it can only propose tool calls.
Before any tool runs, the executor (`src/ai/toolExecutor.js`):

1. rejects tools that aren't on that agent's allowlist,
2. validates the input with the tool's Zod schema, and returns field errors to Claude so it can fix them,
3. checks `lead_id` is the lead this run was started for, re-loaded and scoped to the caller's business,
4. refuses writes to WON / LOST / OPTED_OUT leads,
5. then the tool applies its own business rules:
   - the AI may only set `QUALIFYING` or `QUALIFIED`
   - matched services must belong to this business
   - only one draft per lead may wait for approval at a time
   - owner alerts are de-duplicated
   - discount and quote requests become approval items

**Never inventing prices or commitments.** The prompts tell Claude the rules, and
`src/ai/guards/outboundGuard.js` enforces them on every draft:
- every money amount must exactly match a published price of a service the draft references
- discounts, free work, guarantees, deposits and refunds are rejected
- specific appointment times and claims of availability are rejected

A rejected draft goes back to Claude with the violations listed, so it can rewrite it.

**Audit trail.**
- Every run is an `agent_runs` row: trigger, user, model, status, stop reason, error code, token
  usage and latency. Sub-agent runs link to their orchestrator run through `parent_run_id`.
- Every proposed tool call, allowed or not, is an `agent_tool_calls` row with its input, outcome
  (`EXECUTED`, `VALIDATION_FAILED`, `PERMISSION_DENIED`, `POLICY_BLOCKED` or `ERROR`) and result.
- Lead changes made by agents also appear in the lead timeline with `actorType: AI`.

**Reliability.**
- *Retries:* the SDK retries 429, 5xx and connection errors with exponential backoff
  (`AI_MAX_RETRIES`, honouring `retry-after`).
- *Error responses:* when retries run out, errors are classified and recorded on the run, and the
  API returns `503 AI_UNAVAILABLE` / `AI_RATE_LIMITED`, `504 AI_TIMEOUT`, `500 AI_MISCONFIGURED`,
  `422 AI_REFUSED`, or `502 AI_INCOMPLETE` / `AI_LOOP_LIMIT`. The error includes `details.runId`.
- *Bad turns:* tool calls from a response cut off at `max_tokens` are never executed. An agent
  that stops early gets one reminder before the run fails. Runs are capped at `AI_MAX_ITERATIONS`
  model calls and 24 tool calls.
- *Concurrency:* one active run per lead; a run stuck for more than 10 minutes is marked stale.
- *Refusals:* on supported models, the server-side refusal fallback is enabled
  (`AI_REFUSAL_FALLBACK`).

**Privacy.** Agents see the lead's name and conversation. Email addresses and phone numbers are
reduced to `has_email` / `has_phone` flags before anything is sent to Claude.

### Configuring Claude

| Variable | Default | |
|---|---|---|
| `AI_MODE` | `auto` | `auto`: live if `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is set, otherwise mock. `live`: always call Claude (also works with an `ant auth login` profile). `mock`: never call Claude |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Any Messages API model id |
| `AI_EFFORT` | `medium` | `low` … `max`; leave empty for models without effort support |
| `AI_MAX_TOKENS`, `AI_MAX_RETRIES`, `AI_TIMEOUT_MS`, `AI_MAX_ITERATIONS`, `AI_REFUSAL_FALLBACK` | see `.env.example` | |

### Mock mode

With no credentials, or with `AI_MODE=mock`, a local stand-in replaces Claude
(`src/ai/mock/`). It returns real `tool_use` blocks, chosen by keyword rules, so the loop,
validation, permission checks, guard and audit trail all run exactly as they do live. Tests
always use mock mode or a scripted fake. No test calls the real API.

### Try it

```bash
npm run agent:demo -w apps/api                                    # orchestrator on seeded lead "Priya Shah"
npm run agent:demo -w apps/api -- "Sofia Alvarez" lead_intelligence
AI_MODE=live npm run agent:demo -w apps/api                       # real Claude (billed)
```

Or over HTTP (`TOKEN` from the login example above):

```bash
LEAD=$(curl -s "localhost:4000/api/leads?q=priya" -H "Authorization: Bearer $TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data[0].id')
curl -s -X POST "localhost:4000/api/leads/$LEAD/agent-runs" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"agent":"orchestrator"}'
```

## Dashboard

| Page | What it shows | APIs |
|---|---|---|
| **Overview** | Total leads (vs previous period), qualified leads, conversion rate, pending follow-ups, average score, median first response, new leads per day, pipeline by status, approvals waiting, recent activity. One time-range filter (7 / 30 / 90 days / all time) scopes every number | `GET /api/dashboard/summary`, `/api/dashboard/activity`, `/api/approvals` |
| **Leads** | Searchable, filterable, sortable table (status, source, minimum score); filters live in the URL. Add-lead dialog. Lead detail: AI analysis, explainable score breakdown, conversation, agent activity, timeline, follow-ups; change status, run the AI, schedule a follow-up | `/api/leads…`, `/api/leads/:id/agent-runs`, `/api/leads/:id/follow-ups` |
| **Conversations** | Inbox of leads by latest message ("Awaiting reply" filter). Thread with AI drafts flagged, approved, edited or rejected in place; email reply or log a reply received elsewhere; agent activity timeline with every tool call and its outcome | `GET /api/conversations`, `POST /api/leads/:id/messages`, `/api/approvals/:id/approve` |
| **Follow-ups** | Upcoming / Sent / Stopped tabs, message preview drawer, approve, cancel (with reason), reschedule (+1 day, +3 days, +1 week, or a custom time; moved into working hours by default) | `/api/follow-ups…` |
| **Revenue** | Pipeline and weighted value, intent tiers, revenue at risk with reasons, conversion trend, lost reasons, methodology | `/api/revenue` |
| **Simulator** | Four what-if scenarios with historical comparison and sample-size guards | `POST /api/simulations` |
| **AI activity** | Every agent run, filterable, with steps, tool calls and outcomes | `/api/agent-runs` |
| **Knowledge** | Website analysis and owner review of extracted knowledge (evidence + source page); add to price list | `/api/website`, `/api/knowledge…` |
| **Autonomy** | Agent permissions, locked financial approvals, recent policy decisions | `/api/autonomy` |
| **Integrations** | GoDaddy, Claude, Resend, Google Calendar, webhooks: honest statuses, connect/test/disconnect | `/api/integrations…` |
| **Business settings** | Profile and time zone; services and pricing (create, edit, deactivate); working hours, including split shifts; tone, signature, follow-up switch, number of follow-ups and delays (auto-approval moved to Autonomy). Read-only for team members | `/api/business`, `/api/business/services…` |

**How the dashboard behaves.**
- *Loading, empty and error states:* every view has all three, and error states include the
  server's request id and a retry button.
- *Refreshing:* lists and metrics keep showing the previous data while a new filter or page loads,
  so the layout doesn't jump.
- *Writes:* every change refreshes the data it affects.
- *Expired sessions:* a 401 signs the user out.
- *Charts:* follow the dataviz guidance:
  - KPIs are stat tiles rather than charts.
  - Each chart is a single series in one validated colour, so there's no legend.
  - Marks are thin, with values at the bar tips and hairline gridlines.
  - Every chart has a hover/focus tooltip and a "Table" view, so no value is hover-only.
- *Theme:* light and dark mode follow the system setting; each mode has its own selected colours.

**New endpoints for the dashboard.**
- `GET /api/dashboard/summary?range=7d|30d|90d|all`: all metrics computed live. Days are counted
  in the business's time zone. "Qualified" means QUALIFIED or further along; conversion rate is
  won ÷ all leads.
- `GET /api/dashboard/activity?limit=`: business-wide activity feed.
- `GET /api/conversations?q=&needsReply=`: the inbox.
- `POST /api/leads/:id/messages`: owner reply; queued, with consent re-checked at send time.
- `POST / PUT / DELETE /api/business/services[/:id]`: OWNER only. Delete deactivates the service,
  because past analyses refer to it.

**Session token.** The token is kept in `localStorage`. That's simple, but readable by any script
on the page. Before launch, consider moving it to an httpOnly cookie.

## Follow-up automation

```
reply draft ──owner approves──▶ send job ──▶ email sent ──▶ follow-up scheduled (DRAFTING)
                                                                  │ draft job: conversation agent,
                                                                  ▼ goal FOLLOW_UP, full lead context
                                     owner approves ◀── follow-up PENDING_APPROVAL
                                           │
                                           ▼
                          SCHEDULED ──delayed send job at scheduledFor──▶ SENT ──▶ next step …
```

**Scheduling.**
- *When:* a follow-up is planned after each email we send, as long as the lead is QUALIFIED,
  CONTACTED or ENGAGED, has given email consent, hasn't replied since, and still has steps left.
- *Timing:* delays come from the business settings (`commsPrefs.followUpCadenceHours`, default
  48h / 96h / 168h; `maxFollowUps`, default 3). Each time is then moved into the business's
  working hours, in its own time zone, with DST handled.
- *Approval:* owners approve every draft by default and can edit while approving.
  `commsPrefs.autoApproveFollowUps: true` skips review for follow-ups only.
- *Off switch:* `followUpsEnabled: false` turns follow-ups off entirely.

**Stopping.** Pending follow-ups are cancelled, their drafts withdrawn and their queue jobs removed when:
- the lead replies (by webhook or logged by the owner),
- the lead unsubscribes,
- the lead is marked WON, LOST or OPTED_OUT,
- email consent is withdrawn,
- the owner rejects or cancels the follow-up.

The worker also re-checks all of this immediately before sending, so a job that was already
queued still sends nothing.

**Consent and permissions** (`modules/followUps/followUp.policy.js`). These are checked when a
follow-up is scheduled, when it's drafted and again at send time. No message is ever sent
without owner approval (or the explicit auto-approve setting for follow-ups).
- *Follow-ups* require explicit email consent, an eligible lead status, email enabled for the
  business, and no opt-out.
- *Owner-approved replies* to a lead's own enquiry need either consent or a message from the
  lead, and no opt-out.
- *Every email* carries an unsubscribe link plus `List-Unsubscribe` and one-click
  `List-Unsubscribe-Post` headers (RFC 8058).
- *Unsubscribe page:* `GET /u/:token` shows a confirmation button, so link scanners can't
  unsubscribe people. `POST` performs the opt-out and always works, whatever the lead's status.

**No duplicate emails.**
- *Deterministic job ids:* `send-<messageId>-<scheduledFor>` and `draft-<followUpId>`, so
  re-enqueuing the same work is a no-op.
- *Delivery claim:* an `email_deliveries` row with a unique `idempotency_key` is claimed with a
  conditional update, so only one worker can be sending a message at a time.
- *Provider key:* the same key is sent as the provider's `Idempotency-Key`, so a crash after the
  provider accepted an email but before we recorded it doesn't send a second copy.
- *Row lock:* scheduling locks the lead row, so concurrent schedulers create at most one
  follow-up per lead.

**Retries and failure handling.**
- *Sends:* up to 6 attempts with exponential backoff (30s × 2ⁿ). Rate limits, 5xx and network
  errors are retried; validation, authentication and unverified-domain errors fail immediately.
- *AI drafts:* up to 3 attempts. AI outages are retried; drafts that can't be produced fail
  straight away.
- *Final failures:* the message or follow-up is marked FAILED, the owner gets a notification, an
  `error`-level `Job failed permanently` log line is written, and the job stays in BullMQ's
  failed set.
- *Sweeper:* every `FOLLOW_UP_SWEEP_INTERVAL_MS` it re-enqueues work whose job went missing
  (for example after a Redis restart) and schedules any follow-ups that are due.

**Monitoring.** `GET /ops/queues` returns job counts and recent failures for each queue.
`POST /ops/queues/:queue/jobs/:id/retry` retries a failed job. Both need
`Authorization: Bearer $OPS_TOKEN` and are disabled when it isn't set. These are operator
endpoints across all businesses, so a dashboard user token can't reach them. Job payloads hold
only ids.

**Audit.** Every automated action is written to the lead timeline (`actorType` SYSTEM, AI or LEAD)
and to the structured log (`automation: <TYPE>`): scheduled, drafted, rescheduled, skipped (with a
reason code), cancelled, sent, failed, status changed.

### Email providers

| `EMAIL_PROVIDER` | Behaviour |
|---|---|
| `mock` (default) | Nothing leaves the machine. Emails are logged and kept in memory; idempotency keys are honoured like a real provider |
| `resend` | Sends via the Resend REST API (`POST /emails`, `Idempotency-Key` header). Needs `RESEND_API_KEY` and an `EMAIL_FROM_ADDRESS` on a domain verified in Resend |

The Resend adapter sends the reply-to address as `reply_to`, following Resend's snake_case REST
convention. The docs page I checked didn't show this field's exact name, so verify it with a real
send before going live.

### Replies (stopping follow-ups automatically)

Set `INBOUND_REPLY_ADDRESS=replies+{token}@in.yourdomain.com`. Outgoing emails then use a per-lead
Reply-To address. Route that address through any inbound email service (Resend inbound,
Cloudflare Email Workers, Mailgun routes) to a small relay that POSTs to
`/api/webhooks/inbound-email`:

```
X-RevenuePilot-Timestamp: <unix seconds>
X-RevenuePilot-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with INBOUND_WEBHOOK_SECRET>
{ "to": ["replies+<token>@in.yourdomain.com"], "from": "...", "subject": "...", "text": "..." }
```

The lead is found by the token in the address, never by the sender's email. Quoted history is
stripped from the reply, and signatures older than 5 minutes are rejected. Without this setup,
replies go to the owner's inbox; log them with `POST /api/leads/:id/messages/inbound` so
follow-ups stop.

## Running tests

The tests need PostgreSQL and Redis running. Redis uses `TEST_REDIS_URL` (default database 15,
which is flushed between tests). The tests run against a real PostgreSQL database named by `TEST_DATABASE_URL` (default
`…/revenuepilot_test`). Migrations are applied to it automatically, and **every table is
truncated between tests**. The suite refuses to run unless the database name contains `test`.

```bash
npm test             # API (needs PostgreSQL + Redis) then dashboard tests
npm run test:web     # dashboard only: Vitest + Testing Library, no backend needed
npm run lint
```

## API

The full reference, covering every endpoint with its role requirements and examples, is in [docs/API.md](docs/API.md).

- All `/api/*` routes need `Authorization: Bearer <token>`. The exceptions are register, login, `/api/public/*` and the signed webhooks.
- Errors are always `{ "error": { "code", "message", "details?", "requestId" } }`.

## Demo and deployment

- `npm run db:seed && npm run demo` runs the hackathon scenario (the landscaping enquiry) end to end against the running API and worker. See [docs/DEMO.md](docs/DEMO.md) for the browser walkthrough.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers a GoDaddy VPS:
  - `deploy/setup-vps.sh` provisions the server: firewall 22/80/443, Postgres and Redis on localhost with passwords, Nginx with Let's Encrypt, PM2 with log rotation, nightly `pg_dump` backups;
  - `deploy/deploy.sh` deploys;
  - `deploy/restart.sh` restarts.

## What is and isn't verified

- **Automated tests:** everything runs in mock mode.
  - API integration tests run against real PostgreSQL and Redis.
  - Dashboard component tests.
  - A browser walkthrough of every page.
- **Not exercised against the real services in this repository's tests:**
  - live Claude calls;
  - Resend delivery;
  - Google Calendar OAuth;
  - a real GoDaddy Personal Access Token.

  These adapters follow the providers' documented APIs and are covered by tests with stubbed HTTP. Verify each one with its **Test connection** button after you add credentials.

## Security notes

- **Tenant isolation.** `businessId` comes only from the verified token, and membership is
  re-checked on every request. Every repository query filters by `businessId`. Other tenants'
  records return 404, the same as records that don't exist.
- **Passwords and logins.** Passwords use bcrypt. Login takes the same time whether or not the
  account exists, and auth endpoints are rate limited.
- **Request handling.** Strict Zod schemas reject unknown fields. Helmet sets security headers,
  CORS uses an allowlist, and JSON bodies are capped at 100 kB.
- **Logs.** Logs are structured and carry a request id. Authorization headers, emails and phone
  numbers are redacted.
- **Status changes.** Updates are conditional on the status that was read, so concurrent edits
  can't both apply.
