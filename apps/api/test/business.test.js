import { describe, expect, it } from 'vitest';
import { addMember, api, auth, registerOwner } from './helpers.js';

describe('business settings', () => {
  it('returns the current business', async () => {
    const owner = await registerOwner({ businessName: 'Evergreen', timezone: 'America/Denver' });
    const res = await api().get('/api/business').set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: owner.businessId, name: 'Evergreen', timezone: 'America/Denver' });
  });

  it('lets owners update working hours and preferences', async () => {
    const owner = await registerOwner();
    const res = await api()
      .patch('/api/business')
      .set(auth(owner.token))
      .send({
        workingHours: { mon: [{ open: '08:00', close: '17:00' }] },
        commsPrefs: { tone: 'friendly', maxFollowUps: 3, followUpCadenceHours: [24, 72, 168] },
      });
    expect(res.status).toBe(200);
    expect(res.body.workingHours.mon).toEqual([{ open: '08:00', close: '17:00' }]);
    expect(res.body.commsPrefs.maxFollowUps).toBe(3);
  });

  it('rejects invalid working hours', async () => {
    const owner = await registerOwner();
    const res = await api()
      .patch('/api/business')
      .set(auth(owner.token))
      .send({ workingHours: { mon: [{ open: '17:00', close: '08:00' }], funday: [] } });
    expect(res.status).toBe(400);
  });

  it('forbids members from changing settings', async () => {
    const owner = await registerOwner();
    const member = await addMember(owner.businessId);
    const res = await api().patch('/api/business').set(auth(member.token)).send({ name: 'Renamed' });
    expect(res.status).toBe(403);
  });
});

describe('communication preferences', () => {
  it('merges partial updates so other preferences are kept', async () => {
    const owner = await registerOwner();
    await api().patch('/api/business').set(auth(owner.token)).send({ commsPrefs: { tone: 'professional', signature: 'Maria', maxFollowUps: 3 } });
    const res = await api().patch('/api/business').set(auth(owner.token)).send({ commsPrefs: { followUpCadenceHours: [24, 96, 168] } });
    expect(res.body.commsPrefs).toEqual({ tone: 'professional', signature: 'Maria', maxFollowUps: 3, followUpCadenceHours: [24, 96, 168] });
  });
});
