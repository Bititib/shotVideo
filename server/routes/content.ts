import { Router, Response } from 'express';
import { activeApiKeyMiddleware, authMiddleware, AuthRequest } from '../middleware/auth.js';
import { orgAdminMiddleware } from '../middleware/admin.js';
import { ContentService, sanitizeContentRoutingForClient } from '../services/contentService.js';
import { db } from '../db/index.js';
import { contents, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { activePolls, enqueueHmStudioVideoContent, resumePollForTask } from './video.js';
import { ChannelService } from '../services/channelService.js';
import { localizeGeneratedImage } from './imageGen.js';

const router = Router();

// 所有路由都需要登录
router.use(authMiddleware);

function isApiGeneratedContent(item: { metadata?: string | null }): boolean {
  try {
    const metadata = JSON.parse(item.metadata || '{}');
    return metadata.source === 'api' || metadata.tokenId !== undefined;
  } catch { return false; }
}

/** GET /api/contents — 我的生成内容 */
router.get('/', (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '20', type, status, search, dateFrom, dateTo } = req.query;
    const result = ContentService.getMyContents(req.userId!, {
      page: parseInt(page as string),
      pageSize: parseInt(pageSize as string),
      type: type as string,
      status: status as string,
      search: search as string,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
    });
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取内容失败' });
  }
});

/** GET /api/contents/api-history — 已开通 API Key 用户的调用生成记录 */
router.get('/api-history', activeApiKeyMiddleware, (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '20', type, status, search, dateFrom, dateTo } = req.query;
    const result = ContentService.getMyContents(req.userId!, {
      page: parseInt(page as string),
      pageSize: parseInt(pageSize as string),
      type: type as string,
      status: status as string,
      search: search as string,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
      source: 'api',
    });
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取 API 调用记录失败' });
  }
});

/** GET /api/contents/api-history/:id — API 调用记录详情 */
router.get('/api-history/:id', activeApiKeyMiddleware, (req: AuthRequest, res: Response) => {
  try {
    const contentId = parseInt(req.params.id);
    let item = ContentService.getById(contentId);
    if (item.userId !== req.userId || !isApiGeneratedContent(item)) {
      return res.status(404).json({ error: 'API 调用记录不存在' });
    }
    item = ContentService.materializeAssetsForContent(contentId, item);
    res.json(sanitizeContentRoutingForClient(item));
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取 API 调用记录失败' });
  }
});

