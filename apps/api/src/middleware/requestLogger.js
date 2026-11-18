import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from '../config/logger.js';

const INCOMING_ID = /^[A-Za-z0-9._-]{8,64}$/;
/** Query parameters whose values must never reach the logs (OAuth codes, tokens, search text). */
const SECRET_PARAMS = new Set(['code', 'state', 'token', 'access_token', 'refresh_token', 'key', 'signature', 'sig', 'q', 'email', 'error_description']);

/** The request URL with secrets removed: unsubscribe tokens in the path and sensitive query values. */
export function safeUrl(url = '') {
  const [path, query] = url.split('?', 2);
  const cleanPath = path.replace(/^\/u\/[^/]+/, '/u/[redacted]');
  if (!query) return cleanPath;
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) if (SECRET_PARAMS.has(key.toLowerCase())) params.set(key, '[redacted]');
  return `${cleanPath}?${params.toString().replace(/%5Bredacted%5D/g, '[redacted]')}`;
}

/**
 * Structured request logging with a correlation id. The id is accepted from
 * an upstream proxy (X-Request-Id) when well-formed, otherwise generated, and
 * echoed back so clients can quote it in bug reports.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && INCOMING_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: safeUrl(req.url) }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  autoLogging: { ignore: (req) => req.url === '/healthz' },
});
