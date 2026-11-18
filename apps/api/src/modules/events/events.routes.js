import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { findMembership } from '../auth/auth.repository.js';
import { subscribe } from './eventBus.js';

/** How often a long-lived stream re-checks that the user still belongs to the business. */
const MEMBERSHIP_RECHECK_MS = 60_000;

/**
 * GET /api/events/stream: Server-Sent Events for the signed-in business.
 * The dashboard reads it with fetch() so the bearer token stays in a header
 * (never in the URL).
 */
export const eventsRouter = Router();
eventsRouter.get('/stream', authenticate, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: {}\n\n`);
  const unsubscribe = subscribe(req.auth.businessId, (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event.data, at: event.at })}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  // Access revoked (or the session expired) while connected: end the stream.
  const recheck = setInterval(async () => {
    const stillMember = await findMembership(req.auth.userId, req.auth.businessId).catch(() => null);
    const expired = req.auth.expiresAt && Date.now() >= req.auth.expiresAt;
    if (!stillMember || expired) {
      res.write(`event: session-ended\ndata: {}\n\n`);
      res.end();
    }
  }, MEMBERSHIP_RECHECK_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(recheck);
    unsubscribe();
  });
});
