import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tierMiddleware, TierRequest } from '../middleware/tier.js';
import { quotaMiddleware, logUsage } from '../middleware/quota.js';
import { ChannelService } from '../services/channelService.js';
import { BalanceService } from '../services/balanceService.js';
import { ContentService } from '../services/contentService.js';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { models, settings, contents } from '../db/schema.js';
import { eq, like, and } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

const execPromise = promisify(exec);
const router = Router();

export const activePolls = new Set<number>();

const RATIO_TO_SIZE: Record<string, string> = {
  '16:9': '1280x720',
  '9:16': '720x1280',
  '1:1': '1024x1024',
  '4:3': '1024x768',
  '3:4': '768x1024',
  '3:2': '1080x720',
  '2:3': '720x1080',
  '21:9': '1680x720',
};

/**
 * 将 base64 数据转换并存储为本地静态文件，返回可外网访问的公网 URL
 */
function convertBase64ToPublicUrl(dataUrl: string, prefix: string, req: Request): string {
  if (!dataUrl) return '';
  if (dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
    return dataUrl;
  }

  try {
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return dataUrl;

    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    // 获取后缀名
    let ext = mimeType.split('/')[1] || 'jpg';
    if (mimeType === 'audio/mpeg') {
      ext = 'mp3';
    } else if (mimeType.includes('wav')) {
      ext = 'wav';
    }
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
    const destPath = path.join(process.cwd(), 'data/uploads', filename);

    fs.writeFileSync(destPath, buffer);

    // 优先使用环境变量配置的公网基准 URL
    const baseUrl = process.env.BACKEND_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    return `${baseUrl.replace(/\/+$/, '')}/uploads/${filename}`;
  } catch (err: any) {
    console.error('[video] convertBase64ToPublicUrl 失败:', err.message);
    return dataUrl;
  }
}

/**
 * 将 base64 数据上传到 SudaShuiAPI 文件服务
 */
async function uploadToSudaShui(dataUrl: string, apiKey: string): Promise<string> {
  if (!dataUrl) return '';
  if (dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
    return dataUrl;
  }

  try {
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return dataUrl;

    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    let ext = mimeType.split('/')[1] || 'jpg';
    if (mimeType === 'audio/mpeg') ext = 'mp3';
    else if (mimeType.includes('wav')) ext = 'wav';

    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    formData.append('file', blob, `file_${Date.now()}.${ext}`);

    const resp = await fetch('https://files.sudashuiapi.com', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData,
      signal: AbortSignal.timeout(60000)
    });

    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => '');
      throw new Error(`SudaShui upload failed: ${resp.status} ${errTxt}`);
    }

    const data = await resp.json() as any;
    return data.url;
  } catch (err: any) {
    console.error('[video] uploadToSudaShui 失败:', err.message);
    throw err;
  }
}

