import cors from 'cors';
import type { RequestHandler } from 'express';

export function applicationCors(config: NodeJS.ProcessEnv = process.env): RequestHandler {
  const publicApi = cors({
    origin: '*', credentials: false,
    exposedHeaders: ['X-Billing-Status', 'X-Billing-Reservation'],
  });
  const origins = config.ALLOWED_ORIGINS?.split(',').map(v => v.trim()).filter(Boolean);
  const allowed = origins?.length ? origins : config.BACKEND_URL ? [new URL(config.BACKEND_URL).origin] : [];
  const website = cors(config.NODE_ENV === 'production'
    ? { origin: allowed, credentials: true }
    : origins?.length ? { origin: origins, credentials: true } : undefined);
  return (req, res, next) => (req.path === '/v1' || req.path.startsWith('/v1/') ? publicApi : website)(req, res, next);
}
