# Hackathon demo: Evergreen Landscaping Co.

Everything below works in **mock mode**: no Anthropic key and no email provider are needed. In mock mode the agents use deterministic, rule-based stand-ins with the same tools, the same validation and the same policy checks as live Claude. Emails are recorded but never leave the machine. The UI labels mock mode ("AI: mock mode" in the sidebar, "Mock mode" on Integrations).

## Setup (once)

```bash
docker compose up -d                 # Postgres + Redis on localhost
cp apps/api/.env.example apps/api/.env   # then set JWT_SECRET (see README)
npm install
npm run db:deploy && npm run db:seed
```

Start the three processes in separate terminals:

```bash
npm run dev          # API      http://localhost:4000
npm run dev:worker   # worker   (queues: lead processing, email, follow-ups, website analysis)
npm run dev:web      # dashboard http://localhost:5173
```

Sign in as `maria@evergreen.example` / `DemoPass123!` (owner). `sam@evergreen.example` is a member.

## Option A: scripted (2 minutes, terminal)

```bash
npm run db:seed && npm run demo
```

The script drives the real HTTP API and prints each step. It stops with the reason if anything fails.

## Option B: live walkthrough (about 6 minutes, browser)

1. **Overview.** Ten KPIs from real data:
   - totals, qualified, conversion, win rate;
   - pending follow-ups, follow-ups to approve, approvals;
   - estimated pipeline, average score, median first response.

   Also shown: the six AI agent cards with live status, the 7-stage funnel, recommendations, approvals and activity.
2. **Knowledge → Analyse website** with `https://evergreen-landscaping.test/`. The crawler reads 4 pages (respecting `robots.txt`). Website Intelligence extracts about 12 items. Each item shows its source page and the verbatim evidence. **Approve** a few: only approved items are used with customers. *Add to price list* turns a service into a priced service.
3. **The customer enquiry.** Open **Integrations → GoDaddy Websites + Marketing → Hosted enquiry form** (`/f/evergreen-landscaping`). This is the form a GoDaddy site embeds through an HTML section. Submit:

   > Hi, I need landscaping work for my residential property. I want garden redesign and lawn maintenance. Can you share an estimated cost? I would like to start within two weeks.

   Tick the consent box.
4. Back in the dashboard, the **Live** indicator and the notification bell update within seconds. The worker runs Sales Orchestrator → Lead Intelligence → Policy → Conversation → Policy.
5. **Leads → Alex (or whatever name you used).** The 360° profile:
   - **AI analysis:** requirements (garden design consultation, weekly lawn maintenance); timeline "within two weeks"; budget *not stated*, so it is listed under *Still to find out*; sentiment; score with reasons.
   - **Potential deal value:** $215, *based on published prices*. This is an estimate with its basis shown, not a promise.
   - **Recommended next action:** *Waiting for your approval*.
   - **AI decisions tab:** every agent step, with its trigger, a short decision and reason, and every tool call with its validated input and result.
6. **Approve the reply** in *Needs your approval*, on the Overview or on the lead. The draft quotes only the published prices ($150 consultation, $45–$85 per visit) and asks for the budget. No discount or guarantee is invented. The message shows **Sent** only after the email provider confirms (here, the mock provider). The Follow-up Agent then plans a follow-up inside working hours.
7. **Book** on the lead page. Slots come from working hours minus existing appointments. Pick one and it is confirmed. A confirmation email is queued for the customer (consent is re-checked when it is sent), plus a reminder 24 h before if the appointment is more than a day away.
8. **Revenue.**
   - Pipeline and weighted values, labelled as estimates.
   - Leads at risk, with the reasons.
   - Stage probabilities, which use defaults until there is enough history.
9. **Simulator → Faster first responses → Run.**
   - The result is labelled *Simulation, not an actual result*.
   - With fewer than 5 leads per group it refuses to estimate, and says why.
   - Nothing is applied automatically.
10. **Autonomy.**
    - Turn on *Send replies without my approval*. The next permitted reply is sent automatically, and the Policy & Approval Agent records **Allowed**.
    - Discounts, quotes, contracts and custom pricing remain locked to *Approval required*.
11. **Integrations.** Statuses are honest: Claude *Mock mode*, Resend *Mock mode*, Google Calendar *Not available* (no OAuth client configured), GoDaddy Domains *Not connected* until a Personal Access Token is added.

## Talking points

- The AI proposes; the backend decides. Allowlisted tools, Zod validation, tenant scoping and deterministic policy checks wrap every side effect.
- No invented facts. Prices come from the price list, extracted knowledge needs evidence and owner review, and deal values are *unknown* rather than guessed.
- Every decision can be audited: open **AI activity** for every run, step and tool call.

## Reset

`npm run db:seed` restores the demo businesses. It deletes only the demo tenants and leaves other data alone.