/** 上传素材到 Pidoi（Sora V3 Pro）文件存储 */
async function uploadToPidoi(dataUrl: string, apiKey: string, baseUrl?: string): Promise<string> {
  if (!dataUrl) return '';
  if (dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
    return dataUrl;
  }
  try {
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid data URL format');
    const mimeType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    let ext = mimeType.split('/')[1] || 'jpg';
    if (mimeType === 'audio/mpeg') ext = 'mp3';
    else if (mimeType.includes('wav')) ext = 'wav';
    else if (mimeType.includes('mp4')) ext = 'mp4';

    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    formData.append('file', blob, `file_${Date.now()}.${ext}`);

    const uploadBase = baseUrl ? baseUrl.replace(/\/v1\/?$/, '') : 'https://pidoi.com';
    const resp = await fetch(`${uploadBase}/seedance-assets/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData,
      signal: AbortSignal.timeout(60000)
    });

    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => '');
      throw new Error(`Pidoi upload failed: ${resp.status} ${errTxt}`);
    }

    // 防御性检查：网关可能以 200 返回 HTML 页面（鉴权失败等情况）
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const htmlSnippet = await resp.text().catch(() => '');
      throw new Error(`Pidoi upload 返回了 HTML 而非 JSON（可能是鉴权失败或地址错误）: ${htmlSnippet.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    return data.url || data.assetUrl;
  } catch (err: any) {
    console.error('[video] uploadToPidoi 失败:', err.message);
    throw err;
  }
}

/** 模型系列信息：计费、时长限制、是否强制参考图 */
interface ModelMeta {
  series: string;
  allowedSeconds: number[] | null;   // null = 不限制
  requireRef: boolean;               // 是否必须传参考图
}
const MODEL_META: Record<string, ModelMeta> = {
  'grok-imagine-video-1.5-preview': { series: '1.5', allowedSeconds: [6, 10, 15], requireRef: true },
  'grok-imagine-1.0-video': { series: '1.0', allowedSeconds: [6, 10], requireRef: false },
  'grok-imagine-video-1.5-fast': { series: '1.5', allowedSeconds: [6, 10], requireRef: false },
  'grok-imagine-video-1.5-1080p': { series: '1.5', allowedSeconds: [10, 15], requireRef: true },
  'grok-imagine-video': { series: 'legacy', allowedSeconds: null, requireRef: false },
  'grok-4.3-video': { series: 'legacy', allowedSeconds: null, requireRef: false },
  'omni-flash': { series: 'omni-flash', allowedSeconds: [4, 6, 8, 10], requireRef: false },
  'omni-flash-vref': { series: 'omni-flash-vref', allowedSeconds: [10], requireRef: false },
  'sora-v4-fast': { series: 'sora-v4', allowedSeconds: [10, 15], requireRef: false },
  'sora-v4-pro': { series: 'sora-v4', allowedSeconds: [10, 15], requireRef: false },
  'sdas-wf-sd2.0-fast-933-720p': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sdas-wf-sd2.0-pro-933-480p': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sdas-pg-s2.0-fast': { series: 'sudashui', allowedSeconds: [10, 15], requireRef: false },
  'seedance-2.0-fast': { series: 'seedance-fast', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'veo-omni-flash': { series: 'veo-omni-flash', allowedSeconds: [10], requireRef: false },
  'sd2-c7': { series: 'sd2-c7', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance-2.0-720p': { series: 'seedance-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance-2.0-fast-720p': { series: 'seedance-fast-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'jimeng-video-seedance-2.0-fast': { series: 'jimeng', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'jimeng-video-seedance-2.0-vip': { series: 'jimeng', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance2.0-full-9img': { series: 'seedance20', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sora2-8s-16x9': { series: 'sora2', allowedSeconds: [8], requireRef: false },
  'sora2-8s-9x16': { series: 'sora2', allowedSeconds: [8], requireRef: false },
};

const DEFAULT_VIDEO_MODELS = [
  { id: 'grok-imagine-video-1.5-preview', name: 'Grok 1.5 Preview', description: '图生视频，必须提供参考图，6/10/15秒', maxSeconds: 15, icon: '🖼️' },
  { id: 'grok-imagine-1.0-video', name: 'Grok 1.0 Video', description: '文生/图生视频，支持最多7张参考图，6/10秒', maxSeconds: 10, icon: '🎥' },
  { id: 'grok-imagine-video-1.5-fast', name: 'Grok 1.5 Fast', description: '快速文生/图生视频，支持最多7张参考图，6/10秒', maxSeconds: 10, icon: '⚡' },
  { id: 'grok-imagine-video-1.5-1080p', name: 'Grok 1.5 1080p', description: '单图参考模型，最多1张参考图，支持时长10和15秒，分辨率1080P', maxSeconds: 15, icon: '🎬' },
  { id: 'omni-flash', name: 'Omni Flash', description: '多参考图生成/纯文生视频，4/6/8/10秒，支持 1080p', maxSeconds: 10, icon: '⚡' },
  { id: 'omni-flash-vref', name: 'Omni Flash Vref', description: '视频风格编辑/改写，支持 1080p', maxSeconds: 10, icon: '✂️' },
  { id: 'sdas-wf-sd2.0-fast-933-720p', name: 'Seedance 2.0 Fast 933 (720p)', description: '支持9图/3视频/3音频参考，4-15秒，按秒计费', maxSeconds: 15, icon: '⚡' },
  { id: 'sdas-wf-sd2.0-pro-933-480p', name: 'Seedance 2.0 Pro 933 (480p)', description: '支持9图/3视频/3音频参考，4-15秒，按秒计费，支持真人内容', maxSeconds: 15, icon: '🚀' },
  { id: 'sdas-pg-s2.0-fast', name: 'Seedance 2.0 PG Fast', description: '极速新口子，按次收费，限10/15秒，图片+视频总数≤5（视频≤1，无音频），不支持真人', maxSeconds: 15, icon: '⚡' },
  { id: 'veo-omni-flash', name: 'Veo Omni Flash', description: '多参考图生成视频，参考图字段 Ingredients_images，固定10s', maxSeconds: 10, icon: '🚀' },
  { id: 'sd2-c7', name: 'Seedance 2.0 c7', description: 'OpenAI 兼容，支持720p固定分辨率，支持最多9张图片、3个视频、3个音频参考，5-15秒', maxSeconds: 15, icon: '🚀' },
  { id: 'seedance-2.0-720p', name: 'Seedance 2.0 720p', description: 'Seedance 2.0 标准版，支持720p固定分辨率，支持最多9张图片、3个视频、3个音频参考，5-15秒', maxSeconds: 15, icon: '🚀' },
  { id: 'seedance-2.0-fast-720p', name: 'Seedance 2.0 Fast 720p', description: 'Seedance 2.0 极速版，支持720p固定分辨率，支持最多9张图片、3个视频、3个音频参考，5-15秒', maxSeconds: 15, icon: '⚡' },
  { id: 'jimeng-video-seedance-2.0-fast', name: 'Jimeng Seedance 2.0 Fast (888API)', description: '速度优先，适合快速预览和批量草稿，最多支持9图参考，4-15秒', maxSeconds: 15, icon: '⚡' },
  { id: 'jimeng-video-seedance-2.0-vip', name: 'Jimeng Seedance 2.0 VIP (888API)', description: '质量优先，支持720p/1080p，支持最多9张图片、3个视频、3个音频参考，4-15秒', maxSeconds: 15, icon: '🚀' },
  { id: 'seedance2.0-full-9img', name: 'Seedance 2.0 Full 9图 (888API)', description: '支持最多9图参考、3视频、3音频参考，4-15秒，固定按次计费', maxSeconds: 15, icon: '🚀' },
  { id: 'sora2-8s-16x9', name: 'Sora 2 横屏 8s (888API)', description: 'Sora 2 视频生成，固定 8 秒，1280x720 横屏，固定按次计费', maxSeconds: 8, icon: '🎬' },
  { id: 'sora2-8s-9x16', name: 'Sora 2 竖屏 8s (888API)', description: 'Sora 2 视频生成，固定 8 秒，720x1280 竖屏，固定按次计费', maxSeconds: 8, icon: '🎬' },
];

/** 查找支持指定视频模型的渠道 */
function findVideoChannel(modelId: string) {
  const channel = ChannelService.findChannelForModel(modelId);
  if (channel) return { baseUrl: channel.baseUrl, apiKey: channel.apiKey };
  if (env.GROK2API_BASE_URL) return { baseUrl: env.GROK2API_BASE_URL, apiKey: env.GROK2API_API_KEY };
  return null;
}

/**
 * 自动将 Grok 视频下载并本地化保存到 `data/uploads` 目录中，防止上游链接失效或鉴权失败
 */
export async function downloadAndLocalizeGrokVideo(url: string, videoId: string, model: string): Promise<string> {
  if (!url) return '';
  // 如果已经是本地相对路径或本地 uploads 路径，无需重复本地化
  if (url.startsWith('/') || url.includes('/uploads/')) {
    return url;
  }

  console.log(`[video] 开始本地化 Grok 视频: ${url} (task: ${videoId})`);
  
  const channel = findVideoChannel(model);
  const headers: Record<string, string> = {};
  if (channel?.apiKey) {
    headers['Authorization'] = `Bearer ${channel.apiKey}`;
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch Grok video from upstream: ${response.statusText}`);
  }

  const uploadDir = path.join(process.cwd(), 'data/uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const filename = `grok_${videoId}.mp4`;
  const destPath = path.join(uploadDir, filename);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);

  const localizedUrl = `/uploads/${filename}`;
  console.log(`[video] Grok 视频本地化成功: ${localizedUrl}`);
  return localizedUrl;
}

/**
 * 将 4月天渠道 (llm.chre3.com) 的 H.265 视频下载、转码为 H.264 并本地化保存。
 * 使用 UUID 唯一临时文件名，防止并发冲突；转码完成后原子 rename 交付。
 */
export async function localizeChre3Video(url: string, videoId: string, model: string): Promise<string> {
  if (!url) return '';
  // 已经是本地路径，跳过
  if (url.startsWith('/') || url.includes('/uploads/')) return url;
  // 仅处理 4月天渠道
  if (!url.includes('llm.chre3.com')) return url;

  const uploadDir = path.join(process.cwd(), 'data/uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const finalFilename = `video_${safeId}.mp4`;
  const finalPath = path.join(uploadDir, finalFilename);

  // 如果此视频已经本地化过，直接返回
  if (fs.existsSync(finalPath)) {
    console.log(`[video/transcode] 已存在本地缓存: ${finalFilename}`);
    return `/uploads/${finalFilename}`;
  }

  const uuid = crypto.randomUUID();
  const tempDownload = path.join(uploadDir, `tmp_dl_${uuid}.mp4`);
  const tempTranscoded = path.join(uploadDir, `tmp_tc_${uuid}.mp4`);

  try {
    console.log(`[video/transcode] 开始下载 4月天渠道视频: ${url}`);

    // 获取渠道授权头
    const channel = findVideoChannel(model);
    const headers: Record<string, string> = {};
    if (channel?.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
    if (!resp.ok) throw new Error(`下载失败: ${resp.status} ${resp.statusText}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tempDownload, buffer);
    console.log(`[video/transcode] 下载完成: ${buffer.length} bytes`);

    // ffprobe 检测编码
    let isHevc = false;
    try {
      const probeOut = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1 "${tempDownload}"`,
        { encoding: 'utf8' }
      );
      isHevc = probeOut.includes('hevc');
      console.log(`[video/transcode] 编码检测: ${probeOut.trim()} (HEVC=${isHevc})`);
    } catch {
      console.warn('[video/transcode] ffprobe 检测失败，默认视为 HEVC');
      isHevc = true;
    }

    if (isHevc) {
      console.log('[video/transcode] 检测到 HEVC (H.265)，启动 FFmpeg 转码为 H.264...');
      await execPromise(
        `ffmpeg -y -i "${tempDownload}" -c:v libx264 -pix_fmt yuv420p -preset superfast -movflags faststart -c:a copy "${tempTranscoded}"`
      );
      // 原子 rename 到最终路径
      fs.renameSync(tempTranscoded, finalPath);
      console.log(`[video/transcode] H.264 转码完成: ${finalFilename}`);
    } else {
      // 非 HEVC，直接 rename
      fs.renameSync(tempDownload, finalPath);
      console.log(`[video/transcode] 非 HEVC 编码，直接本地化: ${finalFilename}`);
    }

    return `/uploads/${finalFilename}`;
  } catch (err: any) {
    console.error(`[video/transcode] 4月天视频本地化失败: ${err.message}`);
    // 返回原始 URL 作为 fallback，仍可通过 /play 代理播放
    return url;
  } finally {
    // 清理临时文件
    try { if (fs.existsSync(tempDownload)) fs.unlinkSync(tempDownload); } catch {}
    try { if (fs.existsSync(tempTranscoded)) fs.unlinkSync(tempTranscoded); } catch {}
  }
}
/** GET /api/video/models — 可用的视频模型列表（公开，不需要登录） */
router.get('/models', (_req: Request, res: Response) => {
  // 从数据库动态拉取所有启用且具备 'video' 能力的模型
  const dbModels = db.select().from(models)
    .where(and(eq(models.isActive, 1), like(models.capabilities, '%"video"%')))
    .all();

  // 获取所有在数据库中被禁用的模型 ID，用作后备过滤
  const disabledModelIds = new Set<string>();
  try {
    const inactive = db.select().from(models).where(eq(models.isActive, 0)).all();
    inactive.forEach(m => disabledModelIds.add(m.modelId));
  } catch { }

  // 如果数据库里还没配置视频模型，提供一个过滤了禁用模型的默认后备
  const sourceModels = dbModels.length > 0
    ? dbModels.map(m => ({ id: m.modelId, name: m.displayName }))
    : DEFAULT_VIDEO_MODELS.filter(m => !disabledModelIds.has(m.id));

  const rate480 = db.select().from(settings).where(eq(settings.key, 'video_rate_480p')).get();
  const rate720 = db.select().from(settings).where(eq(settings.key, 'video_rate_720p')).get();
  const base480 = parseFloat(rate480?.value || '0.03');
  const base720 = parseFloat(rate720?.value || '0.05');

  const omniFlash720 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_flash_rate_720p')).get()?.value || '0.90');
  const omniFlash1080 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_flash_rate_1080p')).get()?.value || '1.50');
  const omniVref720 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_vref_rate_720p')).get()?.value || '1.60');
  const omniVref1080 = parseFloat(db.select().from(settings).where(eq(settings.key, 'omni_vref_rate_1080p')).get()?.value || '2.20');

  const soraV3ProRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sora_v3_pro_rate')).get()?.value || '4.00');
  const soraV4FastRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sora_v4_fast_rate')).get()?.value || '0.189');
  const soraV4ProRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get()?.value || '0.25');
  const seedance20FastRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_rate')).get()?.value || '4.00');
  const veoOmniFlashRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'veo_omni_flash_rate')).get()?.value || '5.00');

  const result = sourceModels.map(m => {
    const preset = DEFAULT_VIDEO_MODELS.find(d => d.id === m.id);
    const meta = MODEL_META[m.id];
    const multiplier = meta?.series === '1.5' ? 1.2 : 1.0;

    let rates: Record<string, number>;
    if (m.id === 'omni-flash') {
      rates = {
        '720p': omniFlash720,
        '1080p': omniFlash1080,
      };
    } else if (m.id === 'omni-flash-vref') {
      rates = {
        '720p': omniVref720,
        '1080p': omniVref1080,
      };
    } else if (m.id === 'sdas-hn-sd2.0-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sdas_hn_sd20_720p_rate')).get()?.value || '3.80');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sdas-hn-sd2.0-fast-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sdas_hn_sd20_fast_720p_rate')).get()?.value || '2.80');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sora-v4-fast') {
      rates = {
        '720p': soraV4FastRate,
      };
    } else if (m.id === 'sora-v4-pro') {
      rates = {
        '720p': soraV4ProRate,
      };
    } else if (m.id === 'seedance-2.0-fast') {
      rates = {
        '720p': seedance20FastRate,
      };
    } else if (m.id === 'veo-omni-flash') {
      rates = {
        '720p': veoOmniFlashRate,
        '1080p': veoOmniFlashRate,
      };
    } else if (m.id === 'sd2-c7') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sd2_c7_rate')).get()?.value || '0.50');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'seedance-2.0-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'seedance_2_0_720p_rate')).get()?.value || '3.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'seedance-2.0-fast-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_720p_rate')).get()?.value || '1.50');
      rates = {
        '720p': rate,
      };
    } else {
      rates = {
        '480p': Math.round(base480 * multiplier * 100) / 100,
        '720p': Math.round(base720 * multiplier * 100) / 100,
      };
    }

    return {
      id: m.id,
      name: m.name || preset?.name || m.id,
      description: preset?.description || 'AI 视频生成服务',
      available: findVideoChannel(m.id) !== null,
      maxSeconds: preset?.maxSeconds,
      allowedSeconds: meta?.allowedSeconds || null,
      requireRef: meta?.requireRef || false,
      series: meta?.series || 'legacy',
      rates,
    };
  });

  res.json(result.filter(m => m.available));
});

/** POST /api/video/generate — SSE 流式视频生成（异步轮询模式） */
router.post('/generate', authMiddleware, tierMiddleware('video'), quotaMiddleware, async (req: TierRequest, res: Response) => {
  const {
    prompt,
    model = 'grok-imagine-video',
    aspect_ratio = '16:9',
    video_length = 6,
    resolution = '720p',
    reference_images = [],   // base64 dataURL 数组
    reference_videos = [],   // 新多视频数组字段
    reference_video = '',    // 旧单值兼容字段
    audio_urls = [],         // 新多音频数组字段
    audio_url = '',          // 旧单值兼容字段
    first_frame = '',        // Base64 首帧图片
    last_frame = '',         // Base64 尾帧图片
  } = req.body;

  // 向后兼容：合并旧单值字段到新数组
  const finalVideos: string[] = (Array.isArray(reference_videos) && reference_videos.length > 0)
    ? reference_videos
    : (reference_video ? [reference_video] : []);
  const finalAudios: string[] = (Array.isArray(audio_urls) && audio_urls.length > 0)
    ? audio_urls
    : (audio_url ? [audio_url] : []);

  if (!prompt?.trim()) {
    return res.status(400).json({ error: '请输入视频描述' });
  }

  const meta = MODEL_META[model];

  // 模型时长限制校验
  if (meta?.allowedSeconds && !meta.allowedSeconds.includes(Number(video_length))) {
    return res.status(400).json({ error: `模型 ${model} 只支持 ${meta.allowedSeconds.join('/')} 秒` });
  }

  // 强制参考图校验（grok-imagine-video-1.5-preview 必须提供且只能 1 张）
  const hasRef = Array.isArray(reference_images) && reference_images.length > 0;
  if (meta?.requireRef && !hasRef) {
    return res.status(400).json({ error: `模型 ${model} 必须提供参考图` });
  }

  if (model === 'omni-flash-vref' && !reference_video) {
    return res.status(400).json({ error: '视频编辑/重绘模型必须提供参考视频' });
  }

  const channel = findVideoChannel(model);
  if (!channel) {
    return res.status(503).json({ error: '未配置视频生成渠道。请在管理后台添加渠道或设置 GROK2API_BASE_URL。' });
  }

  // Get the mapped model name from the database channel configuration
  const dbChannel = ChannelService.findChannelForModel(model);
  let upstreamModel = model;
  if (dbChannel?.modelMapping) {
    try {
      const mapping = typeof dbChannel.modelMapping === 'string' ? JSON.parse(dbChannel.modelMapping) : dbChannel.modelMapping;
      upstreamModel = mapping[model] || model;
    } catch { /* skip */ }
  }



  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data: Record<string, any>) => {
    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  const startTime = Date.now();

  // 视频计费费率——按模型系列分级
  let rate = 0.05;
  if (model === 'omni-flash') {
    const key = resolution === '1080p' ? 'omni_flash_rate_1080p' : 'omni_flash_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    rate = parseFloat(row?.value || (resolution === '1080p' ? '1.50' : '0.90'));
  } else if (model === 'omni-flash-vref') {
    const key = resolution === '1080p' ? 'omni_vref_rate_1080p' : 'omni_vref_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    rate = parseFloat(row?.value || (resolution === '1080p' ? '2.20' : '1.60'));
  } else if (model === 'sdas-wf-sd2.0-fast-933-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_wf_sd20_fast_933_720p_rate')).get();
    rate = parseFloat(row?.value || '1.80');
  } else if (model === 'sdas-wf-sd2.0-pro-933-480p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_wf_sd20_pro_933_480p_rate')).get();
    rate = parseFloat(row?.value || '1.80');
  } else if (model === 'sdas-pg-s2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_pg_s20_fast_rate')).get();
    rate = parseFloat(row?.value || '1.95');
  } else if (model === 'jimeng-video-seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'jimeng_video_seedance_2_0_fast_rate')).get();
    rate = parseFloat(row?.value || '0.40');
  } else if (model === 'jimeng-video-seedance-2.0-vip') {
    const key = resolution === '1080p' ? 'jimeng_video_seedance_2_0_vip_rate_1080p' : 'jimeng_video_seedance_2_0_vip_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    rate = parseFloat(row?.value || (resolution === '1080p' ? '1.54' : '0.616'));
  } else if (model === 'seedance2.0-full-9img') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance20_full_9img_rate')).get();
    rate = parseFloat(row?.value || '4.50');
  } else if (model.startsWith('sora2-')) {
    const row = db.select().from(settings).where(eq(settings.key, 'sora2_rate')).get();
    rate = parseFloat(row?.value || '0.60');
  } else if (model === 'seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'veo-omni-flash') {
    const row = db.select().from(settings).where(eq(settings.key, 'veo_omni_flash_rate')).get();
    rate = parseFloat(row?.value || '5.00');
  } else if (model === 'sora-v4-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_fast_rate')).get();
    rate = parseFloat(row?.value || '0.189');
  } else if (model === 'sora-v4-pro' || model === 'seedance-2.0') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'sd2-c7') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_c7_rate')).get();
    rate = parseFloat(row?.value || '0.50');
  } else if (model === 'seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_720p_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'seedance-2.0-fast-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_720p_rate')).get();
    rate = parseFloat(row?.value || '1.50');
  } else if (model === 'grok-imagine-1.0-video') {
    const row = db.select().from(settings).where(eq(settings.key, 'grok_imagine_1_0_video_rate')).get();
    rate = parseFloat(row?.value || '0.288');
  } else if (model === 'grok-imagine-video-1.5-1080p') {
    const row = db.select().from(settings).where(eq(settings.key, 'grok_imagine_video_1_5_1080p_rate')).get();
    rate = parseFloat(row?.value || '0.800');
  } else if (model === 'grok-imagine-video-1.5-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'grok_imagine_video_1_5_fast_rate')).get();
    rate = parseFloat(row?.value || '0.288');
  } else if (model === 'grok-imagine-video-1.5-preview') {
    const row = db.select().from(settings).where(eq(settings.key, 'grok_imagine_video_1_5_preview_rate')).get();
    rate = parseFloat(row?.value || '0.480');
  } else {
    const rate480 = db.select().from(settings).where(eq(settings.key, 'video_rate_480p')).get();
    const rate720 = db.select().from(settings).where(eq(settings.key, 'video_rate_720p')).get();
    const BASE_RATE: Record<string, number> = {
      '480p': parseFloat(rate480?.value || '0.03'),
      '720p': parseFloat(rate720?.value || '0.05'),
    };
    const seriesMultiplier = meta?.series === '1.5' ? 1.2 : 1.0;
    rate = Math.round((BASE_RATE[resolution] || BASE_RATE['720p']) * seriesMultiplier * 100) / 100;
  }

  // 预估费用并检查余额
  const isFlatRate = [
    'seedance-2.0-fast',
    'sd2-c7',
    'seedance-2.0-720p',
    'seedance-2.0-fast-720p',
    'grok-imagine-1.0-video',
    'grok-imagine-video-1.5-1080p',
    'grok-imagine-video-1.5-fast',
    'grok-imagine-video-1.5-preview',
    'sdas-pg-s2.0-fast',
    'seedance2.0-full-9img'
  ].includes(model) || model.startsWith('sora2-');
  const estimatedRate = rate;
  const estimatedSeconds = model === 'omni-flash-vref' ? 10 : (Number(video_length) || 6);
  const estimatedCost = isFlatRate ? estimatedRate : (Math.round(estimatedRate * estimatedSeconds * 100) / 100);
  const { sufficient, balance: currentBalance } = BalanceService.checkBalance(req.userId!, estimatedCost);
  if (!sufficient) {
    sendEvent({ type: 'error', message: `余额不足，预估费用 ¥${estimatedCost.toFixed(2)}，当前余额 ¥${currentBalance.toFixed(2)}` });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // 插入初始的 'processing' 内容记录，确保刷新页面时正在生成中的记录不会丢失
  let contentId: number | null = null;
  try {
    contentId = ContentService.save({
      userId: req.userId!,
      orgId: req.orgId || null,
      type: 'video',
      title: (prompt as string).slice(0, 200),
      inputText: (prompt as string).slice(0, 500),
      modelId: model,
      cost: estimatedCost,
      status: 'processing',
      metadata: {
        resolution,
        seconds: estimatedSeconds,
        aspect_ratio,
        model,
        reference_images,
        reference_videos: finalVideos,
        audio_urls: finalAudios
      }
    });
    if (contentId !== null) {
      sendEvent({ type: 'content_id', contentId });
    }
  } catch (e) {
    console.error('[content] 初始视频记录保存失败:', e);
  }

  /** 生成成功后计费 + 更新内容 */
  const billUsage = (finalVideoUrl: string) => {
    const elapsed = Date.now() - startTime;
    logUsage(req.userId!, 'generate_video', undefined, elapsed);
    const cost = isFlatRate ? rate : (Math.round(rate * estimatedSeconds * 100) / 100);
    if (cost > 0) {
      const remaining = BalanceService.deduct(req.userId!, cost, 'generate_video');
      sendEvent({ type: 'billing', cost, resolution, seconds: estimatedSeconds, rate, remainingBalance: remaining ?? 0 });
    }
    if (contentId !== null) {
      try {
        db.update(contents).set({
          status: 'completed',
          resultUrl: finalVideoUrl || null,
          cost: cost
        }).where(eq(contents.id, contentId)).run();
      } catch (e) { console.error('[content] 视频记录更新失败:', e); }
    }
  };

  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const size = RATIO_TO_SIZE[aspect_ratio] || '1280x720';
  const isOmni = model.startsWith('omni-flash');
  const isSeedanceFast = model === 'seedance-2.0-fast';
  const isSoraV4 = model === 'sora-v4-fast' || model === 'sora-v4-pro' || model === 'seedance-2.0';
  const isSudaShui = meta?.series === 'sudashui';
  const isVeoOmni = model === 'veo-omni-flash';
  const isSeedanceJsonModel = ['sd2-c7', 'seedance-2.0-720p', 'seedance-2.0-fast-720p', 'seedance2.0-full-9img'].includes(model);
  const isJimeng = model.startsWith('jimeng-video-');
  const isSora2 = model.startsWith('sora2-');

  try {
    let videoId = '';

    if (isOmni) {
      sendEvent({ type: 'status', message: '正在提交 Omni 视频生成任务...' });

      const getOmniAspectRatio = (ratio: string): 'landscape' | 'portrait' => {
        if (['9:16', '3:4', '2:3'].includes(ratio)) return 'portrait';
        return 'landscape';
      };

      const payload: Record<string, any> = {
        model,
        prompt: prompt.trim(),
        duration: model === 'omni-flash-vref' ? 10 : Number(video_length),
        aspect_ratio: getOmniAspectRatio(aspect_ratio),
        resolution,
        images: reference_images || [],
      };
      if (model === 'omni-flash-vref') {
        payload.video = reference_video;
      }

      console.log(`[video] Step1 Omni 创建任务: model=${model} duration=${payload.duration} resolution=${resolution}`);

      const createResp = await fetch(`${baseUrl}/v1/video/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] Omni 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.id || job.task_id;
    } else if (isSudaShui) {
      sendEvent({ type: 'status', message: '正在上传素材并提交 SudaShui 任务...' });

      const imageUrls: string[] = [];
      for (const img of (reference_images || [])) {
        imageUrls.push(await uploadToSudaShui(img, channel.apiKey));
      }
      const videoUrls: string[] = [];
      for (const v of finalVideos.slice(0, 3)) {
        videoUrls.push(await uploadToSudaShui(v, channel.apiKey));
      }
      const audioUpUrls: string[] = [];
      for (const a of finalAudios.slice(0, 3)) {
        audioUpUrls.push(await uploadToSudaShui(a, channel.apiKey));
      }

      let finalPrompt = prompt.trim();
      finalPrompt = finalPrompt.replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (match, idxStr) => {
        const idx = parseInt(idxStr, 10);
        return `@image${idx + 1}`;
      });
      for (let i = 0; i < videoUrls.length; i++) {
        finalPrompt = finalPrompt.replace(new RegExp(`\\[ref_video_${i + 1}\\]`, 'g'), `@video${i + 1}`);
      }
      // 兼容旧的单值占位符
      finalPrompt = finalPrompt.replace(/\[ref_video\]/g, '@video1');
      for (let i = 0; i < audioUpUrls.length; i++) {
        finalPrompt = finalPrompt.replace(new RegExp(`\\[ref_audio_${i + 1}\\]`, 'g'), `@audio${i + 1}`);
      }
      finalPrompt = finalPrompt.replace(/\[ref_audio\]/g, '@audio1');

      const payloadMetadata = {
        aspectRatio: aspect_ratio,
        mode: 'references',
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        videoUrls: videoUrls.length > 0 ? videoUrls : undefined,
        audioUrls: audioUpUrls.length > 0 ? audioUpUrls : undefined,
      };

      const payload: Record<string, any> = {
        model: upstreamModel,
        prompt: finalPrompt,
        duration: Number(video_length) || 6,
        metadata: {
          payload: JSON.stringify(payloadMetadata)
        }
      };

      console.log(`[video] Step1 SudaShui 创建任务: model=${model} duration=${payload.duration} resolution=${resolution}`);

      const createResp = await fetch(`${baseUrl}/v1/video/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] SudaShui 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isSoraV4) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Sora V4 任务...' });

      // 将 base64 素材保存到本地并生成自托管公网 URL
      const imageUrls: string[] = [];
      for (const img of (reference_images || []).slice(0, 4)) {
        const url = convertBase64ToPublicUrl(img, 'sora_ref', req);
        if (url) imageUrls.push(url);
      }
      const videoUrl = reference_video ? convertBase64ToPublicUrl(reference_video, 'sora_vid', req) : undefined;
      const firstFrameUrl = first_frame ? convertBase64ToPublicUrl(first_frame, 'sora_ff', req) : undefined;
      const lastFrameUrl = last_frame ? convertBase64ToPublicUrl(last_frame, 'sora_lf', req) : undefined;

      // 确定参考模式和要传入的图片列表
      let referenceMode = 'auto';
      const refImages: string[] = [];
      if (firstFrameUrl && lastFrameUrl) {
        refImages.push(firstFrameUrl, lastFrameUrl);
        referenceMode = 'start_end';
      } else if (firstFrameUrl) {
        refImages.push(firstFrameUrl);
        referenceMode = 'start_frame';
      } else if (imageUrls.length > 0) {
        refImages.push(...imageUrls);
        referenceMode = 'image_reference';
      }

      const payload: Record<string, any> = {
        model: upstreamModel,
        prompt: prompt.trim(),
        duration: Number(video_length) || 5,
        video_config: {
          aspect_ratio: aspect_ratio,
          resolution_name: resolution || '720p',
          reference_mode: referenceMode
        }
      };

      if (refImages.length > 0) {
        payload.reference_images = refImages;
      }
      if (videoUrl) {
        payload.reference_video = videoUrl;
      }

      console.log(`[video] Step1 SoraV4 创建任务: model=${model} upstreamModel=${upstreamModel} duration=${payload.duration} refs=${refImages.length} mode=${referenceMode} video=${!!videoUrl}`);

      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] SoraV4 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isVeoOmni) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Veo Omni Flash 任务...' });

      const imageUrls: string[] = [];
      for (const img of (reference_images || [])) {
        const url = convertBase64ToPublicUrl(img, 'veo_ref', req);
        if (url) imageUrls.push(url);
      }

      const payload: Record<string, any> = {
        model: 'veo-omni-flash',
        prompt: prompt.trim(),
        duration: 10,
        aspect_ratio: aspect_ratio === '9:16' ? '9:16' : '16:9',
      };

      if (imageUrls.length > 0) {
        payload.Ingredients_images = imageUrls;
      }

      console.log(`[video] Step1 VeoOmni 创建任务: model=${model} aspect_ratio=${payload.aspect_ratio} refs=${imageUrls.length}`);

      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] Veo Omni Flash 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isSeedanceFast) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Seedance 2.0 Fast 任务...' });

      // 将 base64 素材保存到本地并生成自托管公网 URL
      const imageUrls: string[] = [];
      for (const img of (reference_images || [])) {
        const url = convertBase64ToPublicUrl(img, 'seedance_ref', req);
        if (url) imageUrls.push(url);
      }

      const idempotencyKey = globalThis.crypto ? globalThis.crypto.randomUUID() : `idemp_${Date.now()}_${Math.random().toString(36).substring(2)}`;

      const payload: Record<string, any> = {
        model: 'seedance-2.0-fast',
        prompt: prompt.trim(),
        duration: Number(video_length) || 5,
        seconds: String(Number(video_length) || 5),
        metadata: {
          ratio: aspect_ratio,
          resolution: resolution || '720p',
        }
      };

      if (imageUrls.length > 0) {
        payload.images = imageUrls;
      }

      console.log(`[video] Step1 SeedanceFast 创建任务: model=${model} duration=${payload.duration} resolution=${resolution} refs=${imageUrls.length}`);

      const createResp = await fetch(`${baseUrl}/v1/video/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] Seedance 2.0 Fast 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isSeedanceJsonModel) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Seedance 2.0 任务...' });

      // 将 base64 素材保存到本地并生成自托管公网 URL
      const imageUrls: string[] = [];
      for (const img of (reference_images || []).slice(0, 9)) {
        const url = convertBase64ToPublicUrl(img, 'sd2_ref', req);
        if (url) imageUrls.push(url);
      }
      const videoRefUrls: string[] = [];
      for (const v of finalVideos.slice(0, 3)) {
        const url = convertBase64ToPublicUrl(v, 'sd2_vid', req);
        if (url) videoRefUrls.push(url);
      }
      const audioRefUrls: string[] = [];
      for (const a of finalAudios.slice(0, 3)) {
        const url = convertBase64ToPublicUrl(a, 'sd2_aud', req);
        if (url) audioRefUrls.push(url);
      }

      let finalPrompt = prompt.trim();
      finalPrompt = finalPrompt.replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (match, idxStr) => {
        const idx = parseInt(idxStr, 10);
        return `@Image${idx + 1}`;
      });
      for (let i = 0; i < videoRefUrls.length; i++) {
        finalPrompt = finalPrompt.replace(new RegExp(`\\[ref_video_${i + 1}\\]`, 'g'), `@Video${i + 1}`);
      }
      finalPrompt = finalPrompt.replace(/\[ref_video\]/g, '@Video1');
      for (let i = 0; i < audioRefUrls.length; i++) {
        finalPrompt = finalPrompt.replace(new RegExp(`\\[ref_audio_${i + 1}\\]`, 'g'), `@Audio${i + 1}`);
      }
      finalPrompt = finalPrompt.replace(/\[ref_audio\]/g, '@Audio1');

      const payload: Record<string, any> = {
        model: upstreamModel,
        prompt: finalPrompt,
        duration: Number(video_length) || 8,
        aspect_ratio: aspect_ratio,
      };

      if (model === 'seedance2.0-full-9img') {
        if (imageUrls.length > 0) payload.referenceImages = imageUrls;
        if (videoRefUrls.length > 0) payload.referenceVideos = videoRefUrls;
        if (audioRefUrls.length > 0) payload.referenceAudios = audioRefUrls;
      } else {
        if (imageUrls.length > 0) payload.image_refs = imageUrls;
        if (videoRefUrls.length > 0) payload.video_refs = videoRefUrls;
        if (audioRefUrls.length > 0) payload.audio_refs = audioRefUrls;
      }

      console.log(`[video] Step1 sd2 创建任务: model=${model} upstreamModel=${upstreamModel} duration=${payload.duration} resolution=${resolution} refs=${imageUrls.length} video=${videoRefUrls.length} audio=${audioRefUrls.length}`);

      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] sd2 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isJimeng) {
      sendEvent({ type: 'status', message: '正在处理并提交 Jimeng 任务...' });
      const imageUrls: string[] = [];
      for (const img of (reference_images || [])) {
        const url = convertBase64ToPublicUrl(img, 'jimeng_ref', req);
        if (url) imageUrls.push(url);
      }

      let payload: Record<string, any> = {};
      if (model === 'jimeng-video-seedance-2.0-fast') {
        payload = {
          model: upstreamModel,
          prompt: prompt.trim(),
          ratio: aspect_ratio,
          duration: `${video_length}s`,
          resolution: '720p',
          generation_mode: imageUrls.length > 0 ? 'reference_video' : 'text_to_video',
          reference_mode: imageUrls.length > 0 ? 'all_reference' : undefined,
          referenceImages: imageUrls.length > 0 ? imageUrls : undefined,
        };
      } else {
        payload = {
          model: upstreamModel,
          prompt: prompt.trim(),
          functionMode: imageUrls.length > 0 ? 'omni_reference' : 'first_last_frames',
          ratio: aspect_ratio,
          duration: Number(video_length) || 5,
          resolution: resolution || '720p',
          referenceImages: imageUrls.length > 0 ? imageUrls : undefined,
        };
      }

      console.log(`[video] Step1 Jimeng 创建任务: model=${model} duration=${payload.duration} refs=${imageUrls.length}`);
      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] Jimeng 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isSora2) {
      sendEvent({ type: 'status', message: '正在处理并提交 Sora 2 任务...' });
      const imageUrls: string[] = [];
      for (const img of (reference_images || [])) {
        const url = convertBase64ToPublicUrl(img, 'sora2_ref', req);
        if (url) imageUrls.push(url);
      }
      const payload: Record<string, any> = {
        model: upstreamModel,
        prompt: prompt.trim(),
      };
      if (imageUrls.length > 0) {
        payload.input_reference = {
          type: "input_image",
          image_url: {
            url: imageUrls[0]
          }
        };
      }
      console.log(`[video] Step1 Sora2 创建任务: model=${model} upstreamModel=${upstreamModel} refs=${imageUrls.length}`);
      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] Sora 2 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else {
      // ━━━ Step 1: 创建视频任务（multipart/form-data） ━━━
      sendEvent({ type: 'status', message: hasRef ? '正在上传参考图并提交任务...' : '正在提交视频生成任务...' });

      const formData = new FormData();
      formData.append('model', model);
      formData.append('prompt', prompt.trim());
      formData.append('seconds', String(video_length));
      formData.append('size', size);
      formData.append('resolution_name', resolution);

      // 参考图：将 base64 dataURL 转为 Blob 文件上传
      // 1.0-video 和 1.5-fast 支持最多 7 张参考图，其余 1.5-preview/1.5-1080p 仅允许 1 张，其它默认最多 5 张
      const maxRefs = (model === 'grok-imagine-1.0-video' || model === 'grok-imagine-video-1.5-fast') ? 7 : (meta?.requireRef ? 1 : 5);
      if (hasRef) {
        for (let i = 0; i < Math.min(reference_images.length, maxRefs); i++) {
          const dataUrl: string = reference_images[i];
          const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            const mimeType = matches[1];
            const base64Data = matches[2];
            const buffer = Buffer.from(base64Data, 'base64');
            const blob = new Blob([buffer], { type: mimeType });
            const ext = mimeType.includes('png') ? 'png' : 'jpg';
            formData.append('input_reference[]', blob, `ref_${i}.${ext}`);
          }
        }
      }

      const headers: Record<string, string> = {};
      if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

      console.log(`[video] Step1 创建任务: model=${model} seconds=${video_length} hasRef=${hasRef} refCount=${hasRef ? Math.min(reference_images.length, 5) : 0}`);

      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers,
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.id;
    }

    console.log(`[video] 任务已创建: id=${videoId}`);
    sendEvent({ type: 'status', message: `任务已提交，等待生成... (${videoId})` });

    if (contentId !== null) {
      activePolls.add(contentId);
      if (videoId) {
        try {
          const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
          if (row) {
            const meta = JSON.parse(row.metadata || '{}');
            meta.videoId = videoId;
            db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
          }
        } catch (dbErr) {
          console.error('[video] 写入 videoId 失败:', dbErr);
        }
      }
    }

    if (!videoId) {
      if (contentId !== null) activePolls.delete(contentId);
      sendEvent({ type: 'error', message: '上游未返回任务 ID' });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ━━━ Step 2: 轮询任务状态（无超时，直到上游返回完成或失败） ━━━
    const pollInterval = 5000; // 5 秒轮询

    const headers: Record<string, string> = {};
    if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

    while (true) {
      await new Promise(r => setTimeout(r, pollInterval));

      // 检查客户端是否断开仅进行日志记录，不终止后台轮询以完成计费和数据库更新
      if (res.writableEnded || res.destroyed) {
        console.log(`[video] 客户端已断开，后台继续轮询任务 ${videoId}...`);
      }

      try {
        let pollUrl = `${baseUrl}/v1/videos/${videoId}`;
        if (isOmni || isSudaShui) {
          pollUrl = `${baseUrl}/v1/video/generations/${videoId}`;
        }

        const pollResp = await fetch(pollUrl, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });

        if (!pollResp.ok) {
          console.warn(`[video] 轮询返回 ${pollResp.status}`);
          continue;
        }

        const status = await pollResp.json() as any;
        let taskStatus = status.status;
        let progress = status.progress || 0;
        let resultUrl = '';
        let errMsg = '';

        if (isOmni || isSudaShui) {
          const dataBlock = status.data || {};
          taskStatus = (dataBlock.status || status.status || '').toLowerCase();

          const progressStr = dataBlock.progress || status.progress || '0%';
          progress = parseInt(progressStr) || 0;

          if (taskStatus === 'success' || taskStatus === 'completed') {
            resultUrl = dataBlock.result_url || (dataBlock.data && dataBlock.data.url) || status.result_url || status.url;
          } else if (taskStatus === 'failure' || taskStatus === 'failed') {
            const errVal = dataBlock.error || status.error;
            const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
            errMsg = dataBlock.fail_reason || detailMsg || '视频生成失败';
          }
        } else if (isSeedanceFast) {
          const outerData = status.data || {};
          const isNested = status.data && status.data.status !== undefined;
          
          if (isNested) {
            const rawStatus = (outerData.status || '').toLowerCase();
            if (rawStatus === 'not_start') {
              taskStatus = 'pending';
              progress = 0;
            } else if (rawStatus === 'in_progress') {
              taskStatus = 'in_progress';
              progress = status.progress || outerData.progress || 50;
            } else if (rawStatus === 'success') {
              taskStatus = 'success';
              progress = 100;
              const innerData = outerData.data || {};
              const content = innerData.content || {};
              resultUrl = content.video_url || '';
            } else if (rawStatus === 'failure') {
              taskStatus = 'failure';
              errMsg = '视频生成失败';
            } else {
              taskStatus = rawStatus;
            }
          } else {
            taskStatus = (status.status || '').toLowerCase();
            const rawProgress = status.progress;
            if (rawProgress !== undefined && rawProgress !== null) {
              progress = typeof rawProgress === 'number' ? rawProgress : (parseInt(String(rawProgress)) || 0);
            }
            if (taskStatus === 'completed' || taskStatus === 'success') {
              resultUrl = status.video_url || status.url || status.result_url || (status.result && status.result.url)
                || (Array.isArray(status.outputs) && status.outputs[0]?.url)
                || `${baseUrl}/v1/files/video?id=${videoId}`;
            } else if (taskStatus === 'failed' || taskStatus === 'failure') {
              const errVal = status.error;
              const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
              errMsg = detailMsg || status.failure_reason || status.fail_reason || '视频生成失败';
            }
          }
        } else {
          taskStatus = (status.status || '').toLowerCase();
          // 解析进度：支持数字 (16) 和百分比字符串 ("16%") 两种格式
          const rawProgress = status.progress;
          if (rawProgress !== undefined && rawProgress !== null) {
            progress = typeof rawProgress === 'number' ? rawProgress : (parseInt(String(rawProgress)) || 0);
          }
          if (taskStatus === 'completed' || taskStatus === 'success') {
            resultUrl = status.video_url || status.url || status.result_url || (status.result && status.result.url)
              || (Array.isArray(status.outputs) && status.outputs[0]?.url)
              || `${baseUrl}/v1/files/video?id=${videoId}`;
          } else if (taskStatus === 'failed' || taskStatus === 'failure') {
            const errVal = status.error;
            const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
            errMsg = detailMsg || status.failure_reason || status.fail_reason || '视频生成失败';
          }
        }

        console.log(`[video] 轮询 (${isOmni ? 'Omni' : isSudaShui ? 'SudaShui' : isSoraV4 ? 'SoraV4' : isSeedanceFast ? 'SeedanceFast' : 'Grok'}): status=${taskStatus} progress=${progress}%`);

        if (taskStatus === 'processing' || taskStatus === 'queued' || taskStatus === 'pending' || taskStatus === 'submitted' || taskStatus === 'in_progress') {
          sendEvent({ type: 'progress', progress });
          sendEvent({ type: 'status', message: `视频生成中 ${progress}%` });
          // 将实时进度写入数据库，以便前端刷新页面后恢复时能读取
          if (contentId !== null && progress > 0) {
            try {
              const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
              if (row) {
                const meta = JSON.parse(row.metadata || '{}');
                meta.progress = progress;
                db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
              }
            } catch { }
          }
        } else if (taskStatus === 'completed' || taskStatus === 'success') {
          console.log(`[video] ✅ 生成完成: ${resultUrl}`);
          sendEvent({ type: 'progress', progress: 100 });

          // 4月天渠道视频自动预转码本地化（H.265→H.264）
          let finalVideoUrl = resultUrl;
          if (resultUrl && resultUrl.includes('llm.chre3.com')) {
            try {
              finalVideoUrl = await localizeChre3Video(resultUrl, videoId, model);
              console.log(`[video] 4月天视频已本地化: ${finalVideoUrl}`);
            } catch (localErr: any) {
              console.error(`[video] 4月天视频本地化失败，使用原始URL: ${localErr.message}`);
              finalVideoUrl = resultUrl;
            }
          }

          sendEvent({ type: 'complete', videoUrl: finalVideoUrl });
          billUsage(finalVideoUrl);
          if (contentId !== null) activePolls.delete(contentId);
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        } else if (taskStatus === 'failed' || taskStatus === 'failure') {
          console.error(`[video] ❌ 生成失败: ${errMsg}`);
          sendEvent({ type: 'error', message: errMsg });
          if (contentId !== null) {
            activePolls.delete(contentId);
            try {
              db.update(contents).set({ status: 'failed' }).where(eq(contents.id, contentId)).run();
            } catch (dbErr) { console.error('[video] 失败状态更新错误:', dbErr); }
          }
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }
      } catch (pollErr: any) {
        console.warn(`[video] 轮询异常: ${pollErr.message}`);
        // 轮询失败不立即退出，继续重试
      }
    }

  } catch (err: any) {
    console.error(`[video] 生成失败:`, err.name, err.message, err.cause?.message || '');
    const msg = err.name === 'AbortError'
      ? '请求超时'
      : (err.cause?.message || err.message || '请求失败');
    sendEvent({ type: 'error', message: msg });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// 视频下载代理，解决浏览器跨域下载变成播放的问题
router.get('/download', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const filename = req.query.filename as string || 'video.mp4';

    // 1. 判断是否是本地已存储的视频文件（如果是，直接使用 res.sendFile 返回，避免 fetch 报错）
    let isLocalFile = false;
    let localFilePath = '';

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      isLocalFile = true;
      const cleanPath = url.replace(/^.*\/uploads\//, '');
      localFilePath = path.join(process.cwd(), 'data/uploads', cleanPath);
    } else {
      const uploadsIndex = url.indexOf('/uploads/');
      if (uploadsIndex !== -1) {
        isLocalFile = true;
        const cleanPath = url.substring(uploadsIndex + '/uploads/'.length);
        localFilePath = path.join(process.cwd(), 'data/uploads', cleanPath);
      }
    }

    if (isLocalFile) {
      if (fs.existsSync(localFilePath)) {
        return res.download(localFilePath, filename);
      } else {
        return res.status(404).send('Local video file not found');
      }
    }

    // 2. 如果是上游在线视频，代理下载并处理授权头
    const headers: Record<string, string> = {};
    if (url.includes('grokai') || url.includes('/v1/files/video')) {
      const channel = findVideoChannel('grok-imagine-video');
      if (channel?.apiKey) {
        headers['Authorization'] = `Bearer ${channel.apiKey}`;
      }
    } else if (url.includes('llm.chre3.com')) {
      const channel = findVideoChannel('sd2-c7');
      if (channel?.apiKey) {
        headers['Authorization'] = `Bearer ${channel.apiKey}`;
      }
    }

    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`Failed to fetch video: ${response.statusText}`);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', response.headers.get('Content-Type') || 'video/mp4');
    const contentLength = response.headers.get('Content-Length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const reader = response.body?.getReader();
    if (!reader) return res.status(500).send('No video stream body');

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  } catch (err: any) {
    console.error('[video/download] error:', err.message);
    res.status(502).send(`Download failed: ${err.message}`);
  }
});

