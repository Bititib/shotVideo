import { MegabyApiError } from '../services/megabyVideoAdapter.js';
import { Router, Response } from 'express';
import { HussApiError } from '../services/hussVideoAdapter.js';
import { FunAiApiError } from '../services/funAiAdapter.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { ChannelService } from '../services/channelService.js';
import { VideoRoutingStatsService, type VideoRoutingStatsPeriod } from '../services/videoRoutingStatsService.js';

const router = Router();
router.use(authMiddleware, adminMiddleware);

// 获取渠道列表
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    res.json(ChannelService.getChannels());
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// 高频刷新只读取并发运行态，不重复传输完整渠道配置。
router.get('/runtime-status', (req: AuthRequest, res: Response) => {
  try {
    res.json(ChannelService.getRuntimeStatus());
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取渠道运行状态失败' });
  }
});

// 仅管理员可见的视频分流渠道统计。
router.get('/routing-stats', (req: AuthRequest, res: Response) => {
  try {
    const requestedPeriod = String(req.query.period || 'all');
    const period: VideoRoutingStatsPeriod = ['all', '24h', '7d', '30d'].includes(requestedPeriod)
      ? requestedPeriod as VideoRoutingStatsPeriod
      : 'all';
    res.json(VideoRoutingStatsService.getStats(period));
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取分流渠道统计失败' });
  }
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

// 手动启动或停止 HM Studio 渠道下的单个 API Key
router.put('/:id/api-keys/:keyId/status', async (req: AuthRequest, res: Response) => {
  try {
    ChannelService.setHmStudioKeyStatus(
      parseInt(req.params.id),
      parseInt(req.params.keyId),
      Number(req.body?.status) === 1 ? 1 : 0,
    );
    res.json({ message: Number(req.body?.status) === 1 ? 'API Key 已启动' : 'API Key 已停止' });
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

// 删除渠道
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    ChannelService.deleteChannel(parseInt(req.params.id));
    res.json({ message: '删除成功' });
  } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
});

// Upstream authentication is independent of the administrator's website session.
function channelOperationError(res: Response, error: any) {
  if (error instanceof MegabyApiError) return res.status(502).json({ error: error.message, code: error.code, upstreamStatus: error.upstreamStatus });
  if (error instanceof FunAiApiError) {
    return res.status(502).json({ error: error.message, code: 'UPSTREAM_ERROR', upstreamStatus: error.status });
  }
  if (error instanceof HussApiError) {
    return res.status(502).json({ error: error.message, code: 'UPSTREAM_ERROR', upstreamStatus: error.status });
  }
  return res.status(error.status || 500).json({ error: error.message });
}

// 测试渠道连通性
router.post('/:id/test', async (req: AuthRequest, res: Response) => {
  try {
    const result = await ChannelService.testChannel(parseInt(req.params.id));
    res.json(result);
  } catch (err: any) { channelOperationError(res, err); }
});

// 从上游同步当前可用模型
router.post('/:id/sync-models', async (req: AuthRequest, res: Response) => {
  try {
    const result = await ChannelService.syncModels(parseInt(req.params.id));
    res.json(result);
  } catch (err: any) { channelOperationError(res, err); }
});

export default router;
