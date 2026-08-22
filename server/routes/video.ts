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
import { eq, like, and, inArray } from 'drizzle-orm';
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
  'omni-flash': { series: 'omni-flash', allowedSeconds: [4, 6, 8, 10], requireRef: false },
  'omni-flash-vref': { series: 'omni-flash-vref', allowedSeconds: [10], requireRef: false },
  'sora-v4-fast': { series: 'sora-v4', allowedSeconds: [10, 15], requireRef: false },
  'sora-v4-pro': { series: 'sora-v4', allowedSeconds: [10, 15], requireRef: false },
  'sdas-pd-sd2.0-pro-933-5-720p': { series: 'sudashui', allowedSeconds: [10], requireRef: false },
  'sdas-hn-sd2.0-fast-720p': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'ld-sdas-cvk-pro-933-720p': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sdas-mj-minimax-h3-2k': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sdas-bl-sd2.0-933-pro-720p': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sdas-bl-sd2.0-933-pro-noface-720p': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'cd-seedance-2.0-720p': { series: 'seedance-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'nd-seedance-2.0-480p': { series: 'seedance-480p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'nd-seedance-2.0-720p': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance-2.0-fast': { series: 'seedance-fast', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'veo-omni-flash': { series: 'veo-omni-flash', allowedSeconds: [10], requireRef: false },
  'veo-3-1': { series: 'veo-3-1', allowedSeconds: [8], requireRef: false },
  'sd2-c7': { series: 'sd2-c7', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sd2.5': { series: 'sd2.5', allowedSeconds: [30], requireRef: false },
  'seedance-2.5-c1': { series: 'seedance-2.5', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'seedance-2.0-720p': { series: 'seedance-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance-2.0-fast-720p': { series: 'seedance-fast-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance-720': { series: 'seedance-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'tejiasd2': { series: 'seedance-720p', allowedSeconds: [10], requireRef: false },
  'sd2.0-fast-480p': { series: 'seedance-fast-480p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sd2-mini': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance2.0-933': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance2.0 933': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
};

const DEFAULT_VIDEO_MODELS = [
  { id: 'grok-imagine-video-1.5-preview', name: 'Grok 1.5 Preview', description: '图生视频，必须提供参考图，6/10/15秒', maxSeconds: 15, icon: '🖼️' },
  { id: 'grok-imagine-1.0-video', name: 'Grok 1.0 Video', description: '文生/图生视频，支持最多7张参考图，6/10秒', maxSeconds: 10, icon: '🎥' },
  { id: 'grok-imagine-video-1.5-fast', name: 'Grok 1.5 Fast', description: '快速文生/图生视频，支持最多7张参考图，6/10秒', maxSeconds: 10, icon: '⚡' },
  { id: 'omni-flash', name: 'Omni Flash', description: '多参考图生成/纯文生视频，4/6/8/10秒，支持 1080p', maxSeconds: 10, icon: '⚡' },
  { id: 'omni-flash-vref', name: 'Omni Flash Vref', description: '视频风格编辑/改写，支持 1080p', maxSeconds: 10, icon: '✂️' },
  { id: 'sdas-pd-sd2.0-pro-933-5-720p', name: 'Seedance 2.0 Pro 933-5 (720p)', description: '9图3视频3音频，只能10s，S2.0 满血版，支持真人，固定按次计费', maxSeconds: 10, icon: '🚀' },
  { id: 'sdas-hn-sd2.0-fast-720p', name: 'Seedance 2.0 Fast 431 (720p)', description: '4图3视频1音频，4-15s，S2.0 Fast 满血版，支持真人，固定按次计费', maxSeconds: 15, icon: '⚡' },
  { id: 'ld-sdas-cvk-pro-933-720p', name: 'SudaShui CVK Pro 933 (720p)', description: 'CVK 满血版，支持真人、4-15秒，支持 9图/3视频/3音频参考，固定按次计费 ¥3.800/次', maxSeconds: 15, icon: '🚀' },
  { id: 'sdas-mj-minimax-h3-2k', name: 'Minimax H3 (2K)', description: '海螺h3，9图3视频3音频，4-15s，固定按次计费 ¥3.00/次', maxSeconds: 15, icon: '🔥' },
  { id: 'sdas-bl-sd2.0-933-pro-720p', name: 'Seedance 2.0 Pro (933人脸版)', description: '9图3视频3音频，支持 4-15s，支持真人，固定按次计费 ¥4.50/次', maxSeconds: 15, icon: '🚀' },
  { id: 'sdas-bl-sd2.0-933-pro-noface-720p', name: 'Seedance 2.0 Pro (933无脸版)', description: '9图3视频3音频，支持 4-15s，固定按次计费 ¥4.00/次', maxSeconds: 15, icon: '🚀' },
  { id: 'cd-seedance-2.0-720p', name: 'Seedance 2.0 (720p/CD版)', description: '支持最多9张图片、3个视频、3个音频参考，5-15秒，固定按次计费 ¥3.00/次', maxSeconds: 15, icon: '🚀' },
  { id: 'nd-seedance-2.0-480p', name: 'Seedance 2.0 (480p/不卡脸)', description: '9图3视频3音频，支持 4-15s，不卡人脸，固定按次计费 ¥3.15/次', maxSeconds: 15, icon: '⚡' },
  { id: 'nd-seedance-2.0-720p', name: 'Seedance 2.0 (720p/不卡脸)', description: '9图3视频3音频，支持 4-15s，不卡人脸，固定按次计费 ¥4.30/次', maxSeconds: 15, icon: '🚀' },
  { id: 'veo-omni-flash', name: 'Veo Omni Flash', description: '多参考图生成视频，参考图字段 Ingredients_images，固定10s', maxSeconds: 10, icon: '🚀' },
  { id: 'veo-3-1', name: 'Veo 3-1', description: '【不卡人脸-定制版】无水印视频；只支持8秒；支持首尾帧、支持多图参考，最多9张图', maxSeconds: 8, icon: '🚀' },
  { id: 'sd2-c7', name: 'Seedance 2.0 c7', description: 'OpenAI 兼容，支持720p固定分辨率，支持最多10张图片参考（无视频/音频参考），5-15秒，固定按次计费', maxSeconds: 15, icon: '🚀' },
  { id: 'sd2.5', name: 'Seedance 2.5 (sd2.5)', description: '支持9图0视频0音频，卡人脸；适合制作带货视频，固定按次计费 ¥3.50/次', maxSeconds: 30, icon: '🚀' },
  { id: 'seedance-2.5-c1', name: 'Seedance 2.5 (c1/888API)', description: '支持最多30张图片、10个视频、10个音频参考，4-30秒，按秒计费 ¥0.25/秒', maxSeconds: 30, icon: '🚀' },
  { id: 'seedance-2.0-720p', name: 'Seedance 2.0 720p', description: 'Seedance 2.0 标准版，支持720p固定分辨率，支持最多9张图片、3个视频、3个音频参考，5-15秒', maxSeconds: 15, icon: '🚀' },
  { id: 'seedance-2.0-fast-720p', name: 'Seedance 2.0 Fast 720p', description: 'Seedance 2.0 极速版，支持720p固定分辨率，支持最多9张图片、3个视频、3个音频参考，5-15秒', maxSeconds: 15, icon: '⚡' },
  { id: 'seedance-720', name: 'Seedance 720 满血版', description: '满血模型，支持933，过人脸，720p固定分辨率，支持最多9张图片、3个视频、3个音频参考，5-15秒', maxSeconds: 15, icon: '🔥' },
  { id: 'tejiasd2', name: 'tejiasd2', description: 'SD 2.0 9张参考图 3个参考视频 3个参考音频 不卡真人 只支持10秒 特价模型', maxSeconds: 10, icon: '🚀' },
  { id: 'sd2.0-fast-480p', name: 'SD 2.0 Fast (480p)', description: '快速 480p 满血版，概率卡脸，适合漫剧/线图。支持 9张参考图 3个参考视频 3个参考音频，4-15秒', maxSeconds: 15, icon: '⚡' },
  { id: 'sd2-mini', name: 'Seedance Mini (sd2-mini)', description: 'Seedance Mini 720p (933)，支持9图、3音频参考（无视频参考），固定按次计费 ¥2.00/次', maxSeconds: 15, icon: '⚡' },
  { id: 'seedance2.0-933', name: 'seedance2.0 933', description: 'seedance2.0 933 模型，支持9图、3音频参考（无视频参考），固定按次计费 ¥3.00/次', maxSeconds: 15, icon: '🚀' },
  { id: 'seedance2.0 933', name: 'seedance2.0 933', description: 'seedance2.0 933 模型，支持9图、3音频参考（无视频参考），固定按次计费 ¥3.00/次', maxSeconds: 15, icon: '🚀' },
];

/** 查找支持指定视频模型的渠道 */
function findVideoChannel(modelId: string) {
  const channel = ChannelService.findChannelForModel(modelId);
  if (channel) return { baseUrl: channel.baseUrl, apiKey: channel.apiKey };
  if (env.GROK2API_BASE_URL) return { baseUrl: env.GROK2API_BASE_URL, apiKey: env.GROK2API_API_KEY };
  return null;
}

/**
 * 将成功生成的视频（不管是哪个模型）下载、转码为 H.264 并本地化保存至 `/uploads/` 目录。
 * 能够自动提取对应的渠道 API Key 作为 Authorization 头进行下载，防止 401 错误。
 * 转换完成后，以 `video_` 加清洗后的 `videoId` 命名，实现永久本地缓存。
 */
export async function downloadAndLocalizeVideo(url: string, videoId: string, model: string): Promise<string> {
  if (!url) return '';
  // 如果已经是本地路径，跳过
  if (url.startsWith('/') || url.includes('/uploads/')) return url;

  const uploadDir = path.join(process.cwd(), 'data/uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const finalFilename = `video_${safeId}.mp4`;
  const finalPath = path.join(uploadDir, finalFilename);

  // 如果此视频已经本地化过，直接返回
  if (fs.existsSync(finalPath)) {
    console.log(`[video/localize] 已存在本地缓存: ${finalFilename}`);
    return `/uploads/${finalFilename}`;
  }

  const uuid = crypto.randomUUID();
  const tempDownload = path.join(uploadDir, `tmp_dl_${uuid}.mp4`);
  const tempTranscoded = path.join(uploadDir, `tmp_tc_${uuid}.mp4`);

  try {
    console.log(`[video/localize] 开始下载并缓存视频 (task: ${videoId}, url: ${url})`);

    // 获取渠道授权头
    const headers: Record<string, string> = {};
    if (url.includes('grokai') || url.includes('/v1/files/video')) {
      const channel = findVideoChannel('grok-imagine-video');
      if (channel?.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;
    } else if (url.includes('llm.chre3.com')) {
      const channel = findVideoChannel('sd2-c7');
      if (channel?.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;
    } else {
      // 动态检索对应渠道域名
      try {
        const activeChannels = ChannelService.getActiveChannels();
        const matchedChannel = activeChannels.find(ch => {
          if (!ch.baseUrl) return false;
          try {
            const chHost = new URL(ch.baseUrl).hostname;
            const urlHost = new URL(url).hostname;
            return chHost === urlHost;
          } catch {
            return url.includes(ch.baseUrl);
          }
        });
        if (matchedChannel?.apiKey) {
          headers['Authorization'] = `Bearer ${matchedChannel.apiKey}`;
        }
      } catch (err: any) {
        console.warn('[video/localize] 自动匹配渠道 Authorization 失败:', err.message);
      }
    }

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(300_000) });
    if (!resp.ok) throw new Error(`下载失败: ${resp.status} ${resp.statusText}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tempDownload, buffer);
    console.log(`[video/localize] 下载完成: ${buffer.length} 字节`);

    // ffprobe 检测编码
    let isHevc = false;
    try {
      const probeOut = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1 "${tempDownload}"`,
        { encoding: 'utf8' }
      );
      isHevc = probeOut.includes('hevc');
      console.log(`[video/localize] 编码检测: ${probeOut.trim()} (HEVC=${isHevc})`);
    } catch {
      console.warn('[video/localize] ffprobe 检测失败，默认视为 HEVC 进行兼容性转码');
      isHevc = true;
    }

    if (isHevc) {
      console.log('[video/localize] 检测到 HEVC (H.265)，启动 FFmpeg 转码为 H.264...');
      await execPromise(
        `ffmpeg -y -i "${tempDownload}" -c:v libx264 -pix_fmt yuv420p -preset superfast -movflags faststart -c:a copy "${tempTranscoded}"`
      );
      fs.renameSync(tempTranscoded, finalPath);
      console.log(`[video/localize] H.264 转码完成: ${finalFilename}`);
    } else {
      fs.renameSync(tempDownload, finalPath);
      console.log(`[video/localize] 标准 H.264 编码，已直接保存为本地文件: ${finalFilename}`);
    }

    return `/uploads/${finalFilename}`;
  } catch (err: any) {
    console.error(`[video/localize] 本地化缓存失败: ${err.message}`);
    // 如果下载转码失败，返回原始 url 做兜底，让前端能够播放
    return url;
  } finally {
    try { if (fs.existsSync(tempDownload)) fs.unlinkSync(tempDownload); } catch { }
    try { if (fs.existsSync(tempTranscoded)) fs.unlinkSync(tempTranscoded); } catch { }
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
    ? dbModels.map(m => ({ id: m.modelId, name: m.displayName, description: m.description }))
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
  const veoOmniFlashRate = parseFloat(db.select().from(settings).where(eq(settings.key, 'veo_omni_flash_rate')).get()?.value || '0.25');

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
    } else if (m.id === 'veo-3-1') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'veo_3_1_rate')).get()?.value || '0.20');
      rates = {
        '720p': rate,
        '1080p': rate,
      };
    } else if (m.id === 'sd2-c7') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sd2_c7_rate')).get()?.value || '0.50');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sd2.5') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sd2_5_rate')).get()?.value || '3.50');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'seedance-2.5-c1') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'seedance_2_5_c1_rate')).get()?.value || '0.25');
      rates = {
        '480p': rate,
        '720p': rate,
      };
    } else if (m.id === 'sd2-mini') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sd2_mini_rate')).get()?.value || '2.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'seedance2.0-933' || m.id === 'seedance2.0 933') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'seedance2_0_933_rate')).get()?.value || '3.00');
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
    } else if (m.id === 'seedance-720') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'seedance_720_rate')).get()?.value || '3.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sdas-pd-sd2.0-pro-933-5-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sdas_pd_sd20_pro_933_5_720p_rate')).get()?.value || '4.50');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sdas-hn-sd2.0-fast-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sdas_hn_sd20_fast_720p_rate')).get()?.value || '2.80');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sdas-bl-sd2.0-933-pro-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sdas_bl_sd20_933_pro_720p_rate')).get()?.value || '4.50');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sdas-bl-sd2.0-933-pro-noface-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sdas_bl_sd20_933_pro_noface_720p_rate')).get()?.value || '4.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'cd-seedance-2.0-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'cd_seedance_2_0_720p_rate')).get()?.value || '3.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'nd-seedance-2.0-480p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'nd_seedance_2_0_480p_rate')).get()?.value || '3.15');
      rates = {
        '480p': rate,
      };
    } else if (m.id === 'nd-seedance-2.0-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'nd_seedance_2_0_720p_rate')).get()?.value || '4.30');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'ld-sdas-cvk-pro-933-720p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'ld_sdas_cvk_pro_933_720p_rate')).get()?.value || '3.80');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sdas-mj-minimax-h3-2k') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sdas_mj_minimax_h3_2k_rate')).get()?.value || '3.00');
      rates = {
        '2k': rate,
      };
    } else if (m.id === 'tejiasd2') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'tejiasd2_rate')).get()?.value || '3.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sd2.0-fast-480p') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sd20_fast_480p_rate')).get()?.value || '0.22');
      rates = {
        '480p': rate,
      };
    } else if (m.id === 'sd2-c6') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'sd2_c6_rate')).get()?.value || '2.50');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'grok-imagine-1.0-video') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'grok_imagine_1_0_video_rate')).get()?.value || '0.288');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'grok-imagine-video-1.5-fast') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'grok_imagine_video_1_5_fast_rate')).get()?.value || '0.288');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'grok-imagine-video-1.5-preview') {
      const rate = parseFloat(db.select().from(settings).where(eq(settings.key, 'grok_imagine_video_1_5_preview_rate')).get()?.value || '0.48');
      rates = {
        '720p': rate,
      };
    } else {
      rates = {
        '480p': Math.round(base480 * multiplier * 100) / 100,
        '720p': Math.round(base720 * multiplier * 100) / 100,
      };
    }

    const targetIds = Array.from(new Set([m.id, ...(m.id.includes('seedance2.0') || m.id === 'sd2-mini' ? ['seedance2.0-933', 'seedance2.0 933', 'sd2-mini'] : [])]));
    const contentRows = db.select().from(contents).where(inArray(contents.modelId, targetIds)).all();
    const totalCalls = contentRows.length;
    const successCalls = contentRows.filter(r => r.status === 'completed' || r.status === 'success' || (r.resultUrl && r.resultUrl.trim() !== '')).length;
    const successRate = totalCalls > 0 ? Number(((successCalls / totalCalls) * 100).toFixed(1)) : null;

    return {
      id: m.id,
      name: m.name || preset?.name || m.id,
      description: m.description || preset?.description || 'AI 视频生成服务',
      available: findVideoChannel(m.id) !== null,
      maxSeconds: preset?.maxSeconds,
      allowedSeconds: meta?.allowedSeconds || null,
      requireRef: meta?.requireRef || false,
      series: meta?.series || 'legacy',
      rates,
      successRate,
      totalCalls,
    };
  });

  res.json(result.filter(m => m.available));
});

