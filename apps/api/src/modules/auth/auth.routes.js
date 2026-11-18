import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authRateLimit } from '../../middleware/rateLimit.js';
import { loginSchema, registerSchema, switchBusinessSchema } from './auth.schemas.js';
import * as controller from './auth.controller.js';

export const authRouter = Router();

authRouter.post('/register', authRateLimit, validate({ body: registerSchema }), controller.register);
authRouter.post('/login', authRateLimit, validate({ body: loginSchema }), controller.login);
authRouter.post(
  '/switch-business',
  authenticate,
  validate({ body: switchBusinessSchema }),
  controller.switchBusiness,
);
authRouter.get('/me', authenticate, controller.me);
