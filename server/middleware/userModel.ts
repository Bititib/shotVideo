import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth.js';
import { resolvePublicModelId } from '../services/publicModelNameService.js';
import { assertUserModelAccess } from '../services/userModelAccessService.js';

export function userModelMiddleware(defaultModel: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const name = req.body?.model ?? defaultModel;
      if (typeof name === 'string') {
        const model = resolvePublicModelId(name, req.body);
        assertUserModelAccess(req.userId, model);
        if (req.body?.model !== undefined) req.body.model = model;
      }
      next();
    } catch (error: any) { res.status(error.status || 400).json({ error: error.message }); }
  };
}
