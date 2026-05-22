import { Router, Request, Response } from 'express';
import { AuthService } from '../services/authService.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

// 注册
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, username, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少6位' });
    }

    const result = await AuthService.register({
      email,
      username: username || email.split('@')[0],
      password,
    });

    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '注册失败' });
  }
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

export default router;
