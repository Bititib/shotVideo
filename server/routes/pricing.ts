import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { PricingService } from '../services/pricingService.js';

const router = Router();
router.use(authMiddleware, adminMiddleware);

router.get('/', async (req: AuthRequest, res: Response) => {
  try { res.json(PricingService.getPricingRules()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try { PricingService.createPricingRule(req.body); res.json({ message: '创建成功' }); }
  catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try { PricingService.updatePricingRule(parseInt(req.params.id), req.body); res.json({ message: '更新成功' }); }
  catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try { PricingService.deletePricingRule(parseInt(req.params.id)); res.json({ message: '删除成功' }); }
  catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

export default router;
