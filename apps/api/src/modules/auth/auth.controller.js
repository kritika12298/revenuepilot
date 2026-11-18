import * as service from './auth.service.js';

export async function register(req, res) {
  res.status(201).json(await service.register(req.valid.body));
}

export async function login(req, res) {
  res.json(await service.login(req.valid.body));
}

export async function switchBusiness(req, res) {
  res.json(await service.switchBusiness(req.auth, req.valid.body.businessId));
}

export async function me(req, res) {
  res.json(await service.me(req.auth));
}
