import * as service from './business.service.js';

export async function getCurrent(req, res) {
  res.json(await service.getCurrent(req.auth));
}

export async function updateCurrent(req, res) {
  res.json(await service.updateCurrent(req.auth, req.valid.body));
}

export async function listServices(req, res) {
  res.json({ data: await service.listServices(req.auth, { includeInactive: req.query.includeInactive === 'true' }) });
}

export async function createService(req, res) {
  res.status(201).json(await service.createService(req.auth, req.valid.body));
}

export async function updateService(req, res) {
  res.json(await service.updateService(req.auth, req.valid.params.id, req.valid.body));
}

export async function archiveService(req, res) {
  await service.archiveService(req.auth, req.valid.params.id);
  res.status(204).end();
}
