import { Router, Response } from 'express';
import { authMiddleware, optionalAuthMiddleware, AuthRequest } from '../middleware/auth.js';
import { tierMiddleware, TierRequest } from '../middleware/tier.js';
import { quotaMiddleware, logUsage } from '../middleware/quota.js';
import { AIService } from '../services/aiService.js';
import { ContentService } from '../services/contentService.js';
import { db } from '../db/index.js';
import { users, tiers, tierModelAccess, models, settings } from '../db/schema.js';
import { eq, like } from 'drizzle-orm';
import multer from 'multer';
import os from 'os';

const router = Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 150 * 1024 * 1024 } });

/**
 * 根据用户选择 + 等级可用列表，确定实际使用的模型
 * 优先使用前端指定的 modelId（需在可用列表内），否则自动选择
 */
function resolveModel(
  req: TierRequest,
  preferImageGen = false,
  preferTts = false
): { id: number; modelId: string; apiKey: string | null } | undefined {
  const available = req.availableModels || [];
  const requestedModelId = req.body?.modelId as string | undefined;

  // 用户指定了模型 → 校验是否在可用列表中
  if (requestedModelId) {
    const found = available.find(m => m.modelId === requestedModelId);
    if (found) return found;
    // 指定的不在列表中，忽略，走自动选择
  }

  // 自动选择：图像生成模型 vs 语音合成模型 vs 文本分析模型
  if (preferImageGen) {
    return available.find(m => m.modelId.includes('image'));
  }
  if (preferTts) {
    return available.find(m => m.modelId.includes('tts')) || available.find(m => m.modelId.includes('flash'));
  }
  return available.find(m => m.modelId.includes('flash') && !m.modelId.includes('image') && !m.modelId.includes('tts')) || available[0];
}

// 通用辅助：执行分析请求 + 保存内容
async function handleAnalysis(
  req: TierRequest,
  res: Response,
  analysisType: string,
  handler: () => Promise<any>
) {
  const startTime = Date.now();
  try {
    const result = await handler();
    const duration = Date.now() - startTime;

    // 记录使用日志
    const modelId = req.availableModels?.[0]?.id;
    logUsage(req.userId!, analysisType, modelId, duration);

    // 保存到内容库
    try {
      const contentType = analysisType === 'copywriting' ? 'copywriting'
        : analysisType === 'generate_image' || analysisType === 'modify_prompt' ? 'image'
          : analysisType === 'generate_tts' ? 'audio'
            : 'analysis';
      const title = contentType === 'audio'
        ? `语音合成 - ${req.body?.voice || '未知'}`
        : (req.body?.videoTitle || req.body?.accountHandle || req.body?.prompt || req.body?.text || analysisType);
      const resultTextStr = typeof result === 'string' ? result : JSON.stringify(result);
      ContentService.save({
        userId: req.userId!,
        orgId: req.orgId || null,
        type: contentType,
        title: typeof title === 'string' ? title.slice(0, 200) : analysisType,
        inputText: (req.body?.videoTitle || req.body?.prompt || req.body?.text || '').slice(0, 500),
        resultText: contentType === 'audio' ? resultTextStr : resultTextStr.slice(0, 5000),
        modelId: req.availableModels?.[0]?.modelId,
      });
    } catch (e) { console.error('[content] 保存失败:', e); }

    res.json(result);
  } catch (err: any) {
    console.error(`Analysis error (${analysisType}):`, err);
    let errorMessage = '分析过程中发生错误，请重试。';
    const raw = err.message || '';

    // 尝试从嵌套 JSON 中提取可读信息
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { }
    const deepMsg = parsed?.error?.message || parsed?.message || '';
    const combined = `${raw} ${deepMsg}`.toLowerCase();

    if (combined.includes('api key not valid') || combined.includes('invalid_argument') && combined.includes('api key')) {
      errorMessage = 'API Key 无效。请在管理后台 → 模型管理 中配置有效的 Gemini API Key，或在 .env 文件中设置 GEMINI_API_KEY。';
    } else if (combined.includes('429') || combined.includes('resource_exhausted') || combined.includes('quota')) {
      errorMessage = 'AI 接口调用频率超限或额度已耗尽，请稍后再试。';
    } else if (combined.includes('permission_denied')) {
      errorMessage = 'API Key 权限不足，请检查 Key 是否已启用 Gemini API。';
    } else if (deepMsg) {
      errorMessage = deepMsg;
    } else if (raw && raw.length < 200) {
      errorMessage = raw;
    }

    res.status(500).json({ error: errorMessage });
  }
}

