import { Router, Request, Response } from 'express';
import { AuthService } from '../services/authService.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';

const router = Router();
router.post('/logout', (_req,res) => { res.clearCookie('media_session',{path:'/'}); res.json({success:true}); });

export const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: '注册尝试过于频繁，请稍后再试' } });
router.post('/register', registrationLimiter, async (req: Request, res: Response) => {
  try {
    const { email, username, password } = req.body || {};
    res.status(201).json(await AuthService.register({ email, username, password }));
  } catch (error: any) { res.status(error.status || 500).json({ error: error.message || '注册失败' }); }
});

// 登录
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }

    const result = await AuthService.login({ email, password });
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '登录失败' });
  }
});

// 获取当前用户信息
router.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const profile = await AuthService.getProfile(req.userId!);
    res.json(profile);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取用户信息失败' });
  }
});

// 修改密码
router.put('/change-password', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '旧密码和新密码不能为空' });
    }
    const result = await AuthService.changePassword(req.userId!, oldPassword, newPassword);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '修改密码失败' });
  }
});

// Credit can only be issued by an authenticated administrator or a verified payment callback.
router.post('/recharge', authMiddleware, (_req, res) => {
  res.status(403).json({ error: '自助模拟充值已关闭，请联系管理员充值' });
});

export default router;
