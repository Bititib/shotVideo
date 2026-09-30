import { createHash } from 'node:crypto';
import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth.js';
import { sqlite } from '../db/index.js';
import { createCanvasRequestStore } from '../services/canvasRequestStore.js';
let store: ReturnType<typeof createCanvasRequestStore> | undefined;
export const canvasRequestStore = () => store ??= createCanvasRequestStore(sqlite);
export function canvasRequestMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const id = req.body?.canvasRequestId;
  if (id === undefined || req.path !== '/generate') return next();
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(id)) { res.status(400).json({ error: '画布任务编号无效' }); return; }
  try {
    const fingerprint = createHash('sha256').update(req.baseUrl + JSON.stringify(req.body)).digest('hex');
    const claim = canvasRequestStore().claim(req.userId!, id, fingerprint);
    if (claim.mismatch) { res.status(409).json({ error: '此任务编号已用于其他参数，请新建任务' }); return; }
    if (!claim.fresh) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(`data: ${JSON.stringify({ type: claim.request.message && !claim.request.contentId ? 'error' : 'status', contentId: claim.request.contentId ?? undefined, message: claim.request.message || '已提交过此任务，正在恢复结果，请勿重复提交' })}\n\n`); return;
    }
    res.on('finish', () => {
      if (res.statusCode >= 400) canvasRequestStore().record(req.userId!, id, { type: 'error', message: '任务请求未通过，请检查模型、额度及输入参数后重新创建任务。' });
    });
    next();
  } catch (error) { next(error); }
}
export function recordCanvasEvent(req: AuthRequest, event: Record<string, any>) {
  if (req.body?.canvasRequestId) canvasRequestStore().record(req.userId!, req.body.canvasRequestId, event);
}
