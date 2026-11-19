import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { tierMiddleware } from '../middleware/tier.js';
import { quoteVideoRequestWithReferences } from '../services/videoQuoteService.js';
const router = Router();
router.post('/', authMiddleware, tierMiddleware('video'), async (req: AuthRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(await quoteVideoRequestWithReferences(req.body, req.userId)); } catch (error) { next(error); }
});
export default router;
