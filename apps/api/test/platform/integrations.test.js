import { createHmac } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '../../src/lib/prisma.js';
import { encryptJson, decryptJson } from '../../src/lib/secrets.js';
import { createGoDaddyClient } from '../../src/integrations/godaddy.js';
import { createOAuthState, deps } from '../../src/modules/integrations/integration.service.js';
import { getQueues, QUEUES } from '../../src/queue/queues.js';
import { addMember, api, auth, registerOwner } from '../helpers.js';

const realFetch = deps.fetch;
afterEach(() => {
  deps.fetch = realFetch;
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('integration hub', () => {
  it('reports honest statuses in mock mode and never claims unconfigured integrations work', async () => {
    const o = await registerOwner();
    const res = await api().get('/api/integrations').set(auth(o.token));
    const by = Object.fromEntries(res.body.data.map((i) => [i.provider, i]));
    expect(Object.keys(by)).toEqual(['godaddy_domains', 'godaddy_websites', 'claude', 'google_calendar', 'resend', 'website_webhook']);
    expect(by.claude).toMatchObject({ status: 'MOCK', lastSyncAt: null, mode: 'mock', note: expect.stringMatching(/Mock AI is active/) });
    expect(by.resend).toMatchObject({ status: 'MOCK', lastSyncAt: null, mode: 'mock' });
    expect(by.google_calendar).toMatchObject({ status: 'DISABLED', note: expect.stringMatching(/GOOGLE_CLIENT_ID/) });
    expect(by.godaddy_websites).toMatchObject({ status: 'AVAILABLE', mode: 'embed', note: expect.stringMatching(/does not offer a public Websites \+ Marketing API/) });
    expect(by.godaddy_websites.config.formUrl).toMatch(/^\/f\//);
    expect((await api().post('/api/integrations/claude/test').set(auth(o.token))).body).toEqual({ ok: true, detail: 'Mock AI is active; nothing to test.' });
  });

  it('connects GoDaddy Domains with a Personal Access Token (Bearer) and stores it encrypted', async () => {
    const o = await registerOwner();
    const calls = [];
    deps.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return json(200, [{ domain: 'evergreen-landscaping.com', domainId: 1, status: 'ACTIVE', expires: '2027-05-01T00:00:00Z', renewAuto: true }]);
    };
    const res = await api().put('/api/integrations/godaddy_domains').set(auth(o.token)).send({ token: 'gd-pat-1234567890' });
    expect(res.status).toBe(200);
    expect(res.body.domains[0].domain).toBe('evergreen-landscaping.com');
    expect(calls[0].url).toBe('https://api.godaddy.com/v1/domains?statuses=ACTIVE&limit=100');
    expect(calls[0].init.headers.Authorization).toBe('Bearer gd-pat-1234567890');
    const row = await prisma.integrationConnection.findFirst({ where: { businessId: o.businessId, provider: 'godaddy_domains' } });
    expect(row.status).toBe('CONNECTED');
    expect(row.secretsEnc).not.toContain('gd-pat');
    expect(decryptJson(row.secretsEnc)).toEqual({ token: 'gd-pat-1234567890' });
    const listed = (await api().get('/api/integrations').set(auth(o.token))).body.data.find((i) => i.provider === 'godaddy_domains');
    expect(JSON.stringify(listed)).not.toContain('gd-pat');
  });

  it('surfaces GoDaddy errors clearly and records them', async () => {
    const o = await registerOwner();
    deps.fetch = async () => json(403, { code: 'ACCESS_DENIED', message: 'Authenticated user is not allowed access' });
    const res = await api().put('/api/integrations/godaddy_domains').set(auth(o.token)).send({ token: 'gd-pat-bad-token' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/403: the token lacks domains.domain:read or the account is not eligible/);
    expect(await prisma.integrationConnection.findFirst({ where: { businessId: o.businessId } })).toMatchObject({ status: 'ERROR' });
    await expect(createGoDaddyClient({ token: 't', fetch: async () => json(401, {}) }).listDomains()).rejects.toThrow(/invalid or expired/);
  });

  it('restricts integration changes to owners and keeps secrets per business', async () => {
    const o = await registerOwner();
    const m = await addMember(o.businessId);
    expect((await api().post('/api/integrations/website_webhook/rotate').set(auth(m.token))).status).toBe(403);
    expect((await api().put('/api/integrations/godaddy_domains').set(auth(m.token)).send({ token: 'x'.repeat(12) })).status).toBe(403);
    expect((await api().delete('/api/integrations/claude').set(auth(o.token))).status).toBe(422);
  });

  it('accepts signed website webhook leads and rejects bad signatures', async () => {
    const o = await registerOwner();
    const { secret } = (await api().post('/api/integrations/website_webhook/rotate').set(auth(o.token))).body;
    expect(secret).toMatch(/^whsec_/);
    const biz = await prisma.business.findUnique({ where: { id: o.businessId } });
    const body = JSON.stringify({ name: 'Webhook Lead', email: 'wh@example.com', message: 'Garden redesign please', consent: true });
    const ts = Math.floor(Date.now() / 1000);
    const sig = (s) => `sha256=${createHmac('sha256', s).update(`${ts}.${body}`).digest('hex')}`;
    const send = (signature) => api().post(`/api/webhooks/leads/${biz.slug}`).set({ 'Content-Type': 'application/json', 'X-RevenuePilot-Timestamp': String(ts), 'X-RevenuePilot-Signature': signature }).send(body);

    expect((await send(sig('wrong-secret'))).status).toBe(401);
    const ok = await send(sig(secret));
    expect(ok.status).toBe(202);
    const lead = await prisma.lead.findUnique({ where: { id: ok.body.leadId } });
    expect(lead).toMatchObject({ businessId: o.businessId, source: 'API', consentEmail: true, consentSource: 'webhook:website' });
    expect(await getQueues()[QUEUES.FOLLOW_UPS].getJob(`process-${lead.id}-created`)).toBeTruthy();

    // Replaying the exact same signed request is refused: no duplicate lead.
    expect((await send(sig(secret))).status).toBe(409);
    expect(await prisma.lead.count({ where: { businessId: o.businessId } })).toBe(1);

    // Rotating invalidates the old secret.
    await api().post('/api/integrations/website_webhook/rotate').set(auth(o.token));
    expect((await send(sig(secret))).status).toBe(401);
  });

  it('completes Google OAuth only in the browser that started it, once, for an owner; stores only the encrypted token', async () => {
    const o = await registerOwner();
    const ctx = { businessId: o.businessId, userId: o.userId };
    deps.fetch = async (url) => (String(url).includes('oauth2.googleapis.com/token') ? json(200, { access_token: 'a', refresh_token: 'refresh-123', expires_in: 3600 }) : json(404, {}));
    const callback = (state, nonce) => {
      const req = api().get(`/api/integrations/google/callback?code=abc123&state=${state}`);
      return nonce ? req.set('Cookie', `rp_google_oauth=${nonce}`) : req;
    };

    // A link opened in another browser (no matching cookie) is refused: the attacker's link can't capture a victim's calendar.
    const { state, nonce } = await createOAuthState(ctx);
    expect((await callback(state)).headers.location).toMatch(/google=error$/);
    expect((await callback(state, 'someone-elses-nonce')).headers.location).toMatch(/google=error$/);
    expect(await prisma.integrationConnection.count({ where: { provider: 'google_calendar' } })).toBe(0);

    const ok = await callback(state, nonce);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toMatch(/\/integrations\?google=connected$/);
    expect(ok.headers['set-cookie']?.join(';')).toMatch(/rp_google_oauth=;/); // cleared
    const row = await prisma.integrationConnection.findFirst({ where: { businessId: o.businessId, provider: 'google_calendar' } });
    expect(decryptJson(row.secretsEnc)).toEqual({ refreshToken: 'refresh-123' });

    // Single use.
    expect((await callback(state, nonce)).headers.location).toMatch(/google=error$/);

    // Wrong purpose, and a starter who is no longer an owner, are refused.
    const forged = jwt.sign({ bid: o.businessId, uid: o.userId, jti: 'x', purpose: 'login' }, process.env.JWT_SECRET);
    expect((await callback(forged, nonce)).headers.location).toMatch(/google=error$/);
    const fresh = await createOAuthState(ctx);
    await prisma.membership.updateMany({ where: { userId: o.userId, businessId: o.businessId }, data: { role: 'MEMBER' } });
    expect((await callback(fresh.state, fresh.nonce)).headers.location).toMatch(/google=error$/);
  });

  it('encrypts secrets with authenticated encryption', () => {
    const enc = encryptJson({ a: 1 });
    expect(decryptJson(enc)).toEqual({ a: 1 });
    const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decryptJson(tampered)).toThrow();
  });
});
