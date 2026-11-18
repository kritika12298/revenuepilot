import * as service from './agent.service.js';

export async function start(req, res) {
  const run = await service.start(req.auth, req.valid.params.id, req.valid.body);
  res.status(201).location(`/api/agent-runs/${run.id}`).json(run);
}

export async function listForLead(req, res) {
  res.json(await service.listForLead(req.auth, req.valid.params.id, req.valid.query));
}

export async function getRun(req, res) {
  res.json(await service.getRun(req.auth, req.valid.params.id));
}

export function status(_req, res) {
  res.json(service.status());
}
