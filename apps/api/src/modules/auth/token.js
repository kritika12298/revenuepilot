import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { UnauthorizedError } from '../../lib/errors.js';

const ISSUER = 'revenuepilot-api';
const AUDIENCE = 'revenuepilot-dashboard';

/** Access token scoped to one business; `bid` selects the active tenant. */
export function signAccessToken({ userId, businessId }) {
  return jwt.sign({ bid: businessId }, env.JWT_SECRET, {
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

export function verifyAccessToken(token) {
  try {
    const claims = jwt.verify(token, env.JWT_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof claims.sub !== 'string' || typeof claims.bid !== 'string') {
      throw new Error('missing claims');
    }
    return claims;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
}
