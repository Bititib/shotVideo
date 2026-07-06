import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { TokenService } from '../services/tokenService.js';
import { db } from '../db/index.js';
import { apiTokens } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

const router = Router();
router.use(authMiddleware);

// 获取当前用户的 Token 列表
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '50', search } = req.query;
    const result = TokenService.getTokens({
      page: parseInt(page as string),
      pageSize: parseInt(pageSize as string),
      search: search as string,
      userId: req.userId!, // 强制过滤为当前登录用户
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 用户自行创建 Token (默认使用用户账号的可用余额，限额 -1)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, allowedModels, expiresAt } = req.body;
    const result = TokenService.createToken({
      userId: req.userId!,
      name: name || 'API Token',
      allowedModels: allowedModels || [],
      balance: -1, // 用户自建 Token 始终使用账号账户余额
      rateLimit: -1,
      expiresAt: expiresAt || undefined,
    });
    res.json({ message: '创建成功', ...result });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 用户更新自己的 Token (仅允许修改备注名、启用状态和过期时间)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const token = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    if (!token || token.userId !== req.userId) {
      return res.status(403).json({ error: '无权操作此 Token' });
    }

    const { name, status, expiresAt } = req.body;
    TokenService.updateToken(id, {
      name,
      status,
      expiresAt,
    });
    res.json({ message: '更新成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 用户删除自己的 Token
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const token = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    if (!token || token.userId !== req.userId) {
      return res.status(403).json({ error: '无权操作此 Token' });
    }

    TokenService.deleteToken(id);
    res.json({ message: '删除成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