/** DELETE /api/contents/api-history/:id — 删除本人的 API 调用记录 */
router.delete('/api-history/:id', activeApiKeyMiddleware, (req: AuthRequest, res: Response) => {
  try {
    const contentId = parseInt(req.params.id);
    const item = ContentService.getById(contentId);
    if (item.userId !== req.userId || !isApiGeneratedContent(item)) {
      return res.status(404).json({ error: 'API 调用记录不存在' });
    }
    ContentService.delete(contentId, req.userId!);
    res.json({ message: '删除成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '删除 API 调用记录失败' });
  }
});

/** GET /api/contents/org — 组织内所有内容（org_owner/org_admin） */
router.get('/org', orgAdminMiddleware, (req: AuthRequest, res: Response) => {
  try {
    const user = db.select().from(users).where(eq(users.id, req.userId!)).get();
    if (!user?.orgId) return res.status(400).json({ error: '您不属于任何组织' });

    const { page = '1', pageSize = '20', type, userId, search } = req.query;
    const result = ContentService.getOrgContents(user.orgId, {
      page: parseInt(page as string),
      pageSize: parseInt(pageSize as string),
      type: type as string,
      userId: userId ? parseInt(userId as string) : undefined,
      search: search as string,
    });
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取组织内容失败' });
  }
});

/** GET /api/contents/:id — 内容详情 */
router.get('/:id', (req: AuthRequest, res: Response) => {
  try {
    const contentId = parseInt(req.params.id);
    let item = ContentService.getById(contentId);

    // 权限检查：仅本人或同组织管理员可查看
    if (item.userId !== req.userId) {
      const user = db.select().from(users).where(eq(users.id, req.userId!)).get();
      const isOrgMgr = user?.orgId && user.orgId === item.orgId &&
        (user.role === 'org_owner' || user.role === 'org_admin' || user.role === 'super_admin');
      if (!isOrgMgr) return res.status(403).json({ error: '无权查看此内容' });
    }

    item = ContentService.materializeAssetsForContent(contentId, item);

    if (item.status === 'queued' && item.type === 'video') {
      try { enqueueHmStudioVideoContent(contentId); } catch { /* periodic recovery will retry */ }
    } else if (item.status === 'processing' && item.type === 'video' && !activePolls.has(contentId)) {
      resumePollForTask(contentId, item);
    }

    res.json(sanitizeContentRoutingForClient(item));
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取内容失败' });
  }
});

/** POST /api/contents/:id/recover-image — 图片地址失效时从上游任务重新取回并本地化。 */
router.post('/:id/recover-image', async (req: AuthRequest, res: Response) => {
  try {
    const contentId = parseInt(req.params.id);
    const item = ContentService.getById(contentId);
    if (item.userId !== req.userId) return res.status(403).json({ error: '无权恢复此图片' });
    if (item.type !== 'image') return res.status(400).json({ error: '该记录不是图片任务' });

    let metadata: Record<string, any> = {};
    try { metadata = JSON.parse(item.metadata || '{}'); } catch { /* use empty metadata */ }
    const channelId = Number(metadata.channelId || 0);
    let channel = channelId > 0 ? ChannelService.getChannelRaw(channelId) : null;
    if (!channel?.baseUrl || !channel.apiKey) {
      const activeChannels = ChannelService.getActiveChannels().filter(candidate => candidate.baseUrl && candidate.apiKey);
      const channelName = String(metadata.channelName || '').trim();
      const modelId = String(item.modelId || metadata.upstreamModel || '').trim();
      channel = (channelName
        ? activeChannels.find(candidate => candidate.name === channelName)
        : null)
        || (modelId ? ChannelService.findChannelsForModel(modelId, activeChannels)[0] : null)
        || null;
    }
    if (!channel?.baseUrl || !channel.apiKey) {
      return res.status(409).json({ error: '原渠道已失效，且找不到支持该图片模型的当前渠道，请检查后台渠道模型绑定和密钥' });
    }

    const taskIds = [...new Set([
      ...(Array.isArray(metadata.upstreamTaskIds) ? metadata.upstreamTaskIds : []),
      metadata.upstreamTaskId,
      metadata.taskId,
    ].map(value => String(value || '').trim()).filter(Boolean))];
    const recoveredUrls: string[] = [];
    let lastError = '';

    for (let index = 0; index < taskIds.length; index++) {
      const taskId = taskIds[index];
      try {
        const taskUrl = `${channel.baseUrl.replace(/\/+$/, '')}/v1/images/generations/${encodeURIComponent(taskId)}`;
        const upstream = await fetch(taskUrl, {
          headers: { Authorization: `Bearer ${channel.apiKey}` },
          signal: AbortSignal.timeout(60_000),
        });
        const body = await upstream.json().catch(() => ({})) as any;
        if (!upstream.ok) throw new Error(body?.error?.message || body?.message || `上游查询失败 (${upstream.status})`);
        const status = String(body?.status || '').toLowerCase();
        if (status && status !== 'succeeded' && status !== 'completed' && status !== 'success') {
          throw new Error(status === 'failed' ? '上游任务已失败' : `上游任务仍在生成（${status}）`);
        }
        const sourceUrl = String(body?.result?.image_url || body?.result?.url || body?.data?.[0]?.url || '');
        if (!sourceUrl) throw new Error('上游任务没有返回图片地址');
        recoveredUrls.push(await localizeGeneratedImage(sourceUrl, `recovered_image_${contentId}_${index}`, req, channel, { relative: true }));
      } catch (error: any) {
        lastError = error?.message || '重新获取图片失败';
      }
    }

    // 兼容没有任务 ID 的旧记录：直接重新下载当时保存的上游地址。
    if (recoveredUrls.length === 0) {
      const legacyUrls = [...new Set([
        item.resultUrl,
        ...(Array.isArray(metadata.imageUrls) ? metadata.imageUrls : []),
      ].map(value => String(value || '').trim()).filter(url => /^https?:\/\//i.test(url)))];
      for (let index = 0; index < legacyUrls.length; index++) {
        try {
          recoveredUrls.push(await localizeGeneratedImage(legacyUrls[index], `recovered_image_${contentId}_${index}`, req, channel, { relative: true }));
        } catch (error: any) {
          lastError = error?.message || '重新下载图片失败';
        }
      }
    }

    if (recoveredUrls.length === 0) {
      return res.status(502).json({ error: lastError || '没有可恢复的上游图片' });
    }

    metadata.imageUrls = recoveredUrls;
    metadata.channelId = channel.id;
    metadata.channelName = channel.name;
    metadata.recoveredAt = new Date().toISOString();
    metadata.progressText = '图片已从上游重新获取';
    db.update(contents).set({
      resultUrl: recoveredUrls[0],
      metadata: JSON.stringify(metadata),
      status: 'completed',
    }).where(eq(contents.id, contentId)).run();

    res.json({ id: contentId, resultUrl: recoveredUrls[0], imageUrls: recoveredUrls, recovered: true });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '重新获取图片失败' });
  }
});

/** DELETE /api/contents/:id — 删除内容 */
router.delete('/:id', (req: AuthRequest, res: Response) => {
  try {
    const contentId = parseInt(req.params.id);
    ContentService.delete(contentId, req.userId!);
    res.json({ message: '删除成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '删除失败' });
  }
});

export default router;
