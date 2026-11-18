import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../lib/errors.js';
import { signAccessToken } from './token.js';
import * as repo from './auth.repository.js';

// Compared against when the email is unknown so response timing does not
// reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), env.BCRYPT_ROUNDS);

export function slugify(name) {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'business'
  );
}

async function uniqueSlug(name) {
  const base = slugify(name);
  if (!(await repo.slugExists(base))) return base;
  for (let i = 0; i < 5; i += 1) {
    const candidate = `${base}-${randomBytes(3).toString('hex')}`;
    if (!(await repo.slugExists(candidate))) return candidate;
  }
  throw new ConflictError('Could not allocate a unique business slug, please try again');
}

async function sessionFor(userId, businessId) {
  const profile = await repo.findUserWithMemberships(userId);
  return {
    token: signAccessToken({ userId, businessId }),
    user: { id: profile.id, email: profile.email, name: profile.name },
    activeBusinessId: businessId,
    businesses: profile.memberships.map((m) => ({ ...m.business, role: m.role })),
  };
}

export async function register(input) {
  if (await repo.findUserByEmail(input.email)) {
    throw new ConflictError('An account with this email already exists');
  }
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  const { user, business } = await repo.createUserWithBusiness({
    user: { email: input.email, name: input.name, passwordHash },
    business: {
      name: input.businessName,
      slug: await uniqueSlug(input.businessName),
      timezone: input.timezone,
    },
  });
  return sessionFor(user.id, business.id);
}

export async function login({ email, password, businessId }) {
  const user = await repo.findUserByEmail(email);
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw new UnauthorizedError('Invalid email or password');

  const membership = businessId
    ? await repo.findMembership(user.id, businessId)
    : await repo.findFirstMembership(user.id);
  if (!membership) throw new ForbiddenError('You are not a member of this business');

  return sessionFor(user.id, membership.businessId);
}

export async function switchBusiness(auth, businessId) {
  const membership = await repo.findMembership(auth.userId, businessId);
  if (!membership) throw new ForbiddenError('You are not a member of this business');
  return sessionFor(auth.userId, businessId);
}

export async function me(auth) {
  const profile = await repo.findUserWithMemberships(auth.userId);
  if (!profile) throw new NotFoundError('User');
  return {
    user: { id: profile.id, email: profile.email, name: profile.name, createdAt: profile.createdAt },
    activeBusinessId: auth.businessId,
    role: auth.role,
    businesses: profile.memberships.map((m) => ({ ...m.business, role: m.role })),
  };
}
