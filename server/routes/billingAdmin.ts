import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { isSuperAdmin } from '../middleware/admin.js';
import { sqlite } from '../db/index.js';
import { listBillingReservations, resolveBillingReservation } from '../services/billingReconciliation.js';
const router = Router();
router.use(authMiddleware, (req: AuthRequest, res, next) => {
  const user = sqlite.prepare('SELECT role,is_active FROM users WHERE id=?').get(req.userId!) as any;
  if (!user?.is_active || !isSuperAdmin(user.role)) { res.status(403).json({ error: '需要有效的超级管理员账号' }); return; }
  res.setHeader('Cache-Control','no-store'); next();
});
router.get('/', (req,res,next) => { try { res.json(listBillingReservations(Number(req.query.page || 1),String(req.query.state || 'pending'))); } catch (e) { next(e); } });
router.post('/:id/resolve', (req: AuthRequest,res,next) => {
  try { res.json(resolveBillingReservation(req.params.id,req.userId!,req.body.actual,req.body.note)); } catch (e) { next(e); }
});
export default router;
