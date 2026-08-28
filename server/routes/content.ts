import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { orgAdminMiddleware } from '../middleware/admin.js';
import { ContentService } from '../services/contentService.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { activePolls, enqueueHmStudioVideoContent, resumePollForTask } from './video.js';

const router = Router();

// 所有路由都需要登录
router.use(authMiddleware);

/** GET /api/contents — 我的生成内容 */
router.get('/', (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '20', type, search } = req.query;
    const result = ContentService.getMyContents(req.userId!, {
      page: parseInt(page as string),
      pageSize: parseInt(pageSize as string),
      type: type as string,
      search: search as string,
    });
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取内容失败' });
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
    const item = ContentService.getById(contentId);

    // 权限检查：仅本人或同组织管理员可查看
    if (item.userId !== req.userId) {
      const user = db.select().from(users).where(eq(users.id, req.userId!)).get();
      const isOrgMgr = user?.orgId && user.orgId === item.orgId &&
        (user.role === 'org_owner' || user.role === 'org_admin' || user.role === 'super_admin');
      if (!isOrgMgr) return res.status(403).json({ error: '无权查看此内容' });
    }

    if (item.status === 'queued' && item.type === 'video') {
      try { enqueueHmStudioVideoContent(contentId); } catch { /* periodic recovery will retry */ }
    } else if (item.status === 'processing' && item.type === 'video' && !activePolls.has(contentId)) {
      resumePollForTask(contentId, item);
    }

    res.json(item);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取内容失败' });
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