// Cache directory for H.264 transcoded files
const videoCacheDir = path.resolve('data/video_cache');
if (!fs.existsSync(videoCacheDir)) {
  fs.mkdirSync(videoCacheDir, { recursive: true });
}

// 自动清理 3 天前的缓存文件
export function cleanVideoCache() {
  console.log('[video-cache] 开始自动扫描清理 3 天前的过期视频缓存...');
  try {
    if (!fs.existsSync(videoCacheDir)) return;
    const files = fs.readdirSync(videoCacheDir);
    const now = Date.now();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    let count = 0;
    for (const file of files) {
      const filePath = path.join(videoCacheDir, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        const age = now - stat.mtimeMs;
        if (age > threeDaysMs) {
          fs.unlinkSync(filePath);
          count++;
        }
      }
    }
    if (count > 0) {
      console.log(`[video-cache] 缓存清理完成，共删除了 ${count} 个过期视频缓存文件`);
    }
  } catch (err: any) {
    console.error('[video-cache] 自动清理视频缓存失败:', err.message);
  }
}

// 启动时清理，并设定每 12 小时执行一次
cleanVideoCache();
setInterval(cleanVideoCache, 12 * 60 * 60 * 1000);

// 内存锁：防止同一 URL 被多个并发 Range 请求同时下载+转码
const playTranscodeLocks = new Map<string, Promise<string>>();

