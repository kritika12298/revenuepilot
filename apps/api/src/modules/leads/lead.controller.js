import * as service from './lead.service.js';

export async function list(req, res) {
  res.json(await service.list(req.auth, req.valid.query));
}

export async function get(req, res) {
  res.json(await service.get(req.auth, req.valid.params.id));
}

export async function create(req, res) {
  const lead = await service.create(req.auth, req.valid.body);
  res.status(201).location(`/api/leads/${lead.id}`).json(lead);
}

export async function update(req, res) {
  res.json(await service.update(req.auth, req.valid.params.id, req.valid.body));
}

export async function changeStatus(req, res) {
  res.json(await service.changeStatus(req.auth, req.valid.params.id, req.valid.body));
}

export async function updateScore(req, res) {
  res.json(await service.updateScore(req.auth, req.valid.params.id, req.valid.body));
}

export async function remove(req, res) {
  await service.remove(req.auth, req.valid.params.id);
  res.status(204).end();
}

export async function listEvents(req, res) {
  res.json(await service.listEvents(req.auth, req.valid.params.id, req.valid.query));
}
