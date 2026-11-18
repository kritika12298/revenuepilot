import { NotFoundError } from '../../lib/errors.js';
import * as repo from './business.repository.js';

export async function getCurrent(ctx) {
  const business = await repo.findById(ctx.businessId);
  if (!business) throw new NotFoundError('Business');
  return business;
}

/** commsPrefs is merged (partial updates keep other preferences); other fields replace. */
export async function updateCurrent(ctx, input) {
  if (input.commsPrefs) {
    const current = await repo.findById(ctx.businessId);
    input = { ...input, commsPrefs: { ...(current?.commsPrefs ?? {}), ...input.commsPrefs } };
  }
  return repo.update(ctx.businessId, input);
}

export function listServices(ctx, options = {}) {
  return repo.listServices(ctx.businessId, options);
}

export function createService(ctx, input) {
  return repo.createService(ctx.businessId, input);
}

export async function updateService(ctx, id, input) {
  const service = await repo.updateService(ctx.businessId, id, input);
  if (!service) throw new NotFoundError('Service');
  return service;
}

/**
 * Services are deactivated rather than deleted: past analyses and drafts
 * reference them. Inactive services are invisible to the AI.
 */
export async function archiveService(ctx, id) {
  const service = await repo.updateService(ctx.businessId, id, { active: false });
  if (!service) throw new NotFoundError('Service');
}