// 视频播放代理：检测并转码 H.265 (HEVC) -> H.264 (AVC)，并发安全
router.get('/play', async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const cachedFilePath = path.join(videoCacheDir, `${hash}.mp4`);

    // 1. 如果缓存已存在，直接返回
    if (fs.existsSync(cachedFilePath)) {
      return res.sendFile(cachedFilePath);
    }

    // 2. 检查是否已有相同 URL 的转码任务正在进行（内存锁去重）
    let transcodePromise = playTranscodeLocks.get(hash);
    if (!transcodePromise) {
      // 没有进行中的任务，创建新的
      transcodePromise = (async () => {
        const uuid = crypto.randomUUID();
        const tempOriginalPath = path.join(videoCacheDir, `${hash}_temp_${uuid}.mp4`);
        const tempTranscodedPath = path.join(videoCacheDir, `${hash}_tc_${uuid}.mp4`);

        try {
          console.log(`[video/play] 开始下载并检测视频是否需要转码: ${url}`);

          // 动态匹配授权头
          const headers: Record<string, string> = {};
          if (url.includes('grokai') || url.includes('/v1/files/video')) {
            const channel = findVideoChannel('grok-imagine-video');
            if (channel?.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;
          } else if (url.includes('llm.chre3.com')) {
            const channel = findVideoChannel('sd2-c7');
            if (channel?.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;
          }

          const fetchResp = await fetch(url, { headers });
          if (!fetchResp.ok) throw new Error(`无法获取原始视频流: ${fetchResp.statusText}`);
          const buffer = Buffer.from(await fetchResp.arrayBuffer());
          fs.writeFileSync(tempOriginalPath, buffer);

          // ffprobe 检测编码
          let isHevc = false;
          try {
            const ffprobeOut = execSync(
              `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1 "${tempOriginalPath}"`,
              { encoding: 'utf8' }
            );
            isHevc = ffprobeOut.includes('hevc');
          } catch {
            console.warn('[video/play] ffprobe 探测失败，默认尝试转码');
            isHevc = true;
          }

          if (isHevc) {
            console.log(`[video/play] 检测到 H.265 (HEVC)，转码为 H.264...`);
            await execPromise(
              `ffmpeg -y -i "${tempOriginalPath}" -c:v libx264 -pix_fmt yuv420p -preset superfast -movflags faststart -c:a copy "${tempTranscodedPath}"`
            );
            // 原子 rename 交付缓存
            fs.renameSync(tempTranscodedPath, cachedFilePath);
            console.log(`[video/play] H.264 转码完成: ${cachedFilePath}`);
          } else {
            console.log(`[video/play] 标准 H.264 编码，直接缓存`);
            fs.renameSync(tempOriginalPath, cachedFilePath);
          }

          return cachedFilePath;
        } finally {
          // 清理临时文件
          try { if (fs.existsSync(tempOriginalPath)) fs.unlinkSync(tempOriginalPath); } catch {}
          try { if (fs.existsSync(tempTranscodedPath)) fs.unlinkSync(tempTranscodedPath); } catch {}
        }
      })();

      playTranscodeLocks.set(hash, transcodePromise);
      // 在 chain 的最末尾挂载 catch，防止 finally 返回的 Rejected Promise 导致 Node 进程崩溃 (unhandledRejection)
      transcodePromise
        .finally(() => playTranscodeLocks.delete(hash))
        .catch(() => {});
    } else {
      console.log(`[video/play] 复用正在进行的转码任务: ${hash}`);
    }

    // 3. 等待转码完成，返回缓存文件
    await transcodePromise;
    res.sendFile(cachedFilePath);
  } catch (err: any) {
    console.error('[video/play] 播放代理失败:', err.message);
    res.status(502).send(`Playback proxy failed: ${err.message}`);
  }
});

