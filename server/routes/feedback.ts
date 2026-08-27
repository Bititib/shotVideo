import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { FeedbackService } from '../services/feedbackService.js';

const router = Router();
router.use(authMiddleware);

router.post('/', (req: AuthRequest, res: Response) => {
  try {
    const result = FeedbackService.create(req.userId!, req.body || {});
    res.status(result.duplicate ? 200 : 201).json({
      message: result.duplicate ? '该问题已经反馈，管理员正在处理中' : '反馈已提交，管理员会尽快处理',
      ...result,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '提交反馈失败' });
  }
});

export default router;
