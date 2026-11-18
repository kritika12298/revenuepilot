# CLAUDE.md

Guidance for AI coding assistants and contributors working in this repository.

## What this is

RevenuePilot is an AI sales assistant for small businesses (GoDaddy hackathon). It is an npm workspaces monorepo:

- `apps/api`: Node 22, **ESM JavaScript (no TypeScript)**, Express 5, Prisma 6 / PostgreSQL, BullMQ / Redis, Zod 4, pino, `@anthropic-ai/sdk`.
- `apps/web`: React 19, Vite, TanStack Query 5, React Router, Tailwind v4, lucide-react.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before making non-trivial changes.

## Commands

```bash
docker compose up -d                # Postgres + Redis (localhost only)
npm install
npm run db:deploy && npm run db:seed
npm run dev | npm run dev:worker | npm run dev:web   # API :4000, worker, dashboard :5173
npm test                            # API (real Postgres + Redis, test DB) then web
npm run test:api | npm run test:web
npm run lint                        # ESLint (API + web)
npm run build                       # web production build
npm run demo                        # end-to-end demo against the running API + worker
```

Migrations: edit `apps/api/prisma/schema.prisma`, then `npm run db:migrate -w apps/api -- --name <name>` (interactive). In non-interactive shells, generate the SQL with `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <db> --script`, then apply it with `db:deploy`. Postgres can't use a new enum value in the same transaction that adds it, so split those migrations in two.

## Non-negotiable rules

1. **Tenant isolation.** `businessId` comes from `req.auth` (the verified JWT) only. Every Prisma query on tenant data filters by it. Cross-tenant access returns 404.
2. **The AI proposes; the backend decides.** Claude may only call allowlisted tools. `toolExecutor` validates input (Zod), scopes it to the lead and business, and audits every call. Every side effect (email, booking, follow-up, approval) also passes `evaluatePolicy` in `src/ai/policy/policyAgent.js`. Never let free-form model output trigger a critical operation.
3. **No invented facts.**
   - Prices come only from `Service` rows (the published price list); `outboundGuard` enforces this.
   - Website knowledge is used only once `APPROVED`.
   - Never invent prices, availability, discounts or policies.
   - Deal values are `null` (shown as "unknown") without an owner value, a stated budget or a matched published price.
4. **Owner approval.** Discounts, quotations, contracts and custom pricing always need approval; this is locked. Other autonomy comes from `AutonomyPolicy`.
5. **Honest status.**
   - A message is "sent" only when the provider confirms it (`EmailDelivery`).
   - An appointment is "booked" only after the calendar write succeeds.
   - Integration statuses come from real configuration and results (`MOCK` / `DISABLED` / `NOT_CONFIGURED` are distinct).
   - No fake metrics, fabricated agent activity or seeded "running" runs.
6. **Explanations, not reasoning.** Store and show short user-facing `decision` and `reason` text. Never persist or expose private model reasoning.
7. **Simulations are labelled** and never applied automatically. Revenue numbers are **estimates**, not guaranteed revenue.
8. **Secrets.** Secrets live only in env vars (`apps/api/.env`, gitignored). Integration secrets are AES-256-GCM encrypted (`src/lib/secrets.js`) and never returned by the API. Never hardcode keys or commit `.env`.
9. **Outbound fetches** (Website Intelligence) must go through `src/website/safeFetch.js` and `netGuard.js` (SSRF protection at connect time, limits, robots.txt).
10. **Consent.** Email requires lead consent. Opt-out is re-checked at send time.

## Conventions

- **API module layout:** `src/modules/<domain>/` holds `*.routes.js` (validate with `validate({ params, query, body })` and strict Zod objects), then `*.service.js`, then `*.repository.js`. Throw the error classes in `src/lib/errors.js`. Owner-only routes use `requireRole('OWNER')`.
- **Agents:** `src/ai/agents/*.js` (prompt plus tool allowlist), registered in `agents/index.js`. Tools go in `src/ai/tools/*.js` via `defineTool({ name, description, access, input, handler })` (`src/ai/tools/define.js`). Add mock behaviour in `src/ai/mock/` so tests and demos work without Claude.
- **Background work:** add a processor in `src/jobs/` and register it in `src/worker.js`. Use deterministic job ids (idempotent re-enqueue). The database is the source of truth.
- **Live UI updates:** call `publishEvent(businessId, type, data)` and handle it in `apps/web/src/lib/liveEvents.js`.
- **Web:** one TanStack Query hook per resource in `src/api/hooks.js`; mutations invalidate the keys they affect.
  - Reuse `components/ui/*` (Card, Button, Field/Select/Input, Badge, States, Dialog, Toast).
  - Every view has loading, empty and error states.
  - Keep the existing design: dark/light themes, blue accent, typography, sidebar.
  - Charts are single-series in the validated accent colour, with a tooltip and a Table view.
- **Tests:** API tests are in `apps/api/test/**` (Vitest + Supertest; helpers in `test/helpers.js`; `scriptedClient` in `test/ai/scripted.js` for deterministic model turns). Web tests sit next to components and use `renderApp` and `mockApi` from `src/test/render.jsx`. Add tests with every behaviour change.
- **AI model:** `claude-opus-5-5` by default (`ANTHROPIC_MODEL`). Running live Claude bills the user's account, so ask before running live agent calls; mock mode (`AI_MODE=mock`) is the default for tests.

## Demo data

`npm run db:seed` recreates two tenants: **Evergreen Landscaping** (`maria@evergreen.example` owner, `sam@evergreen.example` member) and **Northside Plumbing** (`dev@northside.example`). The password is `DemoPass123!`. Seeded analyses contain only facts stated in the seeded messages. In `DEMO_MODE`, `https://evergreen-landscaping.test/` is served from `apps/api/demo/website/` for Website Intelligence.
