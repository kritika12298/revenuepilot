import { describe, expect, it } from 'vitest';
import { api, auth, registerOwner } from './helpers.js';

describe('auth', () => {
  it('registers an owner with a new business', async () => {
    const res = await api().post('/api/auth/register').send({
      name: 'Maria Lopez',
      email: '  Maria@Example.COM ',
      password: 'CorrectHorse42!',
      businessName: 'Evergreen Landscaping Co.',
      timezone: 'America/Denver',
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email: 'maria@example.com', name: 'Maria Lopez' });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.businesses).toEqual([
      expect.objectContaining({ name: 'Evergreen Landscaping Co.', slug: 'evergreen-landscaping-co', role: 'OWNER' }),
    ]);
  });

  it('rejects duplicate emails', async () => {
    const owner = await registerOwner();
    const res = await api().post('/api/auth/register').send({
      name: 'Someone',
      email: owner.email,
      password: 'CorrectHorse42!',
      businessName: 'Another Biz',
    });
    expect(res.status).toBe(409);
  });

  it('gives a unique slug to businesses with the same name', async () => {
    const a = await registerOwner({ businessName: 'Same Name' });
    const b = await registerOwner({ businessName: 'Same Name' });
    const [ra, rb] = await Promise.all([
      api().get('/api/business').set(auth(a.token)),
      api().get('/api/business').set(auth(b.token)),
    ]);
    expect(ra.body.slug).toBe('same-name');
    expect(rb.body.slug).toMatch(/^same-name-[0-9a-f]{6}$/);
  });

  it('validates registration input with field-level details', async () => {
    const res = await api().post('/api/auth/register').send({
      name: '',
      email: 'not-an-email',
      password: 'short',
      businessName: 'X',
      timezone: 'Mars/Olympus',
      isAdmin: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'email', 'password', 'businessName', 'timezone']));
  });

  it('logs in with valid credentials and rejects wrong passwords', async () => {
    const owner = await registerOwner();
    const ok = await api().post('/api/auth/login').send({ email: owner.email, password: owner.password });
    expect(ok.status).toBe(200);
    expect(ok.body.activeBusinessId).toBe(owner.businessId);

    const bad = await api().post('/api/auth/login').send({ email: owner.email, password: 'WrongPassword1!' });
    expect(bad.status).toBe(401);

    const unknown = await api().post('/api/auth/login').send({ email: 'ghost@example.com', password: 'Whatever123!' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(bad.body.error.message);
  });

  it('returns the current user from /me', async () => {
    const owner = await registerOwner();
    const res = await api().get('/api/auth/me').set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ activeBusinessId: owner.businessId, role: 'OWNER' });
  });

  it('requires a valid bearer token', async () => {
    expect((await api().get('/api/auth/me')).status).toBe(401);
    expect((await api().get('/api/auth/me').set(auth('garbage'))).status).toBe(401);
    expect((await api().get('/api/auth/me').set('Authorization', 'Basic abc')).status).toBe(401);
  });

  it('invalidates tokens when membership is removed', async () => {
    const owner = await registerOwner();
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.membership.deleteMany({ where: { userId: owner.userId } });
    const res = await api().get('/api/auth/me').set(auth(owner.token));
    expect(res.status).toBe(401);
  });

  it('only switches to businesses the user belongs to', async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const res = await api()
      .post('/api/auth/switch-business')
      .set(auth(a.token))
      .send({ businessId: b.businessId });
    expect(res.status).toBe(403);
  });
});
