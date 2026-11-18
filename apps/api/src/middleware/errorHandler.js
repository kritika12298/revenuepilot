import { Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../lib/errors.js';
import { isProduction } from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.path} not found`));
}

/** Translates known infrastructure errors into AppErrors. */
function normalize(err) {
  if (err instanceof AppError) return err;

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        return new AppError(409, 'CONFLICT', 'A record with these details already exists', {
          fields: err.meta?.target,
        });
      case 'P2025':
        return new NotFoundError();
      case 'P2003':
        return new AppError(409, 'CONFLICT', 'Related record does not exist');
      default:
        return null;
    }
  }

  // body-parser errors carry an HTTP status and a `type`.
  if (err?.type === 'entity.parse.failed') {
    return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (err?.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  return null;
}

// Express identifies error handlers by their four-argument signature.
export function errorHandler(err, req, res, _next) {
  const known = normalize(err);
  const log = req.log ?? console;

  if (known) {
    if (known.status >= 500) log.error({ err }, known.message);
    return res.status(known.status).json({
      error: {
        code: known.code,
        message: known.message,
        ...(known.details !== undefined && { details: known.details }),
        requestId: req.id,
      },
    });
  }

  log.error({ err }, 'Unhandled error');
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
      ...(!isProduction && { debug: err?.message }),
      requestId: req.id,
    },
  });
}
