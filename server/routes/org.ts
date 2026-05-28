import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { orgAdminMiddleware, isSuperAdmin } from '../middleware/admin.js';
import { OrgService } from '../services/orgService.js';
import { db } from '../db/index.js';
import { users, orgMembers } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

const router = Router();

// 所有路由都需要登录
router.use(authMiddleware);

// ============ 组织信息 ============

/** GET /api/org/me — 获取当前用户的组织信息 */
router.get('/me', (req: AuthRequest, res: Response) => {
  try {
    const user = db.select().from(users).where(eq(users.id, req.userId!)).get();
    if (!user?.orgId) return res.json(null);

    const org = OrgService.getById(user.orgId);
    const membership = db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, user.orgId), eq(orgMembers.userId, req.userId!)))
      .get();

    res.json({ ...org, myRole: membership?.role || 'member' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取组织信息失败' });
  }
});

/** PUT /api/org/me — 更新组织信息（org_owner/org_admin） */
router.put('/me', orgAdminMiddleware, (req: AuthRequest, res: Response) => {
  try {
    const user = db.select().from(users).where(eq(users.id, req.userId!)).get();
    if (!user?.orgId) return res.status(400).json({ error: '您不属于任何组织' });

    // 仅允许修改名称（余额/等级由超级管理员管理）
    const { name } = req.body;
    OrgService.update(user.orgId, { name });
    res.json({ message: '更新成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '更新失败' });
  }
});

// ============ 成员管理 ============

/** GET /api/org/members — 获取组织成员列表 */
router.get('/members', orgAdminMiddleware, (req: AuthRequest, res: Response) => {
  try {
    const user = db.select().from(users).where(eq(users.id, req.userId!)).get();
    if (!user?.orgId) return res.status(400).json({ error: '您不属于任何组织' });

    const members = OrgService.getMembers(user.orgId);
    res.json(members);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取成员列表失败' });
  }
});

/** POST /api/org/members — 创建组织成员（直接创建员工） */
router.post('/members', orgAdminMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = db.select().from(users).where(eq(users.id, req.userId!)).get();
    if (!user?.orgId) return res.status(400).json({ error: '您不属于任何组织' });

    const { email, username, password, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    const result = await OrgService.createMember(user.orgId, req.userId!, {
      email, username, password, role,
    });
    res.json({ message: '成员创建成功', userId: result.userId });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '创建成员失败' });
  }
});

/** PUT /api/org/members/:id/role — 修改成员角色 */
router.put('/members/:id/role', orgAdminMiddleware, (req: AuthRequest, res: Response) => {
  try {
    const user = db.select().from(users).where(eq(users.id, req.userId!)).get();
    if (!user?.orgId) return res.status(400).json({ error: '您不属于任何组织' });

    const memberId = parseInt(req.params.id);
    const { role } = req.body;
    OrgService.updateMemberRole(user.orgId, memberId, role);
    res.json({ message: '角色更新成功' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '更新失败' });
  }
});

/** DELETE /api/org/members/:id — 移除成员 */
router.delete('/members/:id', orgAdminMiddleware, (req: AuthRequest, res: Response) => {
  try {
    const user = db.select().from(users).where(eq(users.id, req.userId!)).get();
    if (!user?.orgId) return res.status(400).json({ error: '您不属于任何组织' });

    const memberId = parseInt(req.params.id);
    OrgService.removeMember(user.orgId, memberId);
    res.json({ message: '成员已移除' });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '移除失败' });
  }
});

// ============ 组织统计 ============

/** GET /api/org/usage — 组织用量统计 */
router.get('/usage', orgAdminMiddleware, (req: AuthRequest, res: Response) => {
  try {
    const user = db.select().from(users).where(eq(users.id, req.userId!)).get();
    if (!user?.orgId) return res.status(400).json({ error: '您不属于任何组织' });

    const stats = OrgService.getUsageStats(user.orgId);
    res.json(stats);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || '获取统计失败' });
  }
});

export default router;