/** POST /api/video/generate — SSE 流式视频生成（异步轮询模式） */
router.post('/generate', authMiddleware, tierMiddleware('video'), quotaMiddleware, async (req: TierRequest, res: Response) => {
  if (req.body.model === 'sdas-xh-sd2.0-933-3-pro-720p') {
    req.body.model = 'sdas-pd-sd2.0-pro-933-5-720p';
  }
  const {
    prompt,
    model = 'grok-imagine-1.0-video',
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
    compliance_enabled,      // 是否开启合规素材/过人脸
    compliance_mode,         // 合规素材风格
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

  if (prompt.trim().length > 5000) {
    return res.status(400).json({ error: '提示词字数不能超过 5000 字' });
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
  if (model === 'sdas-pd-sd2.0-pro-933-5-720p') {
    upstreamModel = 'ld-sdas-cvk-pro-933-720p';
  } else if (model === 'sdas-hn-sd2.0-fast-720p') {
    upstreamModel = 'sdas-hn-sd2.0-fast-720p';
  } else if (dbChannel?.modelMapping) {
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
  } else if (model === 'sdas-pd-sd2.0-pro-933-5-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_pd_sd20_pro_933_5_720p_rate')).get();
    rate = parseFloat(row?.value || '4.50');
  } else if (model === 'sdas-hn-sd2.0-fast-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_hn_sd20_fast_720p_rate')).get();
    rate = parseFloat(row?.value || '2.80');
  } else if (model === 'sdas-bl-sd2.0-933-pro-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_bl_sd20_933_pro_720p_rate')).get();
    rate = parseFloat(row?.value || '4.50');
  } else if (model === 'sdas-bl-sd2.0-933-pro-noface-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_bl_sd20_933_pro_noface_720p_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'seedance-2.5-c1') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_5_c1_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'cd-seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'cd_seedance_2_0_720p_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'nd-seedance-2.0-480p') {
    const row = db.select().from(settings).where(eq(settings.key, 'nd_seedance_2_0_480p_rate')).get();
    rate = parseFloat(row?.value || '3.15');
  } else if (model === 'nd-seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'nd_seedance_2_0_720p_rate')).get();
    rate = parseFloat(row?.value || '4.30');
  } else if (model === 'ld-sdas-cvk-pro-933-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'ld_sdas_cvk_pro_933_720p_rate')).get();
    rate = parseFloat(row?.value || '3.80');
  } else if (model === 'sdas-mj-minimax-h3-2k') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_mj_minimax_h3_2k_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'tejiasd2') {
    const row = db.select().from(settings).where(eq(settings.key, 'tejiasd2_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'sd2.0-fast-480p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd20_fast_480p_rate')).get();
    rate = parseFloat(row?.value || '0.22');
  } else if (model === 'seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'veo-omni-flash') {
    const row = db.select().from(settings).where(eq(settings.key, 'veo_omni_flash_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'veo-3-1') {
    const row = db.select().from(settings).where(eq(settings.key, 'veo_3_1_rate')).get();
    rate = parseFloat(row?.value || '0.20');
  } else if (model === 'sora-v4-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_fast_rate')).get();
    rate = parseFloat(row?.value || '0.189');
  } else if (model === 'sora-v4-pro' || model === 'seedance-2.0') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'sd2-c7') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_c7_rate')).get();
    rate = parseFloat(row?.value || '0.50');
  } else if (model === 'sd2.5') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_5_rate')).get();
    rate = parseFloat(row?.value || '4.50');
  } else if (model === 'sd2-c6') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_c6_rate')).get();
    rate = parseFloat(row?.value || '2.50');
  } else if (model === 'seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_720p_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'seedance-2.0-fast-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_720p_rate')).get();
    rate = parseFloat(row?.value || '1.50');
  } else if (model === 'seedance-720') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_720_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'grok-imagine-1.0-video') {
    const row = db.select().from(settings).where(eq(settings.key, 'grok_imagine_1_0_video_rate')).get();
    rate = parseFloat(row?.value || '0.288');
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

  const isFlatRate = [
    'seedance-2.0-fast',
    'sd2-c7',
    'sd2.5',
    'sd2-c6',
    'seedance-2.0-720p',
    'seedance-2.0-fast-720p',
    'seedance-720',
    'grok-imagine-1.0-video',
    'grok-imagine-video-1.5-fast',
    'grok-imagine-video-1.5-preview',
    'sdas-pd-sd2.0-pro-933-5-720p',
    'sdas-hn-sd2.0-fast-720p',
    'ld-sdas-cvk-pro-933-720p',
    'sdas-mj-minimax-h3-2k',
    'sdas-bl-sd2.0-933-pro-720p',
    'sdas-bl-sd2.0-933-pro-noface-720p',
    'cd-seedance-2.0-720p',
    'nd-seedance-2.0-480p',
    'nd-seedance-2.0-720p',
    'tejiasd2'
  ].includes(model);
  const estimatedRate = rate;
  const estimatedSeconds = (model === 'omni-flash-vref' || model === 'sdas-pd-sd2.0-pro-933-5-720p') ? 10 : (Number(video_length) || 6);
  const estimatedCost = isFlatRate ? estimatedRate : (Math.round(estimatedRate * estimatedSeconds * 100) / 100);

  // 1. 提交任务时优先原子预扣费
  let predeductedBalance: number | null = null;
  if (estimatedCost > 0) {
    predeductedBalance = BalanceService.deduct(req.userId!, estimatedCost, 'generate_video_prededuct');
    if (predeductedBalance === null) {
      const { balance: currentBalance } = BalanceService.checkBalance(req.userId!, estimatedCost);
      sendEvent({ type: 'error', message: `余额不足，预估费用 ¥${estimatedCost.toFixed(2)}，当前余额 ¥${currentBalance.toFixed(2)}` });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    sendEvent({ type: 'billing', cost: estimatedCost, resolution, seconds: estimatedSeconds, rate, remainingBalance: predeductedBalance });
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

  /** 生成成功后更新内容（已在前置预扣费，无需重复扣费） */
  const billUsage = (finalVideoUrl: string) => {
    const elapsed = Date.now() - startTime;
    logUsage(req.userId!, 'generate_video', undefined, elapsed);
    if (contentId !== null) {
      try {
        db.update(contents).set({
          status: 'completed',
          resultUrl: finalVideoUrl || null,
          cost: estimatedCost
        }).where(eq(contents.id, contentId)).run();
      } catch (e) { console.error('[content] 视频记录更新失败:', e); }
    }
  };

  /** 任务失败时自动退款 */
  const refundFailedTask = (errMsg: string) => {
    console.error(`[video] ❌ 生成失败: ${errMsg}`);
    sendEvent({ type: 'error', message: errMsg });
    if (estimatedCost > 0) {
      BalanceService.refund(req.userId!, estimatedCost, 'generate_video_refund');
    }
    if (contentId !== null) {
      activePolls.delete(contentId);
      try {
        db.update(contents).set({ status: 'failed', cost: 0 }).where(eq(contents.id, contentId)).run();
      } catch (dbErr) { console.error('[video] 失败状态更新错误:', dbErr); }
    }
  };

  const baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const size = RATIO_TO_SIZE[aspect_ratio] || '1280x720';
  const isOmni = model.startsWith('omni-flash');
  const isSeedanceFast = model === 'seedance-2.0-fast';
  const isSoraV4 = model === 'sora-v4-fast' || model === 'sora-v4-pro' || model === 'seedance-2.0';
  const isSudaShui = meta?.series === 'sudashui';
  const isVeoOmni = model === 'veo-omni-flash';
  const isVeo31 = model === 'veo-3-1';
  const isSeedanceJsonModel = [
    'sd2-c7',
    'sd2.5',
    'seedance-2.5-c1',
    'seedance-2.0-720p',
    'seedance-2.0-fast-720p',
    'seedance-720',
    'tejiasd2',
    'sd2.0-fast-480p',
    'cd-seedance-2.0-720p',
    'nd-seedance-2.0-480p',
    'nd-seedance-2.0-720p'
  ].includes(model);

  let videoId = '';
  try {

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
        refundFailedTask(`Omni 创建任务失败: ${createResp.status}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.id || job.task_id;
    } else if (isSudaShui) {
      sendEvent({ type: 'status', message: '正在上传素材并提交 SudaShui 任务...' });

      const imageUrls: string[] = [];
      for (const img of (reference_images || []).slice(0, 9)) {
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
        duration: model === 'sdas-pd-sd2.0-pro-933-5-720p' ? 10 : (Number(video_length) || 6),
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
        refundFailedTask(`SudaShui 创建任务失败: ${createResp.status}`);
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
        refundFailedTask(`SoraV4 创建任务失败: ${createResp.status}`);
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
        refundFailedTask(`Veo Omni Flash 创建任务失败: ${createResp.status}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isVeo31) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Veo 3-1 任务...' });

      const imageUrls: string[] = [];
      for (const img of (reference_images || []).slice(0, 9)) {
        const url = convertBase64ToPublicUrl(img, 'veo31_ref', req);
        if (url) imageUrls.push(url);
      }
      const firstFrameUrl = first_frame ? convertBase64ToPublicUrl(first_frame, 'veo31_ff', req) : undefined;
      const lastFrameUrl = last_frame ? convertBase64ToPublicUrl(last_frame, 'veo31_lf', req) : undefined;

      const payload: Record<string, any> = {
        model: 'veo-3-1',
        prompt: prompt.trim(),
        duration: 8,
        aspect_ratio: aspect_ratio === '9:16' ? '9:16' : '16:9',
      };

      if (imageUrls.length > 0) {
        payload.reference_images = imageUrls;
      }
      if (firstFrameUrl) {
        payload.first_frame_image = firstFrameUrl;
      }
      if (lastFrameUrl) {
        payload.last_frame_image = lastFrameUrl;
      }

      console.log(`[video] Step1 Veo31 创建任务: model=${model} aspect_ratio=${payload.aspect_ratio} refs=${imageUrls.length} ff=${!!firstFrameUrl} lf=${!!lastFrameUrl}`);

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
        console.error(`[video] Veo 3-1 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        sendEvent({ type: 'error', message: `创建视频任务失败 (${createResp.status}): ${errText.slice(0, 200)}` });
        refundFailedTask(`Veo 3-1 创建任务失败: ${createResp.status}`);
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
        refundFailedTask(`Seedance 2.0 Fast 创建任务失败: ${createResp.status}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isSeedanceJsonModel) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Seedance 2.0 任务...' });

      // 将 base64 素材保存到本地并生成自托管公网 URL
      const imageUrls: string[] = [];
      const maxImgCount = (model === 'sd2.5' || model === 'seedance-2.5-c1') ? 30 : 9;
      for (const img of (reference_images || []).slice(0, maxImgCount)) {
        const url = convertBase64ToPublicUrl(img, 'sd2_ref', req);
        if (url) imageUrls.push(url);
      }
      const videoRefUrls: string[] = [];
      const isNoVideoModel = model === 'sd2.5' || model === 'sd2-mini' || model === 'seedance2.0-933' || model === 'seedance2.0 933' || model.includes('noface');
      const maxVidCount = model === 'seedance-2.5-c1' ? 10 : (isNoVideoModel ? 0 : 3);
      for (const v of finalVideos.slice(0, maxVidCount)) {
        const url = convertBase64ToPublicUrl(v, 'sd2_vid', req);
        if (url) videoRefUrls.push(url);
      }
      const audioRefUrls: string[] = [];
      const maxAudCount = model === 'seedance-2.5-c1' ? 10 : (model === 'sd2.5' ? 0 : 3);
      for (const a of finalAudios.slice(0, maxAudCount)) {
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
      };

      if (model === 'seedance-2.5-c1') {
        payload.ratio = aspect_ratio;
        payload.resolution = resolution || '720p';
        if (imageUrls.length > 0) payload.image_urls = imageUrls;
        if (videoRefUrls.length > 0) payload.video_urls = videoRefUrls;
        if (audioRefUrls.length > 0) payload.audio_urls = audioRefUrls;
      } else {
        payload.aspect_ratio = aspect_ratio;
        if (imageUrls.length > 0) payload.image_refs = imageUrls;
        if (videoRefUrls.length > 0) payload.video_refs = videoRefUrls;
        if (audioRefUrls.length > 0) payload.audio_refs = audioRefUrls;
        if (compliance_enabled !== undefined) payload.compliance_enabled = Boolean(compliance_enabled);
        if (compliance_mode) payload.compliance_mode = compliance_mode;
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
        refundFailedTask(`sd2 创建任务失败: ${createResp.status}`);
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
        refundFailedTask(`创建任务失败: ${createResp.status}`);
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
      refundFailedTask('上游未返回任务 ID');
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

          // 自动本地化所有生成成功的视频（转码为 H.264 并存到本地 uploads 目录），防止上游链接失效
          let finalVideoUrl = resultUrl;
          try {
            finalVideoUrl = await downloadAndLocalizeVideo(resultUrl, videoId, model);
            console.log(`[video] 视频已本地化完成: ${finalVideoUrl}`);
          } catch (localErr: any) {
            console.error(`[video] 视频本地化失败，使用原始URL: ${localErr.message}`);
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
          refundFailedTask(errMsg);
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

    if (videoId) {
      // 已经拿到上游任务 ID → 任务可能仍在上游处理中，不退款
      // 保留 processing 状态，让服务重启时的恢复系统 (resumeAllPendingVideoTasks) 继续轮询
      console.warn(`[video] ⚠️ 任务 ${videoId} 已提交到上游但本次连接异常，不退款，等待恢复系统跟踪`);
      sendEvent({ type: 'error', message: `连接异常，任务 ${videoId} 已提交到上游，系统将自动恢复跟踪` });
    } else {
      // 未拿到上游任务 ID → 任务从未被上游接受，安全退款
      refundFailedTask(msg);
    }
    if (!res.destroyed && !res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
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
          } else {
            // 自动检索数据库中所有启用的渠道，若 URL 与渠道的 Base URL 域名匹配，自动补全授权 Token
            try {
              const activeChannels = ChannelService.getActiveChannels();
              const matchedChannel = activeChannels.find(ch => {
                if (!ch.baseUrl) return false;
                try {
                  const chHost = new URL(ch.baseUrl).hostname;
                  const urlHost = new URL(url).hostname;
                  return chHost === urlHost;
                } catch {
                  return url.includes(ch.baseUrl);
                }
              });
              if (matchedChannel?.apiKey) {
                headers['Authorization'] = `Bearer ${matchedChannel.apiKey}`;
              }
            } catch (err: any) {
              console.warn('[video/play] 动态匹配渠道 Authorization 失败:', err.message);
            }
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
          try { if (fs.existsSync(tempOriginalPath)) fs.unlinkSync(tempOriginalPath); } catch { }
          try { if (fs.existsSync(tempTranscodedPath)) fs.unlinkSync(tempTranscodedPath); } catch { }
        }
      })();

      playTranscodeLocks.set(hash, transcodePromise);
      // 在 chain 的最末尾挂载 catch，防止 finally 返回的 Rejected Promise 导致 Node 进程崩溃 (unhandledRejection)
      transcodePromise
        .finally(() => playTranscodeLocks.delete(hash))
        .catch(() => { });
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

  let model = record.modelId || '';
  if (model === 'sdas-xh-sd2.0-933-3-pro-720p') {
    model = 'sdas-pd-sd2.0-pro-933-5-720p';
  }
  const meta = MODEL_META[model];
  const channel = findVideoChannel(model);
  if (!channel) {
    console.error(`[video-recover] No channel found for model ${model} in task ${contentId}`);
    activePolls.delete(contentId);
    try {
      db.update(contents).set({ status: 'failed' }).where(eq(contents.id, contentId)).run();
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
      db.update(contents).set({ status: 'failed' }).where(eq(contents.id, contentId)).run();
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
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'veo-3-1') {
    const row = db.select().from(settings).where(eq(settings.key, 'veo_3_1_rate')).get();
    rate = parseFloat(row?.value || '0.20');
  } else if (model === 'sora-v4-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_fast_rate')).get();
    rate = parseFloat(row?.value || '0.189');
  } else if (model === 'sora-v4-pro' || model === 'seedance-2.0') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'sd2-c7') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_c7_rate')).get();
    rate = parseFloat(row?.value || '0.50');
  } else if (model === 'sd2.5') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_5_rate')).get();
    rate = parseFloat(row?.value || '3.50');
  } else if (model === 'seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_720p_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'seedance-2.0-fast-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_720p_rate')).get();
    rate = parseFloat(row?.value || '1.50');
  } else if (model === 'seedance-720') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_720_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'sdas-pd-sd2.0-pro-933-5-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_pd_sd20_pro_933_5_720p_rate')).get();
    rate = parseFloat(row?.value || '4.50');
  } else if (model === 'sdas-hn-sd2.0-fast-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_hn_sd20_fast_720p_rate')).get();
    rate = parseFloat(row?.value || '2.80');
  } else if (model === 'sdas-bl-sd2.0-933-pro-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_bl_sd20_933_pro_720p_rate')).get();
    rate = parseFloat(row?.value || '4.50');
  } else if (model === 'sdas-bl-sd2.0-933-pro-noface-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_bl_sd20_933_pro_noface_720p_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'cd-seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'cd_seedance_2_0_720p_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'nd-seedance-2.0-480p') {
    const row = db.select().from(settings).where(eq(settings.key, 'nd_seedance_2_0_480p_rate')).get();
    rate = parseFloat(row?.value || '3.15');
  } else if (model === 'nd-seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'nd_seedance_2_0_720p_rate')).get();
    rate = parseFloat(row?.value || '4.30');
  } else if (model === 'ld-sdas-cvk-pro-933-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'ld_sdas_cvk_pro_933_720p_rate')).get();
    rate = parseFloat(row?.value || '3.80');
  } else if (model === 'sdas-mj-minimax-h3-2k') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_mj_minimax_h3_2k_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'sd2-c6') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_c6_rate')).get();
    rate = parseFloat(row?.value || '2.50');
  } else if (model === 'grok-imagine-1.0-video') {
    const row = db.select().from(settings).where(eq(settings.key, 'grok_imagine_1_0_video_rate')).get();
    rate = parseFloat(row?.value || '0.288');
  } else if (model === 'grok-imagine-video-1.5-1080p') {
    const row = db.select().from(settings).where(eq(settings.key, 'grok_imagine_video_1_5_1080p_rate')).get();
    rate = parseFloat(row?.value || '0.80');
  } else if (model === 'grok-imagine-video-1.5-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'grok_imagine_video_1_5_fast_rate')).get();
    rate = parseFloat(row?.value || '0.288');
  } else if (model === 'grok-imagine-video-1.5-preview') {
    const row = db.select().from(settings).where(eq(settings.key, 'grok_imagine_video_1_5_preview_rate')).get();
    rate = parseFloat(row?.value || '0.48');
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

  const isFlatRate = [
    'sdas-hn-sd2.0-720p',
    'sdas-hn-sd2.0-fast-720p',
    'seedance-2.0-fast',
    'sd2-c7',
    'sd2.5',
    'seedance-2.0-720p',
    'seedance-2.0-fast-720p',
    'seedance-720',
    'sdas-pd-sd2.0-pro-933-5-720p',
    'ld-sdas-cvk-pro-933-720p',
    'sdas-mj-minimax-h3-2k',
    'sdas-bl-sd2.0-933-pro-720p',
    'sdas-bl-sd2.0-933-pro-noface-720p',
    'cd-seedance-2.0-720p',
    'nd-seedance-2.0-480p',
    'nd-seedance-2.0-720p',
    'sd2-c6',
    'grok-imagine-1.0-video',
    'grok-imagine-video-1.5-1080p',
    'grok-imagine-video-1.5-fast',
    'grok-imagine-video-1.5-preview',
    'tejiasd2'
  ].includes(model);

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
          } catch { }
        } else if (taskStatus === 'completed' || taskStatus === 'success') {
          console.log(`[video-recover] ✅ Generating completed: ${resultUrl}`);

          // 自动下载并缓存该恢复出的视频（本地化 + 兼容性转码为 H.264）
          let finalVideoUrl = resultUrl;
          try {
            finalVideoUrl = await downloadAndLocalizeVideo(resultUrl, videoId, model);
            console.log(`[video-recover] 视频本地化成功: ${finalVideoUrl}`);
          } catch (localErr: any) {
            console.error(`[video-recover] 视频本地化失败，使用原始URL: ${localErr.message}`);
          }

          const completedTime = Date.now();
          const createdTime = new Date(currentRecord.createdAt).getTime();
          const durationMs = (!isNaN(createdTime) && createdTime > 0 && completedTime >= createdTime)
            ? (completedTime - createdTime)
            : (Date.now() - startTime);

          logUsage(record.userId, 'generate_video', undefined, durationMs);
          const cost = Number(record.cost) || (isFlatRate ? rate : (Math.round(rate * video_length * 100) / 100));
          let meta = {};
          try {
            meta = JSON.parse(currentRecord.metadata || '{}');
          } catch { }
          meta = { ...meta, durationMs, completedAt: new Date(completedTime).toISOString() };
          db.update(contents).set({
            status: 'completed',
            resultUrl: finalVideoUrl || null,
            cost: cost,
            metadata: JSON.stringify(meta)
          }).where(eq(contents.id, contentId)).run();
          break;
        } else if (taskStatus === 'failed' || taskStatus === 'failure') {
          console.error(`[video-recover] ❌ Generating failed: ${errMsg}`);
          // 任务失败，为预扣费退款并将 cost 清零
          const refundAmount = Number(record.cost) || 0;
          if (refundAmount > 0) {
            BalanceService.refund(record.userId, refundAmount, 'generate_video_refund');
          }
          db.update(contents).set({ status: 'failed', cost: 0 }).where(eq(contents.id, contentId)).run();
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
    // 自动修正历史错误数据：包含 status = 'failed' 却残留 cost > 0 的记录，将 cost 修正为 0
    db.update(contents).set({ cost: 0 }).where(eq(contents.status, 'failed')).run();

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
