import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { AdminService } from '../services/adminService.js';
import { OrgService } from '../services/orgService.js';
import { FeedbackService } from '../services/feedbackService.js';
import { ChannelService } from '../services/channelService.js';
import { hmStudioQueue } from '../services/hmStudioQueueService.js';

const router = Router();

// 所有管理路由都需要登录 + 管理员权限
router.use(authMiddleware, adminMiddleware);

// 内部队列诊断：仅管理员登录态可访问，不暴露在公开 /v1 API。
router.get('/hm-queue', (_req: AuthRequest, res: Response) => {
  ChannelService.getActiveChannels();
  const limits = hmStudioQueue.getLimits();
  res.json({
    object: 'queue_status',
    provider: 'hmstudio',
    strategy: 'round_robin_by_user_fifo_within_user',
    running: limits.running,
    queued: limits.queued,
    concurrency_limit: limits.concurrencyLimit,
    pool_count: limits.poolCount,
    per_key_concurrency_limit: limits.poolConcurrencyLimit,
    user_concurrency_limit: null,
    user_concurrency_unlimited: true,
    max_user_queue: limits.maxUserQueue,
    max_queue: limits.maxQueue,
    pools: hmStudioQueue.getPoolStats(),
  });
});

// ============ 仪表盘 ============
router.get('/dashboard', async (req: AuthRequest, res: Response) => {
  try {
    const stats = AdminService.getDashboardStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取统计失败' });
  }
});

// ============ 用户管理 ============
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '20', search, tierId, isActive } = req.query;
    const result = AdminService.getUsers({
      page: parseInt(page as string),
      pageSize: parseInt(pageSize as string),
      search: search as string,
      tierId: tierId ? parseInt(tierId as string) : undefined,
      isActive: isActive !== undefined ? parseInt(isActive as string) : undefined,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取用户列表失败' });
  }
});

// 管理员创建用户
router.post('/users', async (req: AuthRequest, res: Response) => {
  try {
    const { email, username, password, tierId } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少6位' });
    }
    const { AuthService } = await import('../services/authService.js');
    const result = await AuthService.register({
      email,
      username: username || email.split('@')[0],
      password,
    });
    // 如果指定了等级，更新
    if (tierId) {
      AdminService.updateUser(result.user.id, { tierId: parseInt(tierId) });
    }
    res.json({ message: '用户创建成功', user: result.user });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '创建用户失败' });
  }
});

router.put('/users/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    const updates = req.body;
    AdminService.updateUser(userId, updates);
    res.json({ message: '更新成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '更新失败' });
  }
});

router.delete('/users/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    // 不允许删除自己
    if (userId === req.userId) {
      return res.status(400).json({ error: '不能删除自己的账号' });
    }
    AdminService.deleteUser(userId);
    res.json({ message: '删除成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '删除失败' });
  }
});

// ============ 等级管理 ============
router.get('/tiers', async (req: AuthRequest, res: Response) => {
  try {
    const result = AdminService.getTiers();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取等级列表失败' });
  }
});

router.post('/tiers', async (req: AuthRequest, res: Response) => {
  try {
    AdminService.createTier(req.body);
    res.json({ message: '创建成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '创建失败' });
  }
});

router.put('/tiers/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tierId = parseInt(req.params.id);
    AdminService.updateTier(tierId, req.body);
    res.json({ message: '更新成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '更新失败' });
  }
});

router.delete('/tiers/:id', async (req: AuthRequest, res: Response) => {
  try {
    const tierId = parseInt(req.params.id);
    AdminService.deleteTier(tierId);
    res.json({ message: '删除成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '删除失败' });
  }
});

// ============ 模型管理 ============
router.get('/models', async (req: AuthRequest, res: Response) => {
  try {
    const result = AdminService.getModels();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取模型列表失败' });
  }
});

router.post('/models', async (req: AuthRequest, res: Response) => {
  try {
    AdminService.createModel(req.body);
    res.json({ message: '创建成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '创建失败' });
  }
});

router.put('/models/:id', async (req: AuthRequest, res: Response) => {
  try {
    const modelId = parseInt(req.params.id);
    AdminService.updateModel(modelId, req.body);
    res.json({ message: '更新成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '更新失败' });
  }
});

router.delete('/models/:id', async (req: AuthRequest, res: Response) => {
  try {
    const modelId = parseInt(req.params.id);
    AdminService.deleteModel(modelId);
    res.json({ message: '删除成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '删除失败' });
  }
});

// ============ 系统设置 ============
router.get('/settings', async (req: AuthRequest, res: Response) => {
  try {
    const result = AdminService.getSettings();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取设置失败' });
  }
});

router.put('/settings', async (req: AuthRequest, res: Response) => {
  try {
    const { items } = req.body; // [{ key, value }]
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: '参数格式错误' });
    }
    AdminService.updateSettings(items);
    res.json({ message: '更新成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '更新失败' });
  }
});

// ============ 组织管理（超级管理员） ============
router.get('/orgs', async (req: AuthRequest, res: Response) => {
  try {
    const orgs = OrgService.getAll();
    res.json(orgs);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取组织列表失败' });
  }
});

router.post('/orgs', async (req: AuthRequest, res: Response) => {
  try {
    const { name, slug, ownerId, tierId, balance, maxMembers } = req.body;
    if (!name || !slug || !ownerId) {
      return res.status(400).json({ error: '组织名称、标识和拥有者不能为空' });
    }
    const result = OrgService.create({ name, slug, ownerId, tierId, balance, maxMembers });
    res.json({ message: '组织创建成功', orgId: result.orgId });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '创建组织失败' });
  }
});

router.put('/orgs/:id', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = parseInt(req.params.id);
    OrgService.update(orgId, req.body);
    res.json({ message: '更新成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '更新失败' });
  }
});

router.delete('/orgs/:id', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = parseInt(req.params.id);
    OrgService.delete(orgId);
    res.json({ message: '组织已删除' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '删除失败' });
  }
});

// ============ 内容管理（管理员查看所有用户生成内容） ============
router.get('/contents', async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '20', type, userId, modelId, status, search } = req.query;
    const { ContentService } = await import('../services/contentService.js');
    const result = ContentService.getAllContents({
      page: parseInt(page as string),
      pageSize: parseInt(pageSize as string),
      type: type as string,
      userId: userId ? parseInt(userId as string) : undefined,
      modelId: modelId as string,
      status: status as string,
      search: search as string,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || '获取内容列表失败' });
  }
});

router.get('/contents/:id', async (req: AuthRequest, res: Response) => {
  try {
    const contentId = parseInt(req.params.id);
    const { ContentService } = await import('../services/contentService.js');
    const item = ContentService.materializeAssetsForContent(contentId);
    res.json(item);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取内容失败' });
  }
});

// ============ 模型故障反馈 ============
router.get('/feedback', (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', pageSize = '20', status, modelId, search } = req.query;
    const result = FeedbackService.getAdminList({
      page: Math.max(1, parseInt(page as string) || 1),
      pageSize: Math.min(100, Math.max(1, parseInt(pageSize as string) || 20)),
      status: status as string,
      modelId: modelId as string,
      search: search as string,
    });
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取反馈列表失败' });
  }
});

router.put('/feedback/:id', (req: AuthRequest, res: Response) => {
  try {
    FeedbackService.update(parseInt(req.params.id), req.body || {});
    res.json({ message: '反馈已更新' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '更新反馈失败' });
  }
});

export default router;