// ============ 用户可用模型列表（公开，未登录返回 free 等级模型）============
router.get('/models',
  optionalAuthMiddleware,
  (req: TierRequest, res: Response) => {
    let tierId: number | undefined;

    if (req.userId) {
      // 已登录：按用户等级
      const user = db.select().from(users).where(eq(users.id, req.userId)).get();
      if (user) tierId = user.tierId;
    }

    if (!tierId) {
      // 未登录或用户不存在：使用 free 等级
      const freeTier = db.select().from(tiers).where(eq(tiers.name, 'free')).get();
      tierId = freeTier?.id;
    }

    if (!tierId) return res.json([]);

    const accessList = db.select().from(tierModelAccess).where(eq(tierModelAccess.tierId, tierId)).all();
    const modelIds = accessList.map(a => a.modelId);
    if (modelIds.length === 0) return res.json([]);

    const allModels = db.select().from(models).where(eq(models.isActive, 1)).all();
    const available = allModels
      .filter(m => modelIds.includes(m.id))
      .filter(m => {
        // 分析页面只显示纯文本分析模型，排除图片生成/视频/图片类模型
        try {
          const caps: string[] = JSON.parse(m.capabilities || '[]');
          return caps.includes('text') && !caps.includes('image_gen') && !caps.includes('video') && !caps.includes('image');
        } catch { return false; }
      })
      .map(m => ({ modelId: m.modelId, displayName: m.displayName || m.modelId }));

    res.json(available);
  }
);

// ============ 语音合成可用模型列表 ============
router.get('/tts-models',
  optionalAuthMiddleware,
  (req: TierRequest, res: Response) => {
    // 从数据库中获取所有能力包含 'tts' 的模型
    const dbModels = db.select().from(models).where(like(models.capabilities, '%"tts"%')).all();

    // 如果没有，提供兜底
    const sourceModels = dbModels.length > 0
      ? dbModels.map(m => ({ modelId: m.modelId, displayName: m.displayName || m.modelId }))
      : [
        { modelId: 'gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS' },
        { modelId: 'gemini-2.5-pro-preview-tts', displayName: 'Gemini 2.5 Pro TTS' },
      ];

    // 获取语音合成的费率设置
    let ttsRate = 0.01; // 默认 ¥0.01/字
    const rateSetting = db.select().from(settings).where(eq(settings.key, 'tts_rate')).get();
    if (rateSetting) {
      ttsRate = parseFloat(rateSetting.value) || 0.01;
    } else {
      // 顺便在数据库中初始化这个设置
      try {
        db.insert(settings).values({ key: 'tts_rate', value: '0.01', label: '语音合成费率(¥/字)' }).run();
      } catch { }
    }

    const result = sourceModels.map(m => {
      // 优先从 model_pricing 匹配该模型的定价规则
      const pricingRules = db.select().from(modelPricing).all();
      const matchedRule = pricingRules.find(r => r.modelPattern === m.modelId);

      let rate = ttsRate;
      if (matchedRule) {
        // 如果管理员在「计费设置」里单独配置了该模型的价格，则直接使用，不乘以任何倍率
        rate = matchedRule.inputPrice;
      } else {
        // 否则走系统默认的 tts_rate 加上倍率的兜底逻辑
        const multiplier = m.modelId.includes('pro') ? 2 : 1;
        rate = ttsRate * multiplier;
      }

      return {
        modelId: m.modelId,
        displayName: m.displayName,
        rate,
      };
    });

    res.json(result);
  }
);