// ═══ 视频合并接口 ═══
router.post('/merge', authMiddleware, async (req: Request, res: Response) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || urls.length < 2) return res.status(400).json({ error: '至少需要 2 个视频 URL' });
  if (urls.length > 20) return res.status(400).json({ error: '最多支持 20 段' });

  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-merge-'));
  const files: string[] = [];

  try {
    // 1. 下载所有视频
    for (let i = 0; i < urls.length; i++) {
      const filePath = path.join(tmpDir, `seg_${i}.mp4`);
      const resp = await fetch(urls[i]);
      if (!resp.ok) throw new Error(`下载第 ${i + 1} 段失败: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(filePath, buf);
      files.push(filePath);
    }

    // 2. 生成 concat 文件
    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));

    // 3. ffmpeg 合并
    const outputFile = path.join(tmpDir, 'merged.mp4');
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}"`, { timeout: 120000 });

    // 4. 返回合并文件
    const stat = fs.statSync(outputFile);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="merged.mp4"');
    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on('end', () => {
      // 清理临时文件
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    });
  } catch (err: any) {
    // 清理
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    console.error('[video/merge]', err.message);
    res.status(500).json({ error: err.message || '合并失败' });
  }
});

export function resumePollForTask(contentId: number, record: any) {
  if (activePolls.has(contentId)) return;
  activePolls.add(contentId);

  const model = record.modelId || '';
  const meta = MODEL_META[model];
  const channel = findVideoChannel(model);
  if (!channel) {
    console.error(`[video-recover] No channel found for model ${model} in task ${contentId}`);
    activePolls.delete(contentId);
    try {
      db.update(contents).set({ status: 'failed', updatedAt: new Date().toISOString() }).where(eq(contents.id, contentId)).run();
    } catch (dbErr) {
      console.error(`[video-recover] Failed to set status to failed for task ${contentId}:`, dbErr);
    }
    return;
  }

  let videoId = '';
  let metadata: any = {};
  try {
    metadata = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : (record.metadata || {});
    videoId = metadata.videoId || '';
  } catch (e) {
    console.error(`[video-recover] Parse metadata failed for task ${contentId}:`, e);
  }

  if (!videoId) {
    console.error(`[video-recover] No videoId found in metadata for task ${contentId}`);
    activePolls.delete(contentId);
    try {
      db.update(contents).set({ status: 'failed', updatedAt: new Date().toISOString() }).where(eq(contents.id, contentId)).run();
    } catch (dbErr) {
      console.error(`[video-recover] Failed to set status to failed for task ${contentId}:`, dbErr);
    }
    return;
  }

  const resolution = metadata.resolution || '720p';
  const video_length = metadata.seconds || 6;

  // Calculate billing rate
  let rate = 0.05;
  if (model === 'omni-flash') {
    const key = resolution === '1080p' ? 'omni_flash_rate_1080p' : 'omni_flash_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    rate = parseFloat(row?.value || (resolution === '1080p' ? '1.50' : '0.90'));
  } else if (model === 'omni-flash-vref') {
    const key = resolution === '1080p' ? 'omni_vref_rate_1080p' : 'omni_vref_rate_720p';
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    rate = parseFloat(row?.value || (resolution === '1080p' ? '2.20' : '1.60'));
  } else if (model === 'sdas-hn-sd2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_hn_sd20_720p_rate')).get();
    rate = parseFloat(row?.value || '3.80');
  } else if (model === 'sdas-hn-sd2.0-fast-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_hn_sd20_fast_720p_rate')).get();
    rate = parseFloat(row?.value || '2.80');
  } else if (model === 'seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'veo-omni-flash') {
    const row = db.select().from(settings).where(eq(settings.key, 'veo_omni_flash_rate')).get();
    rate = parseFloat(row?.value || '5.00');
  } else if (model === 'sora-v4-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_fast_rate')).get();
    rate = parseFloat(row?.value || '0.189');
  } else if (model === 'sora-v4-pro' || model === 'seedance-2.0') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'sd2-c7') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_c7_rate')).get();
    rate = parseFloat(row?.value || '0.50');
  } else if (model === 'seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_720p_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'seedance-2.0-fast-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_720p_rate')).get();
    rate = parseFloat(row?.value || '1.50');
  } else {
    const rate480 = db.select().from(settings).where(eq(settings.key, 'video_rate_480p')).get();
    const rate720 = db.select().from(settings).where(eq(settings.key, 'video_rate_720p')).get();
    const BASE_RATE: Record<string, number> = {
      '480p': parseFloat(rate480?.value || '0.03'),
      '720p': parseFloat(rate720?.value || '0.05'),
    };
    const seriesMultiplier = meta?.series === '1.5' ? 1.2 : 1.0;
    rate = Math.round((BASE_RATE[resolution] || BASE_RATE['720p']) * seriesMultiplier * 100) / 100;
  }

  const isFlatRate = ['sdas-hn-sd2.0-720p', 'sdas-hn-sd2.0-fast-720p', 'seedance-2.0-fast', 'sd2-c7', 'seedance-2.0-720p', 'seedance-2.0-fast-720p'].includes(model);

  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const isOmni = model.startsWith('omni-flash');
  const isSeedanceFast = model === 'seedance-2.0-fast';
  const isSoraV4 = model === 'sora-v4-fast' || model === 'sora-v4-pro' || model === 'seedance-2.0';
  const isSudaShui = meta?.series === 'sudashui';

  const headers: Record<string, string> = {};
  if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

  (async () => {
    console.log(`[video-recover] Starting polling for video task ${contentId} (videoId: ${videoId})`);
    const pollInterval = 5000;
    const startTime = Date.now();

    while (true) {
      const currentRecord = db.select().from(contents).where(eq(contents.id, contentId)).get();
      if (!currentRecord || currentRecord.status !== 'processing') {
        console.log(`[video-recover] Task ${contentId} is no longer in processing status (or was deleted)`);
        break;
      }

      await new Promise(r => setTimeout(r, pollInterval));

      try {
        let pollUrl = `${baseUrl}/v1/videos/${videoId}`;
        if (isOmni || isSudaShui) {
          pollUrl = `${baseUrl}/v1/video/generations/${videoId}`;
        }

        const pollResp = await fetch(pollUrl, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });

        if (!pollResp.ok) {
          console.warn(`[video-recover] Poll returned ${pollResp.status}`);
          continue;
        }

        const statusData = await pollResp.json() as any;
        let taskStatus = statusData.status;
        let progress = statusData.progress || 0;
        let resultUrl = '';
        let errMsg = '';

        if (isOmni || isSudaShui) {
          const dataBlock = statusData.data || {};
          taskStatus = (dataBlock.status || statusData.status || '').toLowerCase();
          const progressStr = dataBlock.progress || statusData.progress || '0%';
          progress = parseInt(progressStr) || 0;
          if (taskStatus === 'success' || taskStatus === 'completed') {
            resultUrl = dataBlock.result_url || (dataBlock.data && dataBlock.data.url) || statusData.result_url || statusData.url;
          } else if (taskStatus === 'failure' || taskStatus === 'failed') {
            const errVal = dataBlock.error || statusData.error;
            const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
            errMsg = dataBlock.fail_reason || detailMsg || '视频生成失败';
          }
        } else if (isSeedanceFast) {
          const outerData = statusData.data || {};
          const isNested = statusData.data && statusData.data.status !== undefined;
          if (isNested) {
            const rawStatus = (outerData.status || '').toLowerCase();
            if (rawStatus === 'not_start') {
              taskStatus = 'pending';
              progress = 0;
            } else if (rawStatus === 'in_progress') {
              taskStatus = 'in_progress';
              progress = statusData.progress || outerData.progress || 50;
            } else if (rawStatus === 'success') {
              taskStatus = 'success';
              progress = 100;
              const innerData = outerData.data || {};
              const content = innerData.content || {};
              resultUrl = content.video_url || '';
            } else if (rawStatus === 'failure') {
              taskStatus = 'failure';
              errMsg = '视频生成失败';
            } else {
              taskStatus = rawStatus;
            }
          } else {
            taskStatus = (statusData.status || '').toLowerCase();
            const rawProgress = statusData.progress;
            if (rawProgress !== undefined && rawProgress !== null) {
              progress = typeof rawProgress === 'number' ? rawProgress : (parseInt(String(rawProgress)) || 0);
            }
             if (taskStatus === 'completed' || taskStatus === 'success') {
              resultUrl = statusData.video_url || statusData.url || statusData.result_url || (statusData.result && statusData.result.url)
                || (Array.isArray(statusData.outputs) && statusData.outputs[0]?.url)
                || `${baseUrl}/v1/files/video?id=${videoId}`;
            } else if (taskStatus === 'failed' || taskStatus === 'failure') {
              const errVal = statusData.error;
              const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
              errMsg = detailMsg || statusData.failure_reason || statusData.fail_reason || '视频生成失败';
            }
          }
        } else {
          taskStatus = (statusData.status || '').toLowerCase();
          const rawProgress = statusData.progress;
          if (rawProgress !== undefined && rawProgress !== null) {
            progress = typeof rawProgress === 'number' ? rawProgress : (parseInt(String(rawProgress)) || 0);
          }
          if (taskStatus === 'completed' || taskStatus === 'success') {
            resultUrl = statusData.video_url || statusData.url || statusData.result_url || (statusData.result && statusData.result.url)
              || (Array.isArray(statusData.outputs) && statusData.outputs[0]?.url)
              || `${baseUrl}/v1/files/video?id=${videoId}`;
          } else if (taskStatus === 'failed' || taskStatus === 'failure') {
            const errVal = statusData.error;
            const detailMsg = (typeof errVal === 'object' && errVal) ? errVal.message : errVal;
            errMsg = detailMsg || statusData.failure_reason || statusData.fail_reason || '视频生成失败';
          }
        }

        console.log(`[video-recover] Polling task ${contentId}: status=${taskStatus} progress=${progress}%`);

        if (taskStatus === 'processing' || taskStatus === 'queued' || taskStatus === 'pending' || taskStatus === 'submitted' || taskStatus === 'in_progress') {
          try {
            const meta = JSON.parse(currentRecord.metadata || '{}');
            meta.progress = progress;
            db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
          } catch {}
        } else if (taskStatus === 'completed' || taskStatus === 'success') {
          console.log(`[video-recover] ✅ Generating completed: ${resultUrl}`);
          logUsage(record.userId, 'generate_video', undefined, Date.now() - startTime);
          const cost = isFlatRate ? rate : (Math.round(rate * video_length * 100) / 100);
          if (cost > 0) {
            BalanceService.deduct(record.userId, cost, 'generate_video');
          }
          db.update(contents).set({
            status: 'completed',
            resultUrl: resultUrl || null,
            cost: cost
          }).where(eq(contents.id, contentId)).run();
          break;
        } else if (taskStatus === 'failed' || taskStatus === 'failure') {
          console.error(`[video-recover] ❌ Generating failed: ${errMsg}`);
          db.update(contents).set({ status: 'failed' }).where(eq(contents.id, contentId)).run();
          break;
        }
      } catch (err: any) {
        console.warn(`[video-recover] Polling exception: ${err.message}`);
      }
    }

    activePolls.delete(contentId);
    console.log(`[video-recover] Task ${contentId} polling terminated.`);
  })();
}

export function resumeAllPendingVideoTasks() {
  console.log('🔍 [video-recover] Scanning for stuck processing video tasks...');
  try {
    const pendingTasks = db.select().from(contents)
      .where(and(eq(contents.status, 'processing'), eq(contents.type, 'video')))
      .all();
    console.log(`🔍 [video-recover] Found ${pendingTasks.length} pending video tasks to recover`);

    pendingTasks.forEach((record: any) => {
      const contentId = record.id;
      if (!activePolls.has(contentId)) {
        resumePollForTask(contentId, record);
      }
    });
  } catch (err: any) {
    console.error('⚠️ [video-recover] Scan pending tasks failed:', err.message);
  }
}

export default router;
