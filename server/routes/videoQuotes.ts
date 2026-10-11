import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tierMiddleware } from '../middleware/tier.js';
import { quoteVideoRequest } from '../services/videoQuoteService.js';
const router = Router();
router.post('/', authMiddleware, tierMiddleware('video'), (req, res, next) => {
  try { res.json(quoteVideoRequest(req.body)); } catch (error) { next(error); }
});
export default router;