// 通用短视频分析
router.post('/general',
  authMiddleware,
  tierMiddleware('general'),
  quotaMiddleware,
  upload.single('file'),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'general', async () => {
      const { videoTitle } = req.body;
      const file = req.file;
      if (!file) throw { status: 400, message: '请上传视频文件' };

      const modelConfig = resolveModel(req);
      return AIService.analyzeGeneral(file, videoTitle, modelConfig);
    });
  }
);

// 带货视频分析
router.post('/ecommerce',
  authMiddleware,
  tierMiddleware('ecommerce'),
  quotaMiddleware,
  upload.single('file'),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'ecommerce', async () => {
      const { videoTitle } = req.body;
      const file = req.file;
      if (!file) throw { status: 400, message: '请上传视频文件' };

      const modelConfig = resolveModel(req);
      return AIService.analyzeEcommerce(file, videoTitle, modelConfig);
    });
  }
);

// 图片逆向分析
router.post('/image',
  authMiddleware,
  tierMiddleware('image'),
  quotaMiddleware,
  upload.single('file'),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'image', async () => {
      const { imageRequiresText } = req.body;
      const file = req.file;
      if (!file) throw { status: 400, message: '请上传图片文件' };

      const modelConfig = resolveModel(req);
      return AIService.analyzeImage(file, imageRequiresText === 'true', modelConfig);
    });
  }
);

// 电商文案生成
router.post('/copywriting',
  authMiddleware,
  tierMiddleware('copywriting'),
  quotaMiddleware,
  upload.array('files', 10),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'copywriting', async () => {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) throw { status: 400, message: '请上传产品图片或视频' };

      const modelConfig = resolveModel(req);
      return AIService.analyzeCopywriting(files, modelConfig);
    });
  }
);

// 账号全方位分析
router.post('/account',
  authMiddleware,
  tierMiddleware('account'),
  quotaMiddleware,
  upload.array('files', 5),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'account', async () => {
      const { accountHandle, accountDescription } = req.body;
      const files = req.files as Express.Multer.File[];

      if (!accountHandle && (!files || files.length === 0)) {
        throw { status: 400, message: '请至少输入账号名称或上传截图' };
      }

      const modelConfig = resolveModel(req);
      return AIService.analyzeAccount(accountHandle, accountDescription, files || [], modelConfig);
    });
  }
);

// 换品修改提示词
router.post('/modify-prompt',
  authMiddleware,
  tierMiddleware('modify_prompt'),
  quotaMiddleware,
  upload.single('file'),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'modify_prompt', async () => {
      const { existingPrompt } = req.body;
      const file = req.file;
      if (!file || !existingPrompt) throw { status: 400, message: '请上传产品图片和现有提示词' };

      const modelConfig = resolveModel(req);
      return AIService.modifyPrompt(file, existingPrompt, modelConfig);
    });
  }
);

// AI 图像生成
router.post('/generate-image',
  authMiddleware,
  tierMiddleware('generate_image'),
  quotaMiddleware,
  upload.single('reference'),
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'generate_image', async () => {
      const { prompt, aspectRatio } = req.body;
      if (!prompt) throw { status: 400, message: '请提供图像生成提示词' };

      const modelConfig = resolveModel(req, true);
      if (!modelConfig) throw { status: 403, message: '当前等级无法使用图像生成模型' };

      return AIService.generateImage(prompt, aspectRatio || '16:9', req.file, modelConfig);
    });
  }
);

// 语音合成 (TTS)
router.post('/generate-tts',
  authMiddleware,
  tierMiddleware('tts'),
  quotaMiddleware,
  async (req: TierRequest, res: Response) => {
    await handleAnalysis(req, res, 'generate_tts', async () => {
      const { text, voice } = req.body;
      if (!text) throw { status: 400, message: '请提供合成文本' };
      if (!voice) throw { status: 400, message: '请提供音色名称' };

      const modelConfig = resolveModel(req, false, true);
      return AIService.generateTts(text, voice, modelConfig);
    });
  }
);

export default router;
