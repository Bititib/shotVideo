import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { tierMiddleware } from '../middleware/tier.js';
import { quoteVideoRequest } from '../services/videoQuoteService.js';
const router = Router();
router.post('/', authMiddleware, tierMiddleware('video'), (req: AuthRequest, res, next) => {
  try { res.setHeader('Cache-Control', 'private, no-store'); res.json(quoteVideoRequest(req.body, req.userId)); } catch (error) { next(error); }
});
export default router;
