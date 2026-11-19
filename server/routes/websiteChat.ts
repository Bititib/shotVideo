import { Router } from 'express';
import multer from 'multer';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { callableModelId, getAccessibleModels } from '../services/modelAccessService.js';
import { claimChatTurn, deleteChatConversation, finishChatTurn, listChatConversations, listChatTurns, reserveChatTurn, saveChatAnswer } from '../services/websiteChatStore.js';
import { handleChatCompletion, type WebsiteChatReply } from './v1.js';
import { chatAttachmentLimit, chatAttachmentMaxBytes, type ChatEvent } from '../../shared/websiteChat.js';
import { ChannelService } from '../services/channelService.js';
import { channelSupportsChatImages, prepareChatAttachment } from '../services/websiteChatAttachments.js';

const router = Router();
router.use(authMiddleware);
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const upload = multer({ limits: { fileSize: chatAttachmentMaxBytes, files: chatAttachmentLimit, fields: 4, fieldSize: 64_000 } })
  .array('attachments', chatAttachmentLimit);

function chatModels(userId: number) {
  const channels = ChannelService.getActiveChannels().filter(channelSupportsChatImages);
  return getAccessibleModels({ userId, allowedModels: [] }).flatMap(model => {
    let capabilities: string[];
    try { capabilities = JSON.parse(model.capabilities); } catch { return []; }
    if (!Array.isArray(capabilities) || !capabilities.includes('text')) return [];
    const imageInput = capabilities.includes('image') && ChannelService.findChannelsForModel(model.modelId, channels).length > 0;
    return [{ id: callableModelId(model), internalId: model.modelId, ...(imageInput && { imageInput }) }];
  });
}

router.get('/models', (req: AuthRequest, res, next) => {
  try { res.json(chatModels(req.userId!).map(({ id, imageInput }) => ({ id, name: id, ...(imageInput && { imageInput }) }))); }
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

router.post('/conversations/:id/turns', (req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  upload(req, res, error => {
    if (!error) return next();
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE'
      ? '每个附件最多 4 MB' : '附件上传格式不正确，每轮最多 3 个文件' });
  });
}, async (req: AuthRequest, res, next) => {
  const { id } = req.params;
  const { requestId, model, question } = req.body ?? {};
  const create = req.is('multipart/form-data') ? req.body.create === 'true' ? true : req.body.create === 'false' ? false : undefined : req.body?.create;
  const files = (req.files || []) as Express.Multer.File[];
  if (!uuid.test(id) || typeof requestId !== 'string' || !uuid.test(requestId) || typeof model !== 'string' ||
    typeof question !== 'string' || (!question.trim() && !files.length) || question.length > 16_000 || typeof create !== 'boolean') {
    res.status(400).json({ error: '请选择模型，并输入消息或添加附件。消息最多 16000 字符' });
    return;
  }

  try {
    const selected = chatModels(req.userId!).find(item => item.id === model);
    if (!selected) {
      res.status(403).json({ error: '此模型目前无法用于对话，请重新选择' });
      return;
    }
    const attachments = [];
    for (const file of files) attachments.push(await prepareChatAttachment(file));
    const claim = claimChatTurn.immediate(req.userId!, id, requestId, model, question.trim(), create, attachments, Boolean(selected.imageInput));
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
        userId: req.userId!, deadline: claim.deadline, imageCount: claim.imageCount,
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
