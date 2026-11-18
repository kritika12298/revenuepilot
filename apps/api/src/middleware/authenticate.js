import { verifyAccessToken } from '../modules/auth/token.js';
import { findMembership } from '../modules/auth/auth.repository.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

/**
 * Verifies the bearer token and resolves the caller's tenant context.
 * Membership is re-checked on every request so revoked access takes effect
 * immediately, without waiting for the token to expire.
 */
export async function authenticate(req, _res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw new UnauthorizedError();

  const claims = verifyAccessToken(header.slice('Bearer '.length).trim());
  const membership = await findMembership(claims.sub, claims.bid);
  if (!membership) throw new UnauthorizedError('Session is no longer valid');

  req.auth = Object.freeze({
    userId: membership.userId,
    businessId: membership.businessId,
    role: membership.role,
    expiresAt: claims.exp ? claims.exp * 1000 : null,
  });
  req.log = req.log.child({ userId: membership.userId, businessId: membership.businessId });
  next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) throw new ForbiddenError();
    next();
  };
}
