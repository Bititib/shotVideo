import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { confirmPidoiImageFailure, recheckPidoiImage } from '../services/pidoiImageResolutionService.js';
const router = Router();
router.use(authMiddleware, adminMiddleware);
router.post('/:id/image-recheck', async (req: AuthRequest, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { res.json(await recheckPidoiImage(Number(req.params.id), req.userId!)); }
  catch (error: any) { res.status(error.status || 500).json({ error: error.message || '查询失败' }); }
});
router.post('/:id/image-confirm-failure', (req: AuthRequest, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { res.json(confirmPidoiImageFailure(Number(req.params.id), req.userId!, req.body?.confirmedFailure, req.body?.note)); }
  catch (error: any) { res.status(error.status || 500).json({ error: error.message || '退款失败' }); }
});
export default router;
