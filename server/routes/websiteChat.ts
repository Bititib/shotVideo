import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { callableModelId, getAccessibleModels } from '../services/modelAccessService.js';
import { claimChatTurn, deleteChatConversation, finishChatTurn, listChatConversations, listChatTurns, reserveChatTurn, saveChatAnswer } from '../services/websiteChatStore.js';
import { handleChatCompletion, type WebsiteChatReply } from './v1.js';
import type { ChatEvent } from '../../shared/websiteChat.js';

const router = Router();
router.use(authMiddleware);
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function chatModels(userId: number) {
  return getAccessibleModels({ userId, allowedModels: [] }).filter(model => {
    try { return JSON.parse(model.capabilities).includes('text'); } catch { return false; }
  }).map(model => ({ id: callableModelId(model), internalId: model.modelId }));
}

router.get('/models', (req: AuthRequest, res, next) => {
  try { res.json(chatModels(req.userId!).map(({ id }) => ({ id, name: id }))); }
  catch (error) { next(error); }
});

router.get('/conversations', (req: AuthRequest, res, next) => {
  try { res.json(listChatConversations(req.userId!)); } catch (error) { next(error); }
});

router.get('/conversations/:id', (req: AuthRequest, res, next) => {
  try { res.json(listChatTurns(req.userId!, req.params.id)); } catch (error) { next(error); }
});

router.delete('/conversations/:id', (req: AuthRequest, res, next) => {
  try {
    deleteChatConversation(req.userId!, req.params.id);
    res.json({ deleted: true });
  } catch (error) { next(error); }
});

router.post('/conversations/:id/turns', async (req: AuthRequest, res, next) => {
  const { id } = req.params;
  const { requestId, model, question, create } = req.body ?? {};
  if (!uuid.test(id) || typeof requestId !== 'string' || !uuid.test(requestId) || typeof model !== 'string' ||
    typeof question !== 'string' || !question.trim() || question.length > 16_000 || typeof create !== 'boolean') {
    res.status(400).json({ error: '请选择模型，并输入 1 至 16000 字符的消息' });
    return;
  }

  try {
    const selected = chatModels(req.userId!).find(item => item.id === model);
    if (!selected) {
      res.status(403).json({ error: '此模型目前无法用于对话，请重新选择' });
      return;
    }
    const claim = claimChatTurn.immediate(req.userId!, id, requestId, model, question.trim(), create);
    if (claim.existing) return res.json(claim.existing);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    const emit = (event: ChatEvent) => {
      if (!res.destroyed && !res.writableEnded) res.write('data: ' + JSON.stringify(event) + '\n\n');
    };

    let answer = '';
    let lastSavedAt = 0;
    const finish: WebsiteChatReply['finish'] = ({ status, error }) => {
      const turn = finishChatTurn(id, requestId, answer, status, error);
      if (turn) emit({ turn });
    };
    try {
      res.flushHeaders();
      req.body = { model: selected.internalId, messages: claim.messages, stream: true };
      await handleChatCompletion(req, res, {
        userId: req.userId!, deadline: claim.deadline,
        reserve: (cost, modelId, snapshot) => reserveChatTurn.immediate(req.userId!, id, requestId, cost, modelId, snapshot),
        delta(text) {
          answer += text;
          const now = Date.now();
          if (now - lastSavedAt >= 500) {
            saveChatAnswer(id, requestId, answer);
            lastSavedAt = now;
          }
          emit({ delta: text });
        },
        finish,
      });
    } catch (error) {
      console.error('[website chat] conversation turn failed', { requestId, name: (error as Error).name });
      finish({ status: 'review', error: '对话处理已中断，原请求结果待核实' });
    } finally {
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  } catch (error) {
    if (res.headersSent) {
      if (!res.destroyed && !res.writableEnded) res.end();
    } else next(error);
  }
});

export default router;
