#!/usr/bin/env node
/**
 * Hackathon demo, end to end, against a running API + worker (mock mode works):
 *
 *   npm run db:seed && npm run demo
 *
 * 1. Website Intelligence reads the bundled demo site and the owner confirms the knowledge.
 * 2. A customer submits the landscaping enquiry through the public form.
 * 3. The worker runs the agents: Lead Intelligence -> Policy -> Conversation -> Policy.
 * 4. The owner reviews the drafted reply and approves it; the email provider confirms delivery.
 * 5. The Meeting Agent's slots come from working hours; the owner books a consultation.
 * 6. Revenue intelligence and recommendations update from the new data.
 *
 * Every step uses the public HTTP API exactly as the dashboard does. Nothing is
 * faked: if a step fails, the script stops and says why.
 */
const API = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const EMAIL = process.env.DEMO_EMAIL ?? 'maria@evergreen.example';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'DemoPass123!';
const SLUG = 'evergreen-landscaping';
const SITE = 'https://evergreen-landscaping.test/';
const ENQUIRY =
  'Hi, I need landscaping work for my residential property. I want garden redesign and lawn maintenance. ' +
  'Can you share an estimated cost? I would like to start within two weeks.';

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, blue: (s) => `\x1b[34m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m` };
const step = (n, title) => console.log(`\n${c.blue(`[${n}]`)} ${c.bold(title)}`);
const info = (label, value) => console.log(`    ${c.dim(label.padEnd(18))} ${value}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (cents) => (cents == null ? 'unknown' : `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
let token;
// Live Claude runs take far longer than the mock; wait accordingly (and never start a duplicate run).
let live = false;
const wait = (mockMs) => (live ? Math.max(mockMs, 240_000) : mockMs);

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(auth && token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data?.error?.message ?? res.statusText}`);
  return data;
}

async function waitFor(what, fn, { timeoutMs = 45_000, everyMs = 750 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function main() {
  console.log(c.bold('RevenuePilot demo: Evergreen Landscaping Co.'));
  await api('/readyz', { auth: false }).catch(() => {
    throw new Error(`API not reachable at ${API}. Start it with: npm run dev (and the worker: npm run dev:worker)`);
  });
  token = (await api('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, auth: false })).token;
  const ai = await api('/api/ai/status');
  live = ai.mode === 'live';
  info('Signed in as', EMAIL);
  info('AI mode', ai.mode === 'mock' ? 'mock (rule-based stand-ins, no Claude calls)' : `live (${ai.model})`);

  // 1 ---------------------------------------------------------------------------
  step(1, 'Website Intelligence reads the business website');
  await api('/api/website', { method: 'POST', body: { url: SITE } });
  const site = await waitFor('website analysis', async () => {
    const { website } = await api('/api/website');
    if (website?.status === 'FAILED') throw new Error(`Website analysis failed: ${website.lastError}`);
    return website?.status === 'COMPLETED' && website;
  }, { timeoutMs: wait(45_000) });
  info('Pages read', `${site.pagesFetched} (robots.txt respected, same-site only)`);
  info('Summary', site.summary);
  const pending = (await api('/api/knowledge?status=PENDING_REVIEW')).data;
  info('Extracted', `${pending.length} items, each with verbatim evidence from the page`);
  for (const k of pending.slice(0, 4)) console.log(`      ${c.dim('•')} ${k.title}${k.priceText ? c.dim(`  "${k.priceText}"`) : ''}`);
  for (const k of pending) await api(`/api/knowledge/${k.id}`, { method: 'PATCH', body: { status: 'APPROVED' } });
  info('Owner review', c.green(`confirmed ${pending.length} items (only confirmed items reach customers)`));

  // 2 ---------------------------------------------------------------------------
  step(2, 'A customer submits the enquiry form');
  const customer = { name: 'Alex Rivera', email: `alex.rivera+${Date.now()}@example.com` };
  const form = await api(`/api/public/forms/${SLUG}/leads`, { method: 'POST', auth: false, body: { ...customer, message: ENQUIRY, consent: true, website: '' } });
  console.log(c.dim(`    "${ENQUIRY}"`));
  info('Form response', form.message);
  const lead = await waitFor('the new lead', async () => (await api(`/api/leads?q=${encodeURIComponent(customer.email)}`)).data[0]);
  info('Lead created', `${lead.name} (${lead.source})`);

  // 3 ---------------------------------------------------------------------------
  step(3, 'The agents qualify the lead and draft a reply');
  let detail;
  try {
    detail = await waitFor('the worker to process the lead', async () => {
      // Done when the orchestrator's run has finished (whatever it decided).
      const { data } = await api(`/api/leads/${lead.id}/agent-runs`);
      const orch = data.find((r) => r.kind === 'ORCHESTRATION');
      if (orch?.status === 'FAILED') throw new Error(`Agent run failed: ${orch.error ?? orch.errorCode}`);
      return orch?.status === 'SUCCEEDED' && (await api(`/api/leads/${lead.id}`));
    }, { timeoutMs: wait(20_000), everyMs: live ? 3000 : 750 });
  } catch (err) {
    if (live) throw err;
    console.log(c.dim('    Worker did not pick the lead up in time (is `npm run dev:worker` running?). Running the agents directly.'));
    await api(`/api/leads/${lead.id}/agent-runs`, { method: 'POST', body: { agent: 'orchestrator' } });
    detail = await api(`/api/leads/${lead.id}`);
  }
  const q = detail.qualification ?? {};
  info('Lead score', `${detail.score}/100`);
  info('Intent', `${q.intent?.level ?? '–'} (${(q.intent?.signals ?? []).join('; ')})`);
  info('Requirements', (q.requirements ?? []).join(', ') || '–');
  info('Timeline', q.timeline?.description ?? q.timeline?.urgency ?? '–');
  info('Still to find out', (q.missingInformation ?? []).join(', ') || 'nothing');
  info('Deal value', `${money(detail.dealValue?.cents)} ${c.dim(`(${detail.dealValue?.basis ?? 'no basis'})`)}`);

  const runs = (await api(`/api/leads/${lead.id}/agent-runs`)).data;
  const top = runs.find((r) => !r.parentRunId) ?? runs[0];
  if (top) {
    const full = await api(`/api/agent-runs/${top.id}`);
    info('Decision timeline', '');
    for (const child of full.childRuns ?? []) console.log(`      ${c.dim('→')} ${child.agentName ?? child.kind}: ${child.decision ?? child.status}${child.reason ? c.dim(` · ${child.reason}`) : ''}`);
    if (full.decision) console.log(`      ${c.dim('=')} ${full.agentName}: ${full.decision}`);
  }

  // 4 ---------------------------------------------------------------------------
  step(4, 'The owner reviews and approves the drafted reply');
  const approval = detail.approvals.find((a) => a.status === 'PENDING' && a.type === 'OUTBOUND_MESSAGE');
  if (!approval) {
    info('Approval', 'No reply waiting (autonomy may be set to send automatically).');
  } else {
    const { data } = await api(`/api/approvals?status=PENDING&type=OUTBOUND_MESSAGE`);
    const full = data.find((a) => a.id === approval.id);
    info('Why', full?.aiRationale ?? '–');
    console.log(c.dim(`    ---\n${(full?.message?.body ?? '').split('\n').map((l) => `    ${l}`).join('\n')}\n    ---`));
    await api(`/api/approvals/${approval.id}/approve`, { method: 'POST', body: {} });
    const sent = await waitFor('the email provider to confirm delivery', async () => {
      const l = await api(`/api/leads/${lead.id}`);
      const m = l.conversations.flatMap((cv) => cv.messages ?? []).find((x) => x.id === full.message.id);
      if (m?.status === 'FAILED') throw new Error(`Delivery failed: ${m.error ?? 'see the Conversations page'}`);
      return m?.status === 'SENT' && m;
    }, { timeoutMs: wait(30_000) });
    const email = (await api('/api/integrations')).data.find((i) => i.provider === 'resend');
    info('Delivery', c.green(`sent ${c.dim(`(provider confirmed${email?.mode === 'mock' ? '; mock email provider, nothing left the server' : `; ${email?.mode}`})`)}`));
    info('Sent at', new Date(sent.sentAt).toISOString());
  }

  // 5 ---------------------------------------------------------------------------
  step(5, 'Book a garden design consultation from real availability');
  const slots = await api(`/api/leads/${lead.id}/appointments/slots?durationMinutes=90`);
  info('Calendar', `${slots.calendar} · ${slots.timeZone}`);
  if (!slots.slots.length) {
    info('Slots', 'No free slots in working hours over the next 10 days.');
  } else {
    const fmt = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: slots.timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    info('Free slots', slots.slots.slice(0, 3).map((s) => fmt(s.start)).join(' · '));
    const appointment = await api(`/api/leads/${lead.id}/appointments`, {
      method: 'POST',
      body: { startsAt: slots.slots[0].start, durationMinutes: 90, title: 'Garden design consultation' },
    });
    info('Booked', c.green(`${fmt(appointment.startsAt)} (${appointment.status.toLowerCase()})`));
  }

  // 6 ---------------------------------------------------------------------------
  step(6, 'Revenue intelligence and recommendations');
  const rev = await api('/api/revenue?range=30d');
  info('Pipeline value', `${money(rev.pipeline.valueCents)} (${rev.pipeline.leadsWithValue} of ${rev.pipeline.openLeads} open leads valued)`);
  info('Weighted', `${money(rev.pipeline.weightedCents)} ${c.dim('estimate, not guaranteed revenue')}`);
  await api('/api/recommendations/refresh', { method: 'POST' });
  const recs = (await api('/api/recommendations')).data;
  for (const r of recs.slice(0, 4)) console.log(`      ${c.dim('•')} [${r.priority}] ${r.title}`);

  console.log(`\n${c.green('Demo complete.')} Open the dashboard and look at ${c.bold(customer.name)}: the 360° profile, AI decisions, Follow-ups and Revenue pages.`);
}

main().catch((err) => {
  console.error(`\n${c.red('Demo stopped:')} ${err.message}`);
  process.exitCode = 1;
});
