import { Router } from 'express';
import { sqlite } from '../db/index.js';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { createCanvasWorkspaceStore } from '../services/canvasWorkspaceService.js';
import { canvasRequestStore } from '../middleware/canvasRequest.js';

const router = Router();
let store: ReturnType<typeof createCanvasWorkspaceStore> | undefined;
const workspaceStore = () => store ??= createCanvasWorkspaceStore(sqlite);
router.use(authMiddleware);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.get('/requests/:id', (req: AuthRequest, res, next) => {
  try {
    const request = canvasRequestStore().get(req.userId!, req.params.id);
    if (!request) { res.status(404).json({ error: '未找到任务，请先到生成记录核实' }); return; }
    res.json({ contentId: request.contentId, message: request.message, updatedAt: request.updatedAt });
  } catch (error) { next(error); }
});
router.get('/workspace', (req: AuthRequest, res, next) => {
  try { res.json(workspaceStore().get(req.userId!)); } catch (error) { next(error); }
});
router.put('/workspace', (req: AuthRequest, res) => {
  try {
    const result = workspaceStore().put(req.userId!, req.body.revision, req.body.workspace);
    if (result.conflict) { res.status(409).json({ error: '另一设备已修改画布，本地作品已保留。刷新后会保留两个版本。', revision: result.revision }); return; }
    res.json({ revision: result.revision });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '保存失败' }); }
});
export default router;
