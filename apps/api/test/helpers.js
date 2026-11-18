import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

export const app = createApp();
export const api = () => request(app);

let counter = 0;

/** Registers a user + business through the API and returns the session. */
export async function registerOwner(overrides = {}) {
  counter += 1;
  const body = {
    name: `Owner ${counter}`,
    email: `owner${counter}-${Date.now()}@example.com`,
    password: 'CorrectHorse42!',
    businessName: `Test Business ${counter}`,
    ...overrides,
  };
  const res = await api().post('/api/auth/register').send(body);
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    token: res.body.token,
    userId: res.body.user.id,
    businessId: res.body.activeBusinessId,
    email: body.email,
    password: body.password,
  };
}

/** Adds a MEMBER user to an existing business and logs them in. */
export async function addMember(businessId) {
  const outsider = await registerOwner();
  await prisma.membership.create({ data: { userId: outsider.userId, businessId, role: 'MEMBER' } });
  const res = await api()
    .post('/api/auth/login')
    .send({ email: outsider.email, password: outsider.password, businessId });
  return { token: res.body.token, userId: outsider.userId };
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });

export async function createLead(token, overrides = {}) {
  const res = await api()
    .post('/api/leads')
    .set(auth(token))
    .send({
      name: 'Jordan Rivera',
      email: 'jordan@example.com',
      source: 'WEB_FORM',
      enquiry: { channel: 'WEB_FORM', subject: 'Lawn care', message: 'Need weekly mowing from next week.' },
      consent: { email: true, source: 'web_form:test' },
      ...overrides,
    });
  if (res.status !== 201) throw new Error(`createLead failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Adds services to a business (the AI's only source of prices). */
export function seedServices(businessId) {
  return prisma.$transaction([
    prisma.service.create({
      data: { businessId, name: 'Weekly lawn maintenance', priceType: 'RANGE', priceMinCents: 4500, priceMaxCents: 8500 },
    }),
    prisma.service.create({
      data: { businessId, name: 'Garden design consultation', priceType: 'FIXED', priceMinCents: 15000, priceMaxCents: 15000 },
    }),
    prisma.service.create({ data: { businessId, name: 'Landscape installation', priceType: 'QUOTE_ONLY' } }),
  ]);
}

export function startAgent(token, leadId, body = {}) {
  return api().post(`/api/leads/${leadId}/agent-runs`).set(auth(token)).send(body);
}
