import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { ChannelService } from '../services/channelService.js';

const router = Router();
router.use(authMiddleware, adminMiddleware);

// 获取渠道列表
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    res.json(ChannelService.getChannels());
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// 新增渠道
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const id = ChannelService.createChannel(req.body);
    res.json({ message: '创建成功', id });
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

// 编辑渠道
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    ChannelService.updateChannel(parseInt(req.params.id), req.body);
    res.json({ message: '更新成功' });
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

// 删除渠道
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    ChannelService.deleteChannel(parseInt(req.params.id));
    res.json({ message: '删除成功' });
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

// 测试渠道连通性
router.post('/:id/test', async (req: AuthRequest, res: Response) => {
  try {
    const result = await ChannelService.testChannel(parseInt(req.params.id));
    res.json(result);
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

// 从上游同步当前可用模型
router.post('/:id/sync-models', async (req: AuthRequest, res: Response) => {
  try {
    const result = await ChannelService.syncModels(parseInt(req.params.id));
    res.json(result);
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

export default router;
