import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { webhookRateLimit } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { apiRateLimit } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { healthRouter } from './modules/health/health.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { businessRouter } from './modules/business/business.routes.js';
import { leadRouter } from './modules/leads/lead.routes.js';
import { agentRunRouter, aiRouter, leadAgentRouter } from './modules/agents/agent.routes.js';
import { notificationRouter } from './modules/notifications/notification.routes.js';
import { followUpRouter, leadFollowUpRouter } from './modules/followUps/followUp.routes.js';
import { approvalRouter } from './modules/approvals/approval.routes.js';
import { conversationRouter, leadMessageRouter, unsubscribeRouter, webhookRouter } from './modules/messages/message.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { opsRouter } from './routes.ops.js';
import { knowledgeRouter, websiteRouter } from './modules/knowledge/knowledge.routes.js';
import { autonomyRouter } from './modules/autonomy/autonomy.routes.js';
import { appointmentRouter, leadAppointmentRouter } from './modules/appointments/appointment.routes.js';
import { publicRouter } from './modules/public/public.routes.js';
import { revenueRouter } from './modules/revenue/revenue.routes.js';
import { recommendationRouter } from './modules/recommendations/recommendation.routes.js';
import { eventsRouter } from './modules/events/events.routes.js';
import { searchRouter } from './modules/search/search.routes.js';
import { simulatorRouter } from './modules/simulator/simulator.routes.js';
import { integrationRouter, leadWebhookRouter } from './modules/integrations/integration.routes.js';

export function createApp() {
  const app = express();

  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(requestLogger);
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Allow same-origin / server-to-server requests (no Origin header).
        if (!origin || env.CORS_ORIGINS.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      exposedHeaders: ['X-Request-Id', 'Location'],
      maxAge: 600,
    }),
  );
  // Signed webhooks need the raw body, so they are mounted before JSON parsing.
  app.use('/api/webhooks', webhookRateLimit);
  app.use('/api/webhooks/leads', leadWebhookRouter);
  app.use('/api/webhooks', webhookRouter);
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter);
  app.use('/u', unsubscribeRouter);
  app.use('/ops', opsRouter);

  const api = express.Router();
  api.use(apiRateLimit);
  api.use('/auth', authRouter);
  api.use('/public', publicRouter);
  api.use('/business', businessRouter);
  api.use('/leads/:id/agent-runs', leadAgentRouter);
  api.use('/leads/:id/follow-ups', leadFollowUpRouter);
  api.use('/leads/:id/messages', leadMessageRouter);
  api.use('/follow-ups', followUpRouter);
  api.use('/approvals', approvalRouter);
  api.use('/conversations', conversationRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/website', websiteRouter);
  api.use('/autonomy', autonomyRouter);
  api.use('/revenue', revenueRouter);
  api.use('/recommendations', recommendationRouter);
  api.use('/events', eventsRouter);
  api.use('/search', searchRouter);
  api.use('/simulations', simulatorRouter);
  api.use('/integrations', integrationRouter);
  api.use('/appointments', appointmentRouter);
  api.use('/leads/:id/appointments', leadAppointmentRouter);
  api.use('/knowledge', knowledgeRouter);
  api.use('/leads', leadRouter);
  api.use('/agent-runs', agentRunRouter);
  api.use('/notifications', notificationRouter);
  api.use('/ai', aiRouter);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
