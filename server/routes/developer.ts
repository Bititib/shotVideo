import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { getDeveloperModels } from '../services/developerModelService.js';

const router = Router();
router.use(authMiddleware);
router.get('/models', (req: AuthRequest, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const value = req.query.tokenId;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return res.status(400).json({ error: '请选择有效的 API Key' });
  }
  try { res.json(getDeveloperModels(req.userId!, Number(value))); } catch (error) { next(error); }
});
export default router;
