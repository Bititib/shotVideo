import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { TokenService } from '../services/tokenService.js';

const router = Router();
router.use(authMiddleware, adminMiddleware);

// 获取 Token 列表
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '20', search, userId } = req.query;
    const result = TokenService.getTokens({
      page: parseInt(page as string),
      pageSize: parseInt(pageSize as string),
      search: search as string,
      userId: userId ? parseInt(userId as string) : undefined,
    });
    res.json(result);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// 创建 Token
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = TokenService.createToken(req.body);
    res.json({ message: '创建成功', ...result });
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

// 编辑 Token
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    TokenService.updateToken(parseInt(req.params.id), req.body);
    res.json({ message: '更新成功' });
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

// 删除 Token
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    TokenService.deleteToken(parseInt(req.params.id));
    res.json({ message: '删除成功' });
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

export default router;
