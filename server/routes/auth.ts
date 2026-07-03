import { Router, Request, Response } from 'express';
import { AuthService } from '../services/authService.js';
import { BalanceService } from '../services/balanceService.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

// 公开注册已关闭，用户由管理员在后台创建
router.post('/register', (_req: Request, res: Response) => {
  res.status(403).json({ error: '注册通道已关闭，请联系管理员开通账号' });
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

// 模拟余额充值
router.post('/recharge', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { amount } = req.body;
    const numAmount = Number(amount);
    if (!amount || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: '充值金额必须是大于0的有效数字' });
    }
    const newBalance = BalanceService.recharge(req.userId!, numAmount);
    res.json({ success: true, balance: newBalance });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '充值失败' });
  }
});

export default router;
