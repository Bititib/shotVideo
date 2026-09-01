import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tierMiddleware, TierRequest } from '../middleware/tier.js';
import { quotaMiddleware, logUsage } from '../middleware/quota.js';
import { ChannelService } from '../services/channelService.js';
import { BalanceService } from '../services/balanceService.js';
import { ContentService } from '../services/contentService.js';
import { PricingService } from '../services/pricingService.js';
import { hmStudioPoolKey, hmStudioQueue, type HmStudioQueueSnapshot } from '../services/hmStudioQueueService.js';
import { calculateSuccessRate, isWithinRecentDays } from '../services/successRateService.js';
import {
  buildHmStudioVideoForm,
  hmStudioCreateUrl,
  hmStudioTaskUrl,
  isHmStudioChannel,
  normalizeHmStudioTask,
} from '../services/hmStudioAdapter.js';
import {
  buildMjNewApiVideoPayload,
  findInvalidMjNewApiMaterialUrls,
  isMjNewApiChannel,
} from '../services/mjNewApiAdapter.js';
import { buildNewTokenVideoPayload } from '../services/newTokenAdapter.js';
import {
  clarifyVideoCapacityFailure,
  extractVideoFailureMessage,
  formatVideoPollHttpFailure,
  isVideoFailurePayload,
  isVideoFailureStatus,
  withVideoFailureMetadata,
} from '../services/videoFailureService.js';
import {
  buildJulunMinimaxH3Payload,
  isJulunChannel,
  isJulunMinimaxH3Model,
  JULUN_MINIMAX_H3_MODEL,
  JULUN_MINIMAX_H3_RESOLUTION,
} from '../services/julunMinimaxAdapter.js';
import {
  buildSnumomWanPayload,
  isSnumomWanChannel,
  normalizeSnumomWanTask,
  SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES,
  SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
  SNUMOM_GROK_IMAGINE_VIDEO_SECONDS,
  snumomContentUrl,
} from '../services/snumomWanAdapter.js';
import {
  buildSudaShuiVideoPayload,
  sudaShuiVideoCreateUrl,
} from '../services/sudaShuiAdapter.js';
import {
  HM_STUDIO_PRIMARY_VIDEO_MODEL,
  isHmStudioConcurrencyError,
  MJ_OVERFLOW_VIDEO_MODEL,
  SI_YUE_TIAN_PRIMARY_VIDEO_MODEL,
} from '../services/videoFailoverService.js';
import {
  findHmStudioOverflowPlan,
  hasHmStudioOverflowChannel,
} from '../services/hmStudioOverflowChannelService.js';
import {
  findSiYueTianOverflowPlan,
  isSiYueTianChannel,
  selectSiYueTianRoute,
  submitSiYueTianOverflowPlan,
} from '../services/siYueTianChannelService.js';
import {
  buildWxHaidiYueVideoPayload,
  isWxHaidiYueChannel,
  normalizeWxHaidiYueTask,
  wxHaidiYueCreateUrl,
  wxHaidiYueTaskUrl,
} from '../services/wxHaidiYueAdapter.js';
import { detectVideoCodec, downloadAndLocalizeVideo } from '../services/videoLocalizationService.js';
export { downloadAndLocalizeVideo } from '../services/videoLocalizationService.js';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { models, settings, contents } from '../db/schema.js';
import { eq, like, and, inArray, gte } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

const execPromise = promisify(exec);
const router = Router();
const VIDEO_MODELS_CACHE_TTL_MS = 15_000;
let videoModelsResponseCache: { expiresAt: number; data: any[] } | null = null;

export const activePolls = new Set<number>();
const activePollPromises = new Map<number, Promise<void>>();

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
function convertBase64ToPublicUrl(dataUrl: string, prefix: string, requestOrBaseUrl: Request | string): string {
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
    const requestBaseUrl = typeof requestOrBaseUrl === 'string'
      ? requestOrBaseUrl
      : `${requestOrBaseUrl.headers['x-forwarded-proto'] || requestOrBaseUrl.protocol}://${requestOrBaseUrl.get('host')}`;
    const baseUrl = process.env.BACKEND_URL || requestBaseUrl;
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
  'sora-v4-fast': { series: 'sora-v4', allowedSeconds: [10, 15], requireRef: false },
  'sora-v4-pro': { series: 'sora-v4', allowedSeconds: [10, 15], requireRef: false },
  'ld-sdas-cvk-pro-933-720p': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sdas-mj-minimax-h3-2k': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sdas-bl-sd2.0-933-pro-720p': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sdas-bl-sd2.0-933-pro-noface-720p': { series: 'sudashui', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'cd-seedance-2.0-720p': { series: 'seedance-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'nd-seedance-2.0-480p': { series: 'seedance-480p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'nd-seedance-2.0-720p': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'ad-seedance-2.5-480p': { series: 'seedance-2.5-480p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'vd-seedance-2.5-480p': { series: 'seedance-2.5-480p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'vd-seedance-2.5-720p': { series: 'seedance-2.5-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'seedance_v2.5': { series: 'hmstudio-seedance-2.5', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'xd-seedance-2.5-720p': { series: 'mj-seedance-2.5', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'seedance-2.0-fast': { series: 'seedance-fast', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'veo-omni-flash': { series: 'veo-omni-flash', allowedSeconds: [10], requireRef: false },
  'veo-omni-flash-video-edit': { series: 'veo-omni-flash-video-edit', allowedSeconds: [10], requireRef: false },
  'veo-3-1': { series: 'veo-3-1', allowedSeconds: [8], requireRef: false },
  'sd2-c7': { series: 'sd2-c7', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sd2.5': { series: 'sd2.5', allowedSeconds: [30], requireRef: false },
  'seedance-2.0-720p': { series: 'seedance-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance-2.0-fast-720p': { series: 'seedance-fast-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance-720': { series: 'seedance-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sd2-mini': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance2.0-933': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance2.0 933': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'grok-video-1.5（按秒）': { series: 'grok-1.5', allowedSeconds: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  [SNUMOM_GROK_IMAGINE_VIDEO_MODEL]: { series: 'snumom-grok-1.5', allowedSeconds: SNUMOM_GROK_IMAGINE_VIDEO_SECONDS, requireRef: false },
  'grok-imagine-video-1.5-preview': { series: 'grok-1.5', allowedSeconds: [10, 15], requireRef: false },
  'seedance-2.5-deal': { series: 'seedance-2.5', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance-2.5m': { series: 'seedance-2.5', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25], requireRef: false },
  'wan3.0th': { series: 'wan3.0', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'wan3.0-video': { series: 'snumom-wan3.0', allowedSeconds: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'wan3.0-video-prime': { series: 'snumom-wan3.0', allowedSeconds: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  [JULUN_MINIMAX_H3_MODEL]: { series: 'julun-minimax-h3', allowedSeconds: [10, 15], requireRef: false },
};

const DEFAULT_VIDEO_MODELS = [
  { id: 'seedance_v2.5', name: 'Seedance V2.5（HM Studio）', description: '720p；支持4-30秒；最多10张图片参考，不支持音频和视频参考', maxSeconds: 30, icon: '🎬' },
  { id: 'ad-seedance-2.5-480p', name: 'Seedance 2.5 480p（AD）', description: '支持最多30张图片、10个视频、10段音频参考，不限制人脸，按秒计费 ¥0.35/秒', maxSeconds: 30, icon: '🎬' },
  { id: 'vd-seedance-2.5-480p', name: 'Seedance 2.5 480p（VD）', description: '过真人，支持9图3视频0音频，4-30秒，按秒计费 ¥0.25/秒', maxSeconds: 30, icon: '🎬' },
  { id: 'vd-seedance-2.5-720p', name: 'Seedance 2.5 720p（VD）', description: '过真人，支持9图3视频0音频，4-30秒，按秒计费 ¥0.30/秒', maxSeconds: 30, icon: '🎬' },
  { id: 'wan3.0th', name: 'Wan 3.0 视频大模型 (wan3.0th)', description: '按秒计费，¥0.14/秒；720p；支持4-30秒文生视频和多参考视频；最多10张图片、5个视频、5段音频公网URL，音频仅支持WAV；支持1:1、16:9、9:16、4:3、3:4', maxSeconds: 30, icon: '🌟' },
  { id: 'wan3.0-video', name: 'Wan 3.0 Video（标准版）', description: 'snumom 标准版；支持 2-30 秒、480P/720P/1080P；最多 10 图、5 视频、5 音频参考；支持文生、首帧及首尾帧视频', maxSeconds: 30, icon: '🌊' },
  { id: 'wan3.0-video-prime', name: 'Wan 3.0 Video Prime（高速版）', description: 'snumom 高速版；生成速度更快；支持 2-30 秒、480P/720P/1080P；最多 10 图、5 视频、5 音频参考', maxSeconds: 30, icon: '⚡' },
  { id: SNUMOM_GROK_IMAGINE_VIDEO_MODEL, name: 'Grok Imagine Video 1.5（按次）', description: 'snumom Grok Imagine Video 1.5；支持 3-15 秒；最多 7 张参考图；按次计费 ¥0.60/次', maxSeconds: 15, icon: '✕' },
  { id: JULUN_MINIMAX_H3_MODEL, name: 'MiniMax H3 768p（933）', description: '巨轮 MiniMax H3；固定768p；仅支持10秒或15秒；最多9图、3视频、3音频参考；按秒计费 ¥0.18/秒', maxSeconds: 15, icon: '🔥' },
  { id: 'ld-sdas-cvk-pro-933-720p', name: 'SudaShui CVK Pro 933 (720p)', description: 'CVK 满血版，支持真人、4-15秒，支持 9图/3视频/3音频参考，固定按次计费 ¥3.800/次', maxSeconds: 15, icon: '🚀' },
  { id: 'sdas-mj-minimax-h3-2k', name: 'Minimax H3 (2K)', description: '海螺h3，9图3视频3音频，4-15s，固定按次计费 ¥3.00/次', maxSeconds: 15, icon: '🔥' },
  { id: 'sdas-bl-sd2.0-933-pro-720p', name: 'Seedance 2.0 Pro (933人脸版)', description: '9图3视频3音频，支持 4-15s，支持真人，固定按次计费 ¥4.50/次', maxSeconds: 15, icon: '🚀' },
  { id: 'sdas-bl-sd2.0-933-pro-noface-720p', name: 'Seedance 2.0 Pro (933无脸版)', description: '9图3视频3音频，支持 4-15s，固定按次计费 ¥4.00/次', maxSeconds: 15, icon: '🚀' },
  { id: 'cd-seedance-2.0-720p', name: 'Seedance 2.0 (720p/CD版)', description: '支持最多9张图片、3个视频、3个音频参考，5-15秒，固定按次计费 ¥3.00/次', maxSeconds: 15, icon: '🚀' },
  { id: 'nd-seedance-2.0-480p', name: 'Seedance 2.0 (480p/不卡脸)', description: '9图3视频3音频，支持 4-15s，不卡人脸，固定按次计费 ¥3.75/次', maxSeconds: 15, icon: '⚡' },
  { id: 'nd-seedance-2.0-720p', name: 'Seedance 2.0 (720p/不卡脸)', description: '9图3视频3音频，支持 4-15s，不卡人脸，固定按次计费 ¥4.30/次', maxSeconds: 15, icon: '🚀' },
  { id: 'veo-omni-flash', name: 'Veo Omni Flash', description: '多参考图生成视频，参考图字段 Ingredients_images，固定10s', maxSeconds: 10, icon: '🚀' },
  { id: 'veo-omni-flash-video-edit', name: 'Veo Omni Flash 视频编辑', description: '【不卡人脸-定制版】无水印视频编辑；必须提供1个参考视频，可附加多张参考图；固定10秒，参考视频最长15秒', maxSeconds: 10, icon: '✂️' },
  { id: 'veo-3-1', name: 'Veo 3-1', description: '【不卡人脸-定制版】无水印视频；只支持8秒；支持首尾帧、支持多图参考，最多9张图', maxSeconds: 8, icon: '🚀' },
  { id: 'sd2-c7', name: 'Seedance 2.0 c7', description: 'OpenAI 兼容，支持720p固定分辨率，支持最多10张图片参考（无视频/音频参考），5-15秒，固定按次计费', maxSeconds: 15, icon: '🚀' },
  { id: 'sd2.5', name: 'Seedance 2.5 (sd2.5)', description: '支持9图0视频0音频，卡人脸；适合制作带货视频，固定按次计费 ¥3.50/次', maxSeconds: 30, icon: '🚀' },
  { id: 'seedance-2.0-720p', name: 'Seedance 2.0 720p', description: 'Seedance 2.0 标准版，支持720p固定分辨率，支持最多9张图片、3个视频、3个音频参考，5-15秒', maxSeconds: 15, icon: '🚀' },
  { id: 'seedance-2.0-fast-720p', name: 'Seedance 2.0 Fast 720p', description: 'Seedance 2.0 极速版，支持720p固定分辨率，支持最多9张图片、3个视频、3个音频参考，5-15秒', maxSeconds: 15, icon: '⚡' },
  { id: 'seedance-720', name: 'Seedance 720 满血版', description: '满血模型，支持933，过人脸，720p固定分辨率，支持最多9张图片、3个视频、3个音频参考，5-15秒', maxSeconds: 15, icon: '🔥' },
  { id: 'sd2-mini', name: 'Seedance Mini (sd2-mini)', description: 'Seedance Mini 720p (933)，支持9图、3音频参考（无视频参考），固定按次计费 ¥2.00/次', maxSeconds: 15, icon: '⚡' },
  { id: 'seedance2.0-933', name: 'seedance2.0 933', description: 'seedance2.0 933 模型，支持9图、3音频参考（无视频参考），固定按次计费 ¥3.00/次', maxSeconds: 15, icon: '🚀' },
  { id: 'seedance2.0 933', name: 'seedance2.0 933', description: 'seedance2.0 933 模型，支持9图、3音频参考（无视频参考），固定按次计费 ¥3.00/次', maxSeconds: 15, icon: '🚀' },
];

/** 查找支持指定视频模型的渠道 */
function findVideoChannel(modelId: string, activeChannels?: any[]) {
  const channel = ChannelService.findChannelForModel(modelId, activeChannels);
  if (channel) return {
    id: channel.id,
    type: channel.type,
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    apiKeyId: channel.apiKeyId,
    modelMapping: channel.modelMapping,
    timeout: channel.timeout,
  };
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
    try { if (fs.existsSync(tempDownload)) fs.unlinkSync(tempDownload); } catch { }
    try { if (fs.existsSync(tempTranscoded)) fs.unlinkSync(tempTranscoded); } catch { }
  }
}
/** GET /api/video/models — 可用的视频模型列表（公开，不需要登录） */
router.get('/models', (_req: Request, res: Response) => {
  if (env.NODE_ENV === 'production' && videoModelsResponseCache?.expiresAt > Date.now()) {
    res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    return res.json(videoModelsResponseCache.data);
  }

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
  const publicSourceModels = sourceModels.filter(m => m.id !== MJ_OVERFLOW_VIDEO_MODEL);

  // Read settings, pricing, channels, and recent statistics once per request.
  // Previously these tables were queried again for every model, making this
  // small public response the slowest request on the page.
  const settingValues = new Map(
    db.select({ key: settings.key, value: settings.value }).from(settings).all()
      .map(row => [row.key, row.value]),
  );
  const settingNumber = (key: string, fallback: string) => parseFloat(settingValues.get(key) || fallback);
  const base480 = settingNumber('video_rate_480p', '0.03');
  const base720 = settingNumber('video_rate_720p', '0.05');

  const soraV4FastRate = settingNumber('sora_v4_fast_rate', '0.189');
  const soraV4ProRate = settingNumber('sora_v4_pro_rate', '0.25');
  const veoOmniFlashRate = settingNumber('veo_omni_flash_rate', '0.25');
  const quotePrice = PricingService.createQuoteResolver(false);
  const activeVideoChannels = ChannelService.getActiveChannels();
  const hmStudioOverflowAvailable = hasHmStudioOverflowChannel(activeVideoChannels);

  const statsTargetIds = (modelId: string) => Array.from(new Set([
    modelId,
    ...(modelId.includes('seedance2.0') || modelId === 'sd2-mini'
      ? ['seedance2.0-933', 'seedance2.0 933', 'sd2-mini']
      : []),
  ]));
  const allStatsModelIds = Array.from(new Set(publicSourceModels.flatMap(model => statsTargetIds(model.id))));
  const recentCutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recentTerminalRows = allStatsModelIds.length === 0
    ? []
    : db.select({
        modelId: contents.modelId,
        status: contents.status,
        resultUrl: contents.resultUrl,
        createdAt: contents.createdAt,
      }).from(contents).where(and(
        inArray(contents.modelId, allStatsModelIds),
        gte(contents.createdAt, recentCutoffDate),
      )).all().filter(row =>
        isWithinRecentDays(row.createdAt)
        && (row.status === 'failed'
          || row.status === 'completed'
          || row.status === 'success'
          || Boolean(row.resultUrl?.trim())),
      );
  const recentRowsByModel = new Map<string, typeof recentTerminalRows>();
  for (const row of recentTerminalRows) {
    if (!row.modelId) continue;
    const rows = recentRowsByModel.get(row.modelId) || [];
    rows.push(row);
    recentRowsByModel.set(row.modelId, rows);
  }

  const result = publicSourceModels.map(m => {
    const preset = DEFAULT_VIDEO_MODELS.find(d => d.id === m.id);
    const meta = MODEL_META[m.id];
    const multiplier = meta?.series === '1.5' ? 1.2 : 1.0;

    let rates: Record<string, number>;
    if (m.id === 'sora-v4-fast') {
      rates = {
        '720p': soraV4FastRate,
      };
    } else if (m.id === 'sora-v4-pro') {
      rates = {
        '720p': soraV4ProRate,
      };
    } else if (m.id === 'veo-omni-flash') {
      rates = {
        '720p': veoOmniFlashRate,
        '1080p': veoOmniFlashRate,
      };
    } else if (m.id === 'veo-omni-flash-video-edit') {
      rates = {
        '720p': 0.09,
        '1080p': 0.09,
      };
    } else if (m.id === 'veo-3-1') {
      const rate = settingNumber('veo_3_1_rate', '0.20');
      rates = {
        '720p': rate,
        '1080p': rate,
      };
    } else if (m.id === 'sd2-c7') {
      const rate = settingNumber('sd2_c7_rate', '0.50');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sd2.5') {
      const rate = settingNumber('sd2_5_rate', '3.50');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sd2-mini') {
      const rate = settingNumber('sd2_mini_rate', '2.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'seedance2.0-933' || m.id === 'seedance2.0 933') {
      const rate = settingNumber('seedance2_0_933_rate', '3.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'seedance-2.0-720p') {
      const rate = settingNumber('seedance_2_0_720p_rate', '3.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'seedance-2.0-fast-720p') {
      const rate = settingNumber('seedance_2_0_fast_720p_rate', '1.50');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'seedance-720') {
      const rate = settingNumber('seedance_720_rate', '3.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sdas-bl-sd2.0-933-pro-720p') {
      const rate = settingNumber('sdas_bl_sd20_933_pro_720p_rate', '4.50');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sdas-bl-sd2.0-933-pro-noface-720p') {
      const rate = settingNumber('sdas_bl_sd20_933_pro_noface_720p_rate', '4.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'cd-seedance-2.0-720p') {
      const rate = settingNumber('cd_seedance_2_0_720p_rate', '3.00');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'nd-seedance-2.0-480p') {
      const rate = settingNumber('nd_seedance_2_0_480p_rate', '3.75');
      rates = {
        '480p': rate,
      };
    } else if (m.id === 'nd-seedance-2.0-720p') {
      const rate = settingNumber('nd_seedance_2_0_720p_rate', '4.30');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'seedance_v2.5') {
      rates = {
        '720p': quotePrice(m.id, { resolution: '720p' }).rate,
      };
    } else if (m.id === 'xd-seedance-2.5-720p') {
      rates = {
        '720p': quotePrice(m.id, { resolution: '720p' }).rate,
      };
    } else if (m.id === 'ad-seedance-2.5-480p') {
      rates = {
        '480p': 0.35,
      };
    } else if (m.id === 'vd-seedance-2.5-480p' || m.id === 'vd-seedance-2.5-720p') {
      const modelResolution = m.id.endsWith('480p') ? '480p' : '720p';
      rates = {
        [modelResolution]: quotePrice(m.id, { resolution: modelResolution }).rate,
      };
    } else if (m.id === 'ld-sdas-cvk-pro-933-720p') {
      const rate = settingNumber('ld_sdas_cvk_pro_933_720p_rate', '3.80');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'sdas-mj-minimax-h3-2k') {
      const rate = settingNumber('sdas_mj_minimax_h3_2k_rate', '3.00');
      rates = {
        '2k': rate,
      };
    } else if (m.id === JULUN_MINIMAX_H3_MODEL) {
      rates = {
        [JULUN_MINIMAX_H3_RESOLUTION]: quotePrice(m.id, { resolution: JULUN_MINIMAX_H3_RESOLUTION, seconds: 1 }).rate,
      };
    } else if (m.id === 'wan3.0th') {
      const rate = settingNumber('wan3_0th_rate', '0.14');
      rates = {
        '720p': rate,
      };
    } else if (m.id === 'wan3.0-video') {
      rates = Object.fromEntries(['480p', '720p', '1080p'].map(resolution => [
        resolution,
        quotePrice(m.id, { resolution, seconds: 1 }).rate,
      ]));
    } else if (m.id === 'wan3.0-video-prime') {
      rates = Object.fromEntries(['480p', '720p', '1080p'].map(resolution => [
        resolution,
        quotePrice(m.id, { resolution, seconds: 1 }).rate,
      ]));
    } else if (m.id === 'sd2-c6') {
      const rate = settingNumber('sd2_c6_rate', '2.50');
      rates = {
        '720p': rate,
      };
    } else {
      rates = {
        '480p': Math.round(base480 * multiplier * 100) / 100,
        '720p': Math.round(base720 * multiplier * 100) / 100,
      };
    }

    // The pricing table is authoritative; legacy setting reads above are retained
    // only so old databases can be migrated without losing their former values.
    const billingType = quotePrice(m.id).billingType;
    const configuredResolutions = Object.keys(rates).length > 0 ? Object.keys(rates) : ['720p'];
    rates = Object.fromEntries(configuredResolutions.map(resolution => [
      resolution,
      quotePrice(m.id, { resolution }).rate,
    ]));

    const targetIds = statsTargetIds(m.id);
    const modelRecentRows = targetIds.flatMap(targetId => recentRowsByModel.get(targetId) || []);
    const successCalls = modelRecentRows.filter(r => r.status === 'completed' || r.status === 'success' || Boolean(r.resultUrl?.trim())).length;
    const failureCalls = modelRecentRows.filter(r => r.status === 'failed').length;
    const successStats = calculateSuccessRate(successCalls, failureCalls);

    return {
      id: m.id,
      name: m.name || preset?.name || m.id,
      description: m.description || preset?.description || 'AI 视频生成服务',
      available: findVideoChannel(m.id, activeVideoChannels) !== null
        || (m.id === HM_STUDIO_PRIMARY_VIDEO_MODEL && hmStudioOverflowAvailable),
      maxSeconds: preset?.maxSeconds,
      allowedSeconds: meta?.allowedSeconds || null,
      requireRef: meta?.requireRef || false,
      series: meta?.series || 'legacy',
      rates,
      billingType,
      successRate: successStats.rate,
      successRateEstimated: successStats.estimated,
      totalCalls: successStats.sampleSize,
    };
  });

  const availableModels = result.filter(m => m.available);
  if (env.NODE_ENV === 'production') {
    videoModelsResponseCache = {
      expiresAt: Date.now() + VIDEO_MODELS_CACHE_TTL_MS,
      data: availableModels,
    };
    res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
  }
  res.json(availableModels);
});

/** POST /api/video/generate — SSE 流式视频生成（异步轮询模式） */
router.post('/generate', authMiddleware, tierMiddleware('video'), quotaMiddleware, async (req: TierRequest, res: Response) => {
  const {
    prompt,
    model = 'nd-seedance-2.0-720p',
    aspect_ratio = '16:9',
    video_length = 6,
    resolution: requestedResolution,
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
  const resolution = requestedResolution || (isJulunMinimaxH3Model(model) ? JULUN_MINIMAX_H3_RESOLUTION : '720p');

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

  if (model === MJ_OVERFLOW_VIDEO_MODEL) {
    return res.status(404).json({ error: '该模型不可直接调用' });
  }

  const meta = MODEL_META[model];

  if (model === 'wan3.0th') {
    const wanRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
    if (!wanRatios.includes(aspect_ratio)) return res.status(400).json({ error: 'WAN3.0 仅支持 1:1、16:9、9:16、4:3、3:4' });
    if (resolution !== '720p') return res.status(400).json({ error: 'WAN3.0 仅支持 720p' });
    if (reference_images.length > 10) return res.status(400).json({ error: 'WAN3.0 最多支持 10 张参考图片' });
    if (finalVideos.length > 5) return res.status(400).json({ error: 'WAN3.0 最多支持 5 个参考视频' });
    if (finalAudios.length > 5) return res.status(400).json({ error: 'WAN3.0 最多支持 5 段参考音频' });
    const invalidAudio = finalAudios.some(audio => !audio.startsWith('data:audio/wav') && !audio.startsWith('data:audio/x-wav') && !audio.toLowerCase().split('?')[0].endsWith('.wav'));
    if (invalidAudio) return res.status(400).json({ error: 'WAN3.0 的参考音频仅支持 WAV' });
  }

  if (model === 'ad-seedance-2.5-480p') {
    if (resolution !== '480p') return res.status(400).json({ error: 'ad-seedance-2.5-480p 仅支持 480p' });
    if (reference_images.length > 30) return res.status(400).json({ error: 'ad-seedance-2.5-480p 最多支持 30 张参考图片' });
    if (finalVideos.length > 10) return res.status(400).json({ error: 'ad-seedance-2.5-480p 最多支持 10 个参考视频' });
    if (finalAudios.length > 10) return res.status(400).json({ error: 'ad-seedance-2.5-480p 最多支持 10 段参考音频' });
  }

  if (model === 'vd-seedance-2.5-480p' || model === 'vd-seedance-2.5-720p') {
    const requiredResolution = model.endsWith('480p') ? '480p' : '720p';
    if (resolution !== requiredResolution) return res.status(400).json({ error: `${model} 仅支持 ${requiredResolution}` });
    if (reference_images.length > 9) return res.status(400).json({ error: `${model} 最多支持 9 张参考图片` });
    if (finalVideos.length > 3) return res.status(400).json({ error: `${model} 最多支持 3 个参考视频` });
    if (finalAudios.length > 0) return res.status(400).json({ error: `${model} 不支持参考音频` });
  }

  if (model === 'seedance_v2.5') {
    if (resolution !== '720p') return res.status(400).json({ error: 'seedance_v2.5 仅支持 720p' });
    if (reference_images.length > 10) return res.status(400).json({ error: 'seedance_v2.5 最多支持 10 张参考图片' });
    if (finalVideos.length > 0 || finalAudios.length > 0) return res.status(400).json({ error: 'seedance_v2.5 不支持视频或音频参考' });
  }

  if (model === SI_YUE_TIAN_PRIMARY_VIDEO_MODEL) {
    if (Number(video_length) !== 30) return res.status(400).json({ error: 'sd2.5 固定支持 30 秒' });
    if (resolution !== '720p') return res.status(400).json({ error: 'sd2.5 仅支持 720p' });
    if (reference_images.length > 9) return res.status(400).json({ error: 'sd2.5 最多支持 9 张参考图片' });
    if (finalVideos.length > 0 || finalAudios.length > 0) {
      return res.status(400).json({ error: 'sd2.5 不支持视频或音频参考' });
    }
  }

  if (isJulunMinimaxH3Model(model)) {
    if (![10, 15].includes(Number(video_length))) {
      return res.status(400).json({ error: `${JULUN_MINIMAX_H3_MODEL} 仅支持 10 秒或 15 秒` });
    }
    if (resolution !== JULUN_MINIMAX_H3_RESOLUTION) {
      return res.status(400).json({ error: `${JULUN_MINIMAX_H3_MODEL} 仅支持 ${JULUN_MINIMAX_H3_RESOLUTION}` });
    }
    if (reference_images.length > 9 || finalVideos.length > 3 || finalAudios.length > 3) {
      return res.status(400).json({ error: `${JULUN_MINIMAX_H3_MODEL} 最多支持 9 张图片、3 个视频和 3 段音频参考` });
    }
  }

  if (model === 'wan3.0-video' || model === 'wan3.0-video-prime') {
    const wanRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
    if (!wanRatios.includes(aspect_ratio)) return res.status(400).json({ error: `${model} 不支持比例 ${aspect_ratio}` });
    if (!['480p', '720p', '1080p'].includes(String(resolution).toLowerCase())) {
      return res.status(400).json({ error: `${model} 仅支持 480p、720p、1080p` });
    }
    if (reference_images.length > 10) return res.status(400).json({ error: `${model} 最多支持 10 张参考图片` });
    if (finalVideos.length > 5) return res.status(400).json({ error: `${model} 最多支持 5 个参考视频` });
    if (finalAudios.length > 5) return res.status(400).json({ error: `${model} 最多支持 5 段参考音频` });
  }

  if (model === SNUMOM_GROK_IMAGINE_VIDEO_MODEL && reference_images.length > SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES) {
    return res.status(400).json({ error: `${model} 最多支持 ${SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES} 张参考图片` });
  }

  if (model === 'xd-seedance-2.5-720p') {
    if (resolution !== '720p') return res.status(400).json({ error: 'xd-seedance-2.5-720p 仅支持 720p' });
    if (reference_images.length > 9) return res.status(400).json({ error: 'xd-seedance-2.5-720p 最多支持 9 张参考图片' });
    if (finalVideos.length > 0 || finalAudios.length > 0) return res.status(400).json({ error: 'xd-seedance-2.5-720p 不支持视频或音频参考' });
  }

  if (model === 'veo-omni-flash-video-edit') {
    if (!['16:9', '9:16'].includes(aspect_ratio)) return res.status(400).json({ error: 'Veo Omni Flash 视频编辑仅支持 16:9 或 9:16' });
    if (finalVideos.length !== 1) return res.status(400).json({ error: 'Veo Omni Flash 视频编辑必须提供且只能提供 1 个参考视频' });
    if (finalAudios.length > 0) return res.status(400).json({ error: 'Veo Omni Flash 视频编辑不支持参考音频' });
  }

  // 模型时长限制校验
  if (meta?.allowedSeconds && !meta.allowedSeconds.includes(Number(video_length))) {
    return res.status(400).json({ error: `模型 ${model} 只支持 ${meta.allowedSeconds.join('/')} 秒` });
  }

  // 强制参考图校验
  const hasRef = Array.isArray(reference_images) && reference_images.length > 0;
  if (meta?.requireRef && !hasRef) {
    return res.status(400).json({ error: `模型 ${model} 必须提供参考图` });
  }

  const overflowInput = {
    requestedModel: model,
    resolution,
    seconds: Number(video_length),
    imageCount: reference_images.length,
    videoCount: finalVideos.length,
    audioCount: finalAudios.length,
  };
  const siYueTianSelection = model === SI_YUE_TIAN_PRIMARY_VIDEO_MODEL
    ? selectSiYueTianRoute(overflowInput)
    : null;
  let channel = model === SI_YUE_TIAN_PRIMARY_VIDEO_MODEL
    ? siYueTianSelection?.channel || null
    : findVideoChannel(model);
  let executionModel = siYueTianSelection?.executionModel || model;
  let failoverReason = siYueTianSelection?.reason || '';
  let failoverFrom = siYueTianSelection?.kind === 'julun' ? 'siyuetian' : '';
  if (!channel && model === HM_STUDIO_PRIMARY_VIDEO_MODEL) {
    const overflowPlan = findHmStudioOverflowPlan(overflowInput);
    if (overflowPlan) {
      channel = overflowPlan.channel;
      executionModel = overflowPlan.executionModel;
      failoverFrom = 'hmstudio';
      failoverReason = 'hmstudio_disabled';
    }
  }
  if (!channel) {
    return res.status(503).json({ error: '未配置可用的视频生成渠道，或当前请求不符合备用线路的素材限制。' });
  }
  if (isHmStudioChannel(channel)) {
    const poolLoad = hmStudioQueue.getPoolLoad(hmStudioPoolKey(channel));
    const overflowPlan = poolLoad.limit > 0 && poolLoad.load >= poolLoad.limit
      ? findHmStudioOverflowPlan(overflowInput)
      : null;
    if (overflowPlan) {
      channel = overflowPlan.channel;
      executionModel = overflowPlan.executionModel;
      failoverFrom = 'hmstudio';
      failoverReason = 'hmstudio_capacity';
    }
  }

  // Get the mapped model name from the database channel configuration
  let dbChannel = channel;
  let upstreamModel = executionModel;
  if (dbChannel?.modelMapping) {
    try {
      const mapping = typeof dbChannel.modelMapping === 'string' ? JSON.parse(dbChannel.modelMapping) : dbChannel.modelMapping;
      upstreamModel = mapping[executionModel] || executionModel;
    } catch { /* skip */ }
  }

  if (isSnumomWanChannel(dbChannel) && (first_frame || last_frame)) {
    if (reference_images.length > 0 || finalVideos.length > 0) {
      return res.status(400).json({ error: 'snumom 首帧/尾帧不能与普通参考图或参考视频混用' });
    }
    if (last_frame && !first_frame) {
      return res.status(400).json({ error: '使用尾帧时必须同时提供首帧' });
    }
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

  if (failoverReason) {
    sendEvent({
      type: 'status',
      message: '主线路当前已满载，已自动切换至备用线路生成',
    });
  }

  const startTime = Date.now();

  // 视频计费费率——按模型系列分级
  let rate = 0.05;
  if (model === 'sdas-bl-sd2.0-933-pro-720p') {
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
    rate = parseFloat(row?.value || '3.75');
  } else if (model === 'nd-seedance-2.0-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'nd_seedance_2_0_720p_rate')).get();
    rate = parseFloat(row?.value || '4.30');
  } else if (model === 'ld-sdas-cvk-pro-933-720p') {
    const row = db.select().from(settings).where(eq(settings.key, 'ld_sdas_cvk_pro_933_720p_rate')).get();
    rate = parseFloat(row?.value || '3.80');
  } else if (model === 'sdas-mj-minimax-h3-2k') {
    const row = db.select().from(settings).where(eq(settings.key, 'sdas_mj_minimax_h3_2k_rate')).get();
    rate = parseFloat(row?.value || '3.00');
  } else if (model === 'seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'veo-omni-flash') {
    const row = db.select().from(settings).where(eq(settings.key, 'veo_omni_flash_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'veo-omni-flash-video-edit') {
    rate = 0.09;
  } else if (model === 'veo-3-1') {
    const row = db.select().from(settings).where(eq(settings.key, 'veo_3_1_rate')).get();
    rate = parseFloat(row?.value || '0.20');
  } else if (model === JULUN_MINIMAX_H3_MODEL) {
    rate = 0.18;
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
    'ld-sdas-cvk-pro-933-720p',
    'sdas-mj-minimax-h3-2k',
    'sdas-bl-sd2.0-933-pro-720p',
    'sdas-bl-sd2.0-933-pro-noface-720p',
    'cd-seedance-2.0-720p',
    'nd-seedance-2.0-480p',
    'nd-seedance-2.0-720p',
    'ad-seedance-2.5-480p',
    'xd-seedance-2.5-720p'
  ].includes(model);
  const estimatedSeconds = Number(video_length) || 6;
  const unifiedQuote = PricingService.quote(model, { resolution, seconds: estimatedSeconds, count: 1 }, false);
  if (!unifiedQuote.billingType) {
    sendEvent({ type: 'error', message: `模型 ${model} 尚未在计费设置中配置价格` });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  const estimatedRate = unifiedQuote.rate;
  const estimatedCost = unifiedQuote.cost;

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
    sendEvent({ type: 'billing', cost: estimatedCost, resolution, seconds: estimatedSeconds, rate: estimatedRate, billingType: unifiedQuote.billingType, remainingBalance: predeductedBalance });
  }

  // 插入初始的 'processing' 内容记录，确保刷新页面时正在生成中的记录不会丢失
  let contentId: number | null = null;
  try {
    contentId = ContentService.save({
      userId: req.userId!,
      orgId: req.orgId || null,
      type: 'video',
      title: (prompt as string).slice(0, 200),
      inputText: (prompt as string).slice(0, 5000),
      modelId: model,
      cost: estimatedCost,
      status: 'processing',
      metadata: {
        resolution,
        seconds: estimatedSeconds,
        aspect_ratio,
        model,
        prompt: (prompt as string).slice(0, 5000),
        channelId: dbChannel?.id ?? null,
        channelApiKeyId: dbChannel?.apiKeyId ?? null,
        upstreamModel,
        requestedModel: model,
        actualModel: executionModel,
        actualChannel: failoverFrom === 'siyuetian' ? 'julun'
          : isMjNewApiChannel(dbChannel) ? 'mjnewapi' : dbChannel?.type,
        fallbackFrom: failoverReason ? failoverFrom : undefined,
        fallbackReason: failoverReason || undefined,
        fallbackAt: failoverReason ? new Date().toISOString() : undefined,
        reference_images,
        reference_videos: finalVideos,
        audio_urls: finalAudios,
        first_frame,
        last_frame,
        billingSource: 'user',
        queueUserKey: `user:${req.userId}`,
        queueEnqueuedAt: new Date().toISOString(),
        publicBaseUrl: process.env.BACKEND_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`
      }
    });
    if (contentId !== null) {
      sendEvent({ type: 'content_id', contentId });
    }
  } catch (e) {
    console.error('[content] 初始视频记录保存失败:', e);
  }

  /** 生成成功后更新内容（已在前置预扣费，无需重复扣费） */
  const billUsage = (finalVideoUrl: string, upstreamResultUrl?: string) => {
    const elapsed = Date.now() - startTime;
    logUsage(req.userId!, 'generate_video', undefined, elapsed);
    if (contentId !== null) {
      try {
        const current = db.select().from(contents).where(eq(contents.id, contentId)).get();
        let completedMetadata: Record<string, any> = {};
        try { completedMetadata = JSON.parse(current?.metadata || '{}'); } catch { }
        completedMetadata.progress = 100;
        completedMetadata.queueStatus = 'completed';
        completedMetadata.queuePosition = 0;
        completedMetadata.completedAt = new Date().toISOString();
        if (upstreamResultUrl) completedMetadata.upstreamResultUrl = upstreamResultUrl;
        delete completedMetadata.progressText;
        db.update(contents).set({
          status: 'completed',
          resultUrl: finalVideoUrl || null,
          cost: estimatedCost,
          metadata: JSON.stringify(completedMetadata),
        }).where(eq(contents.id, contentId)).run();
      } catch (e) { console.error('[content] 视频记录更新失败:', e); }
    }
  };

  /** 任务失败时自动退款 */
  let failureHandled = false;
  const refundFailedTask = (errMsg: string) => {
    if (failureHandled) return;
    failureHandled = true;
    const readableError = clarifyVideoCapacityFailure(
      extractVideoFailureMessage(errMsg) || '视频生成失败',
      isHmStudioChannel(channel),
    );
    console.error(`[video] ❌ 生成失败: ${readableError}`);
    sendEvent({ type: 'error', message: readableError });
    if (estimatedCost > 0) {
      BalanceService.refund(req.userId!, estimatedCost, 'generate_video_refund');
    }
    if (contentId !== null) {
      activePolls.delete(contentId);
      try {
        const current = db.select().from(contents).where(eq(contents.id, contentId)).get();
        const failedMetadata = withVideoFailureMetadata(current?.metadata, readableError);
        failedMetadata.billingStatus = estimatedCost > 0 ? 'refunded' : 'not_charged';
        failedMetadata.queueRefunded = estimatedCost > 0;
        failedMetadata.refundAmount = estimatedCost;
        failedMetadata.refundTarget = estimatedCost > 0 ? 'user_balance' : 'not_charged';
        if (estimatedCost > 0) failedMetadata.refundedAt = new Date().toISOString();
        db.update(contents).set({
          status: 'failed',
          cost: 0,
          metadata: JSON.stringify(failedMetadata),
        }).where(eq(contents.id, contentId)).run();
      } catch (dbErr) { console.error('[video] 失败状态更新错误:', dbErr); }
    }
  };

  let baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const size = RATIO_TO_SIZE[aspect_ratio] || '1280x720';
  const isSeedanceFast = model === 'seedance-2.0-fast';
  const isSoraV4 = model === 'sora-v4-fast' || model === 'sora-v4-pro' || model === 'seedance-2.0';
  const isSudaShui = meta?.series === 'sudashui';
  let isHmStudio = isHmStudioChannel(channel);
  let isWxHaidiYue = isWxHaidiYueChannel(channel);
  let isJulunSd25 = model === SI_YUE_TIAN_PRIMARY_VIDEO_MODEL && isJulunChannel(channel);
  const isSnumomWan = isSnumomWanChannel(channel);
  let isMjNewApi = isMjNewApiChannel(channel);
  const isVeoOmni = model === 'veo-omni-flash';
  const isVeoOmniEdit = model === 'veo-omni-flash-video-edit';
  const isVeo31 = model === 'veo-3-1';
  const isWan30 = model === 'wan3.0th' || model === 'wan3.0-video' || model === 'wan3.0-video-prime';
  const isSeedanceJsonModel = [
    'sd2-c7',
    'sd2.5',
    'seedance-2.0-720p',
    'seedance-2.0-fast-720p',
    'seedance-720',
    'cd-seedance-2.0-720p',
    'nd-seedance-2.0-480p',
    'nd-seedance-2.0-720p',
    'vd-seedance-2.5-480p',
    'vd-seedance-2.5-720p',
    'xd-seedance-2.5-720p'
  ].includes(model);

  if (isHmStudio && contentId !== null) {
    try {
      db.update(contents).set({ status: 'queued' }).where(eq(contents.id, contentId)).run();
      const snapshot = enqueueHmStudioVideoContent(contentId);
      sendEvent({ type: 'queue', ...snapshot });

      let lastQueuePosition = -1;
      let lastProgress = -1;
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const queuedRecord = db.select().from(contents).where(eq(contents.id, contentId)).get();
        if (!queuedRecord) return res.end();
        let queuedMeta: Record<string, any> = {};
        try { queuedMeta = JSON.parse(queuedRecord.metadata || '{}'); } catch { }

        if (queuedRecord.status === 'queued') {
          const position = Number(queuedMeta.queuePosition || 1);
          if (position !== lastQueuePosition) {
            lastQueuePosition = position;
            sendEvent({
              type: 'queue',
              status: 'queued',
              position,
              running: Number(queuedMeta.queueRunning || 0),
              concurrencyLimit: Number(queuedMeta.queueLimit || 10),
              queued: Number(queuedMeta.queueTotal || 0),
              message: `HM Studio 排队中：前方 ${Math.max(0, position - 1)} 项，当前运行 ${queuedMeta.queueRunning || 0}/${queuedMeta.queueLimit || 10}`,
            });
          }
        } else if (queuedRecord.status === 'processing') {
          const progress = Number(queuedMeta.progress || 0);
          if (progress !== lastProgress) {
            lastProgress = progress;
            sendEvent({ type: 'progress', progress });
            sendEvent({ type: 'status', message: queuedMeta.progressText || (queuedMeta.videoId ? `视频生成中 ${progress}%` : '正在提交 HM Studio 任务') });
          }
        } else if (queuedRecord.status === 'completed') {
          sendEvent({ type: 'complete', videoUrl: queuedRecord.resultUrl || '' });
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        } else if (queuedRecord.status === 'failed') {
          sendEvent({ type: 'error', message: queuedMeta.error || 'HM Studio 视频生成失败' });
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }

        if (res.destroyed || res.writableEnded) return;
      }
    } catch (error: any) {
      refundFailedTask(error.message || '视频任务排队失败');
      if (!res.destroyed && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
      return;
    }
  }

  try {
    let videoId = '';

    if (failoverReason && (isWxHaidiYue || isMjNewApi)) {
      const attemptedFallbackIds = new Set<number>();
      let overflowPlan: NonNullable<ReturnType<typeof findHmStudioOverflowPlan>> | null = {
        channel,
        executionModel,
        kind: isWxHaidiYue ? 'wx-haidiyue' : 'mjnewapi',
      };

      while (overflowPlan) {
        attemptedFallbackIds.add(overflowPlan.channel.id);
        let fallbackMapping: Record<string, string> = {};
        try {
          fallbackMapping = typeof overflowPlan.channel.modelMapping === 'string'
            ? JSON.parse(overflowPlan.channel.modelMapping || '{}')
            : (overflowPlan.channel.modelMapping || {});
        } catch { /* use selected overflow model */ }
        const selectedUpstreamModel = fallbackMapping[overflowPlan.executionModel] || overflowPlan.executionModel;
        let createResp: Awaited<ReturnType<typeof fetch>>;

        if (overflowPlan.kind === 'wx-haidiyue') {
          sendEvent({ type: 'status', message: '正在通过 wx-海底月备用线路提交视频任务...' });
          const payload = buildWxHaidiYueVideoPayload({
            prompt: prompt.trim(),
            duration: Number(video_length) || 6,
            aspectRatio: aspect_ratio,
            images: reference_images,
          });
          createResp = await fetch(wxHaidiYueCreateUrl(overflowPlan.channel.baseUrl), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${overflowPlan.channel.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(overflowPlan.channel.timeout || 120_000),
          });
        } else {
          sendEvent({ type: 'status', message: '正在通过 MJNewAPI 备用线路提交视频任务...' });
          const imageUrls = (reference_images || [])
            .map((item: string) => convertBase64ToPublicUrl(item, 'mj_img', req))
            .filter(Boolean);
          if (findInvalidMjNewApiMaterialUrls(imageUrls).length > 0) {
            refundFailedTask('参考素材必须是外网可访问的 HTTPS URL，请检查 BACKEND_URL 配置');
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          const payload = buildMjNewApiVideoPayload({
            model: selectedUpstreamModel,
            prompt,
            duration: Number(video_length) || 6,
            aspectRatio: aspect_ratio,
            resolution,
            images: imageUrls,
            videos: [],
            audios: [],
          });
          createResp = await fetch(`${overflowPlan.channel.baseUrl.replace(/\/+$/, '')}/v1/videos`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${overflowPlan.channel.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(overflowPlan.channel.timeout || 120_000),
          });
        }

        if (createResp.ok) {
          const job = await createResp.json() as any;
          videoId = job.request_id || job.id || job.task_id;
          channel = overflowPlan.channel;
          executionModel = overflowPlan.executionModel;
          upstreamModel = selectedUpstreamModel;
          dbChannel = channel;
          baseUrl = channel.baseUrl.replace(/\/+$/, '');
          isHmStudio = false;
          isWxHaidiYue = overflowPlan.kind === 'wx-haidiyue';
          isMjNewApi = overflowPlan.kind === 'mjnewapi';
          if (contentId !== null) {
            const current = db.select().from(contents).where(eq(contents.id, contentId)).get();
            let metadata: Record<string, any> = {};
            try { metadata = JSON.parse(current?.metadata || '{}'); } catch { }
            metadata.channelId = channel.id;
            metadata.channelApiKeyId = channel.apiKeyId;
            metadata.actualChannel = overflowPlan.kind;
            metadata.actualModel = executionModel;
            metadata.upstreamModel = upstreamModel;
            db.update(contents).set({ metadata: JSON.stringify(metadata) }).where(eq(contents.id, contentId)).run();
          }
          break;
        }

        const detail = await createResp.text().catch(() => '');
        if (!isHmStudioConcurrencyError(createResp.status, detail)) {
          refundFailedTask(`备用线路提交失败 (${createResp.status}): ${detail.slice(0, 300)}`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        ChannelService.disableExecutionTarget(overflowPlan.channel, detail);
        sendEvent({ type: 'status', message: '当前备用线路已饱和并自动停止，正在尝试下一条线路...' });
        overflowPlan = findHmStudioOverflowPlan(overflowInput, attemptedFallbackIds);
      }

      if (!videoId) {
        refundFailedTask('所有兼容视频线路当前均不可用，请在后台启动线路后重试');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
    } else if (isHmStudio) {
      sendEvent({ type: 'status', message: '正在整理素材并提交 HM Studio 任务...' });
      const formData = buildHmStudioVideoForm({
        model: upstreamModel,
        prompt: prompt.trim(),
        duration: Number(video_length) || 5,
        ratio: aspect_ratio,
        resolution: resolution || '720p',
        imageSources: reference_images,
        videoSources: finalVideos,
        audioSources: finalAudios,
        firstFrame: first_frame,
        lastFrame: last_frame,
      });
      const headers: Record<string, string> = {};
      if (channel.apiKey) headers.Authorization = `Bearer ${channel.apiKey}`;

      const createResp = await fetch(hmStudioCreateUrl(baseUrl, 'video'), {
        method: 'POST',
        headers,
        body: formData,
        signal: AbortSignal.timeout(dbChannel?.timeout || 120_000),
      });
      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        refundFailedTask(`HM Studio 提交失败 (${createResp.status}): ${errText.slice(0, 300)}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isWxHaidiYue) {
      sendEvent({ type: 'status', message: '正在提交视频任务...' });
      const payload = buildWxHaidiYueVideoPayload({
        prompt: prompt.trim(),
        duration: Number(video_length) || 5,
        aspectRatio: aspect_ratio,
        images: reference_images,
      });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (channel.apiKey) headers.Authorization = `Bearer ${channel.apiKey}`;
      const createResp = await fetch(wxHaidiYueCreateUrl(baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(dbChannel?.timeout || 120_000),
      });
      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] wx-海底月提交失败 (${createResp.status}): ${errText.slice(0, 300)}`);
        refundFailedTask('视频任务提交失败，请稍后重试');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.request_id || job.task_id || job.id;
    } else if (isMjNewApi) {
      sendEvent({ type: 'status', message: '正在处理素材并提交视频任务...' });

      const imageUrls = (reference_images || [])
        .map((item: string) => convertBase64ToPublicUrl(item, 'mj_img', req))
        .filter(Boolean);
      const videoUrls = finalVideos
        .map(item => convertBase64ToPublicUrl(item, 'mj_video', req))
        .filter(Boolean);
      const audioUrls = finalAudios
        .map(item => convertBase64ToPublicUrl(item, 'mj_audio', req))
        .filter(Boolean);
      const invalidUrls = findInvalidMjNewApiMaterialUrls(imageUrls, videoUrls, audioUrls);

      if (invalidUrls.length > 0) {
        refundFailedTask('参考素材必须是外网可访问的 HTTPS URL，请检查 BACKEND_URL 配置');
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const payload = buildMjNewApiVideoPayload({
        model: upstreamModel,
        prompt,
        duration: Number(video_length) || 6,
        aspectRatio: aspect_ratio,
        resolution,
        images: imageUrls,
        videos: videoUrls,
        audios: audioUrls,
      });

      console.log(`[video] MJNewAPI 创建任务: model=${model} upstreamModel=${upstreamModel} duration=${payload.duration} resolution=${resolution} images=${imageUrls.length} videos=${videoUrls.length} audios=${audioUrls.length}`);

      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(dbChannel?.timeout || 120_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        refundFailedTask(`视频任务提交失败 (${createResp.status}): ${errText.slice(0, 300)}`);
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

      const payload = buildSudaShuiVideoPayload({
        model: upstreamModel,
        prompt,
        duration: model === 'sdas-pd-sd2.0-pro-933-5-720p' ? 10 : (Number(video_length) || 6),
        aspectRatio: aspect_ratio,
        imageUrls,
        videoUrls,
        audioUrls: audioUpUrls,
      });

      console.log(`[video] Step1 SudaShui 创建任务: model=${model} duration=${payload.duration} resolution=${resolution}`);

      const createResp = await fetch(sudaShuiVideoCreateUrl(baseUrl), {
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
        refundFailedTask(`创建视频任务失败 (${createResp.status}): ${errText.slice(0, 1000)}`);
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
        refundFailedTask(`创建视频任务失败 (${createResp.status}): ${errText.slice(0, 1000)}`);
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
        refundFailedTask(`创建视频任务失败 (${createResp.status}): ${errText.slice(0, 1000)}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isVeoOmniEdit) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Veo Omni Flash 视频编辑任务...' });
      const imageUrls = (reference_images || [])
        .map((item: string) => convertBase64ToPublicUrl(item, 'veo_edit_ref', req));
      const videoUrl = convertBase64ToPublicUrl(finalVideos[0], 'veo_edit_video', req);
      const payload = buildNewTokenVideoPayload({
        model,
        upstreamModel,
        prompt,
        duration: 10,
        aspectRatio: aspect_ratio,
        images: imageUrls,
        videos: [videoUrl],
      });
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
        refundFailedTask(`创建视频编辑任务失败 (${createResp.status}): ${errText.slice(0, 1000)}`);
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
        refundFailedTask(`创建视频任务失败 (${createResp.status}): ${errText.slice(0, 1000)}`);
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
        refundFailedTask(`创建视频任务失败 (${createResp.status}): ${errText.slice(0, 1000)}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isJulunMinimaxH3Model(model)) {
      sendEvent({ type: 'status', message: '正在提交巨轮 MiniMax H3 768p 任务...' });
      const imageUrls = reference_images.slice(0, 9)
        .map((item: string) => convertBase64ToPublicUrl(item, 'julun_h3_img', req))
        .filter(Boolean);
      const videoUrls = finalVideos.slice(0, 3)
        .map(item => convertBase64ToPublicUrl(item, 'julun_h3_video', req))
        .filter(Boolean);
      const audioUrls = finalAudios.slice(0, 3)
        .map(item => convertBase64ToPublicUrl(item, 'julun_h3_audio', req))
        .filter(Boolean);
      const payload = buildJulunMinimaxH3Payload({
        model: upstreamModel,
        prompt: prompt.trim(),
        seconds: Number(video_length),
        ratio: aspect_ratio,
        imageUrls,
        videoUrls,
        audioUrls,
      });
      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(channel.apiKey ? { Authorization: `Bearer ${channel.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(dbChannel?.timeout || 120_000),
      });
      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        refundFailedTask(`巨轮 MiniMax H3 提交失败 (${createResp.status}): ${errText.slice(0, 300)}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.id || job.task_id;
    } else if (isWan30 && isSnumomWan) {
      sendEvent({ type: 'status', message: '正在整理并提交 snumom WAN3.0 任务...' });

      const imageUrls = (reference_images || []).slice(0, 10)
        .map((item: string) => convertBase64ToPublicUrl(item, 'snumom_wan3_img', req))
        .filter(Boolean);
      const videoUrls = finalVideos.slice(0, 5)
        .map(item => convertBase64ToPublicUrl(item, 'snumom_wan3_video', req))
        .filter(Boolean);
      const audioUrls = finalAudios.slice(0, 5)
        .map(item => convertBase64ToPublicUrl(item, 'snumom_wan3_audio', req))
        .filter(Boolean);
      const frameImages: Array<{ url: string; role: 'first_frame' | 'last_frame' }> = [];
      if (first_frame) {
        const url = convertBase64ToPublicUrl(first_frame, 'snumom_wan3_first', req);
        if (url) frameImages.push({ url, role: 'first_frame' });
      }
      if (last_frame) {
        const url = convertBase64ToPublicUrl(last_frame, 'snumom_wan3_last', req);
        if (url) frameImages.push({ url, role: 'last_frame' });
      }
      const payload = buildSnumomWanPayload({
        model: upstreamModel,
        prompt,
        seconds: Number(video_length),
        resolution,
        aspectRatio: aspect_ratio,
        images: frameImages.length > 0
          ? frameImages
          : imageUrls.map(url => ({ url, role: 'reference_image' })),
        videos: videoUrls.map(url => ({ url })),
        audios: audioUrls.map(url => ({ url })),
      });
      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${channel.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(dbChannel?.timeout || 120_000),
      });
      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        refundFailedTask(`snumom WAN3.0 提交失败 (${createResp.status}): ${errText.slice(0, 300)}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.id || job.task_id;
    } else if (isWan30) {
      sendEvent({ type: 'status', message: '正在整理 WAN3.0 多模态参考素材...' });

      const imageUrls = (reference_images || []).slice(0, 10)
        .map((item: string) => convertBase64ToPublicUrl(item, 'wan3_img', req));
      const videoUrls = finalVideos.slice(0, 5)
        .map(item => convertBase64ToPublicUrl(item, 'wan3_video', req));
      const audioUrls = finalAudios.slice(0, 5)
        .map(item => convertBase64ToPublicUrl(item, 'wan3_audio', req));

      const createResp = await fetch(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(channel.apiKey ? { Authorization: `Bearer ${channel.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: upstreamModel,
          prompt: prompt.trim(),
          seconds: Number(video_length),
          ratio: aspect_ratio,
          resolution: '720p',
          image_urls: imageUrls,
          video_urls: videoUrls,
          audio_urls: audioUrls,
        }),
        signal: AbortSignal.timeout(300_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text();
        refundFailedTask(`WAN3.0 提交失败 (${createResp.status}): ${errText.slice(0, 300)}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isJulunSd25) {
      sendEvent({ type: 'status', message: '正在通过 Julun sd2.5 备用线路提交视频任务...' });
      const imageUrls = reference_images.slice(0, 9)
        .map((item: string) => convertBase64ToPublicUrl(item, 'julun_sd25_img', req))
        .filter(Boolean);
      const overflowPlan = findSiYueTianOverflowPlan(overflowInput);
      if (!overflowPlan) {
        refundFailedTask('Julun sd2.5 备用线路当前不可用');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const createResp = await submitSiYueTianOverflowPlan(overflowPlan, {
        prompt: prompt.trim(),
        ratio: aspect_ratio,
        imageUrls,
      });
      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        if (isHmStudioConcurrencyError(createResp.status, errText)) {
          ChannelService.disableExecutionTarget(channel, errText);
        }
        refundFailedTask(`Julun sd2.5 提交失败 (${createResp.status}): ${errText.slice(0, 300)}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.request_id || job.task_id || job.id;
    } else if (isSeedanceJsonModel) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Seedance 2.0 任务...' });

      // 将 base64 素材保存到本地并生成自托管公网 URL
      const imageUrls: string[] = [];
      const isVd25 = model === 'vd-seedance-2.5-480p' || model === 'vd-seedance-2.5-720p';
      const isAd25 = model === 'ad-seedance-2.5-480p';
      const maxImgCount = (isAd25 || model === 'sd2.5') ? 30 : 9;
      for (const img of (reference_images || []).slice(0, maxImgCount)) {
        const url = convertBase64ToPublicUrl(img, 'sd2_ref', req);
        if (url) imageUrls.push(url);
      }
      const videoRefUrls: string[] = [];
      const isNoVideoModel = model === 'sd2.5' || model === 'sd2-mini' || model === 'seedance2.0-933' || model === 'seedance2.0 933' || model.includes('noface');
      const maxVidCount = isAd25 ? 10 : (isNoVideoModel ? 0 : 3);
      for (const v of finalVideos.slice(0, maxVidCount)) {
        const url = convertBase64ToPublicUrl(v, 'sd2_vid', req);
        if (url) videoRefUrls.push(url);
      }
      const audioRefUrls: string[] = [];
      const maxAudCount = isAd25 ? 10 : (isVd25 ? 0 : (model === 'sd2.5' ? 0 : 3));
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
        aspect_ratio: aspect_ratio,
      };

      if (imageUrls.length > 0) payload.image_refs = imageUrls;
      if (videoRefUrls.length > 0) payload.video_refs = videoRefUrls;
      if (audioRefUrls.length > 0) payload.audio_refs = audioRefUrls;
      if (compliance_enabled !== undefined) payload.compliance_enabled = Boolean(compliance_enabled);
      if (compliance_mode) payload.compliance_mode = compliance_mode;

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
        const canOverflowSiYueTian = model === SI_YUE_TIAN_PRIMARY_VIDEO_MODEL
          && isSiYueTianChannel(channel)
          && isHmStudioConcurrencyError(createResp.status, errText);
        if (!canOverflowSiYueTian) {
          console.error(`[video] sd2 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
          refundFailedTask(`创建视频任务失败 (${createResp.status}): ${errText.slice(0, 1000)}`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        ChannelService.disableExecutionTarget(channel, errText);
        failoverFrom = 'siyuetian';
        failoverReason = 'siyuetian_upstream_concurrency';
        sendEvent({ type: 'status', message: '四月天上游已饱和并自动停止，正在尝试备用线路...' });

        const overflowPlan = findSiYueTianOverflowPlan(overflowInput);
        if (overflowPlan) {
          const fallbackResponse = await submitSiYueTianOverflowPlan(overflowPlan, {
            prompt: prompt.trim(),
            ratio: aspect_ratio,
            imageUrls,
          });
          if (fallbackResponse.ok) {
            const job = await fallbackResponse.json() as any;
            videoId = job.request_id || job.task_id || job.id;
            channel = overflowPlan.channel;
            dbChannel = channel;
            executionModel = overflowPlan.executionModel;
            upstreamModel = overflowPlan.executionModel;
            baseUrl = channel.baseUrl.replace(/\/+$/, '');
            isHmStudio = false;
            isWxHaidiYue = false;
            isMjNewApi = false;
            isJulunSd25 = true;
            if (contentId !== null) {
              const current = db.select().from(contents).where(eq(contents.id, contentId)).get();
              let metadata: Record<string, any> = {};
              try { metadata = JSON.parse(current?.metadata || '{}'); } catch { }
              metadata.channelId = channel.id;
              metadata.channelApiKeyId = channel.apiKeyId;
              metadata.actualChannel = 'julun';
              metadata.actualModel = executionModel;
              metadata.upstreamModel = upstreamModel;
              metadata.fallbackFrom = failoverFrom;
              metadata.fallbackReason = failoverReason;
              metadata.fallbackAt = new Date().toISOString();
              db.update(contents).set({ metadata: JSON.stringify(metadata) }).where(eq(contents.id, contentId)).run();
            }
          } else {
            const fallbackDetail = await fallbackResponse.text().catch(() => '');
            if (isHmStudioConcurrencyError(fallbackResponse.status, fallbackDetail)) {
              ChannelService.disableExecutionTarget(overflowPlan.channel, fallbackDetail);
            }
            refundFailedTask(`Julun sd2.5 提交失败 (${fallbackResponse.status}): ${fallbackDetail.slice(0, 300)}`);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
        }

        if (!videoId) {
          refundFailedTask('四月天及所有兼容备用线路当前均不可用');
          res.write('data: [DONE]\n\n');
          return res.end();
        }
      } else {
        const job = await createResp.json() as any;
        videoId = job.task_id || job.id;
      }
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
      const maxRefs = meta?.requireRef ? 1 : 5;
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
        refundFailedTask(`创建视频任务失败 (${createResp.status}): ${errText.slice(0, 1000)}`);
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
        if (isHmStudio) {
          pollUrl = hmStudioTaskUrl(baseUrl, videoId);
        } else if (isWxHaidiYue) {
          pollUrl = wxHaidiYueTaskUrl(baseUrl, videoId);
        } else if (isSudaShui) {
          pollUrl = `${baseUrl}/v1/video/generations/${videoId}`;
        }

        const pollResp = await fetch(pollUrl, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });

        if (!pollResp.ok) {
          const detail = await pollResp.text().catch(() => '');
          const failureMessage = formatVideoPollHttpFailure(pollResp.status, detail);
          console.error(`[video] ${failureMessage}`);
          refundFailedTask(failureMessage);
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }

        const status = await pollResp.json() as any;
        let taskStatus = status.status;
        let progress = status.progress || 0;
        let resultUrl = '';
        let errMsg = '';

        if (isHmStudio) {
          const normalized = normalizeHmStudioTask(status, baseUrl);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || 'HM Studio 视频生成失败';
        } else if (isWxHaidiYue) {
          const normalized = normalizeWxHaidiYueTask(status, baseUrl);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || normalized.errorCode || '视频生成失败';
        } else if (isSnumomWan) {
          const normalized = normalizeSnumomWanTask(status);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || 'snumom 视频生成失败';
          if ((taskStatus === 'completed' || taskStatus === 'success') && !resultUrl) {
            resultUrl = snumomContentUrl(baseUrl, videoId);
          }
        } else if (isSudaShui) {
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

        if (isVideoFailurePayload(status)) {
          taskStatus = 'failed';
          errMsg = extractVideoFailureMessage(status) || errMsg || '视频生成失败';
        }

        console.log(`[video] 轮询 (${isSudaShui ? 'SudaShui' : isSoraV4 ? 'SoraV4' : isSeedanceFast ? 'SeedanceFast' : 'Default'}): status=${taskStatus} progress=${progress}%`);

        if (taskStatus === 'processing' || taskStatus === 'queued' || taskStatus === 'pending' || taskStatus === 'submitted' || taskStatus === 'generating' || taskStatus === 'post_processing' || taskStatus === 'finalizing' || taskStatus === 'in_progress') {
          sendEvent({ type: 'progress', progress });
          const hmProgressText = isHmStudio ? normalizeHmStudioTask(status, baseUrl).progressText : '';
          sendEvent({ type: 'status', message: hmProgressText || `视频生成中 ${progress}%` });
          // 将实时进度写入数据库，以便前端刷新页面后恢复时能读取
          if (contentId !== null) {
            try {
              const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
              if (row) {
                const meta = JSON.parse(row.metadata || '{}');
                meta.progress = progress;
                meta.upstreamStatus = taskStatus;
                if (hmProgressText) meta.progressText = hmProgressText;
                db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
              }
            } catch { }
          }
        } else if (taskStatus === 'completed' || taskStatus === 'success') {
          console.log(`[video] ✅ 生成完成: ${resultUrl}`);
          sendEvent({ type: 'progress', progress: 100 });

          // Persist every completed video on the VPS before exposing it to users.
          let finalVideoUrl = '';
          try {
            if (resultUrl && resultUrl.includes('llm.chre3.com')) {
              finalVideoUrl = await localizeChre3Video(resultUrl, videoId, model);
            } else {
              finalVideoUrl = await downloadAndLocalizeVideo(resultUrl, videoId, model, dbChannel?.id, dbChannel?.apiKeyId);
            }
          } catch (localErr: any) {
            console.error(`[video] VPS localization failed; task remains processing: ${localErr.message}`);
            sendEvent({ type: 'status', message: '视频已生成，正在保存到本站存储' });
            continue;
          }

          sendEvent({ type: 'complete', videoUrl: finalVideoUrl });
          billUsage(finalVideoUrl, resultUrl);
          if (contentId !== null) activePolls.delete(contentId);
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        } else if (isVideoFailureStatus(taskStatus)) {
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
    refundFailedTask(msg);
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
    if (url.includes('llm.chre3.com')) {
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
    let localSourcePath = '';
    if (url.startsWith('/uploads/')) {
      const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads');
      const relativePath = url.slice('/uploads/'.length).replace(/^[/\\]+/, '');
      const candidatePath = path.resolve(uploadsRoot, relativePath);
      if (candidatePath !== uploadsRoot && !candidatePath.startsWith(`${uploadsRoot}${path.sep}`)) {
        return res.status(400).send('Invalid local video path');
      }
      if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
        return res.status(404).send('Local video file not found');
      }
      localSourcePath = candidatePath;

      // Preserve native Range handling for already compatible local files.
      // Existing HEVC files continue through the locked transcoding cache below.
      if (detectVideoCodec(localSourcePath) !== 'hevc') {
        return res.sendFile(localSourcePath);
      }
    }

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
          if (url.includes('llm.chre3.com')) {
            const channel = findVideoChannel('sd2-c7');
            if (channel?.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;
          }

          if (localSourcePath) {
            fs.copyFileSync(localSourcePath, tempOriginalPath);
          } else {
            const fetchResp = await fetch(url, { headers });
          if (!fetchResp.ok) throw new Error(`无法获取原始视频流: ${fetchResp.statusText}`);
            const buffer = Buffer.from(await fetchResp.arrayBuffer());
            fs.writeFileSync(tempOriginalPath, buffer);
          }

          // ffprobe 检测编码
          let isHevc = false;
          try {
            isHevc = detectVideoCodec(tempOriginalPath) === 'hevc';
          } catch {
            console.warn('[video/play] ffprobe 探测失败，默认尝试转码');
            isHevc = true;
          }

          if (isHevc) {
            console.log(`[video/play] 检测到 H.265 (HEVC)，转码为 H.264...`);
            await execPromise(
              `ffmpeg -y -i "${tempOriginalPath}" -c:v libx264 -tag:v avc1 -pix_fmt yuv420p -preset superfast -movflags +faststart -c:a copy "${tempTranscodedPath}"`
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

function persistHmQueueSnapshot(contentId: number, snapshot: HmStudioQueueSnapshot): void {
  const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!record || record.status === 'completed' || record.status === 'failed') return;
  let metadata: Record<string, any> = {};
  try { metadata = JSON.parse(record.metadata || '{}'); } catch { }
  metadata.queueStatus = snapshot.status;
  metadata.queuePosition = snapshot.position;
  metadata.queueRunning = snapshot.running;
  metadata.queueLimit = snapshot.concurrencyLimit;
  metadata.queueUserRunning = snapshot.userRunning;
  metadata.queueUserLimit = snapshot.userConcurrencyLimit;
  metadata.queueTotal = snapshot.queued;
  metadata.queuePoolId = snapshot.poolId;
  metadata.queuePoolRunning = snapshot.poolRunning;
  metadata.queuePoolLimit = snapshot.poolConcurrencyLimit;
  if (snapshot.status === 'running' && !metadata.queueStartedAt) {
    metadata.queueStartedAt = new Date().toISOString();
  }
  db.update(contents).set({
    status: snapshot.status === 'queued' ? 'queued' : 'processing',
    metadata: JSON.stringify(metadata),
  }).where(eq(contents.id, contentId)).run();
}

async function failHmQueuedVideo(contentId: number, error: unknown): Promise<void> {
  const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!record || record.status === 'failed' || record.status === 'completed') return;
  let metadata: Record<string, any> = {};
  try { metadata = JSON.parse(record.metadata || '{}'); } catch { }
  const rawMessage = error instanceof Error ? error.message : String(error || '视频任务失败');
  const taskChannel = metadata.channelId
    ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null)
    : null;
  const message = clarifyVideoCapacityFailure(rawMessage, isHmStudioChannel(taskChannel));
  const refundAmount = Number(record.cost) || 0;
  if (refundAmount > 0 && !metadata.queueRefunded) {
    if (metadata.billingSource === 'token' && metadata.tokenId) {
      const { TokenService } = await import('../services/tokenService.js');
      TokenService.refundBalance(Number(metadata.tokenId), refundAmount);
      metadata.refundTarget = 'api_token';
    } else {
      BalanceService.refund(record.userId, refundAmount, 'generate_video_refund');
      // Linked unlimited API tokens also increment usedAmount during deduction.
      if (metadata.tokenId) {
        const { TokenService } = await import('../services/tokenService.js');
        TokenService.refundBalance(Number(metadata.tokenId), refundAmount);
      }
      metadata.refundTarget = 'user_balance';
    }
    metadata.queueRefunded = true;
    metadata.billingStatus = 'refunded';
    metadata.refundAmount = refundAmount;
    metadata.refundedAt = new Date().toISOString();
  }
  metadata.queueStatus = 'failed';
  metadata.queuePosition = 0;
  metadata.error = message;
  metadata.failedAt = new Date().toISOString();
  db.update(contents).set({ status: 'failed', cost: 0, metadata: JSON.stringify(metadata) })
    .where(eq(contents.id, contentId)).run();
}

/** 将已持久化的视频内容记录加入 HM Studio 公平队列。 */
export function enqueueHmStudioVideoContent(contentId: number): HmStudioQueueSnapshot {
  const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!record) throw new Error(`Video content ${contentId} not found`);
  let metadata: Record<string, any> = {};
  try { metadata = JSON.parse(record.metadata || '{}'); } catch { }

  const channelRow = metadata.channelId
    ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null)
    : null;
  const fallbackChannel = ChannelService.findChannelForModel(record.modelId || metadata.model || '');
  const channel = channelRow || fallbackChannel;
  if (!channel || !isHmStudioChannel(channel)) throw new Error('HM Studio channel is unavailable');

  const model = record.modelId || metadata.model || '';
  let mapping: Record<string, string> = {};
  try {
    mapping = typeof channel.modelMapping === 'string' ? JSON.parse(channel.modelMapping || '{}') : (channel.modelMapping || {});
  } catch { }
  const upstreamModel = metadata.upstreamModel || mapping[model] || model;

  const queued = hmStudioQueue.enqueue({
    id: `video:${contentId}`,
    userKey: metadata.queueUserKey || `user:${record.userId}`,
    poolKey: hmStudioPoolKey(channel),
    onUpdate: snapshot => persistHmQueueSnapshot(contentId, snapshot),
    task: async () => {
      try {
        const latest = db.select().from(contents).where(eq(contents.id, contentId)).get();
        if (!latest || latest.status === 'failed' || latest.status === 'completed') return;
        let latestMeta: Record<string, any> = {};
        try { latestMeta = JSON.parse(latest.metadata || '{}'); } catch { }

        const referenceImages = latestMeta.reference_images || latestMeta.image_urls || [];
        const referenceVideos = latestMeta.reference_videos || latestMeta.video_urls || [];
        const referenceAudios = latestMeta.audio_urls || [];
        const overflowRequest = {
          requestedModel: model,
          resolution: latestMeta.resolution || '720p',
          seconds: Number(latestMeta.seconds) || 6,
          imageCount: referenceImages.length,
          videoCount: referenceVideos.length,
          audioCount: referenceAudios.length,
        };
        const attemptedHmPools = new Set<string>();
        let selectedHmChannel: any = channel;
        let selectedHmUpstreamModel = upstreamModel;
        let response: Awaited<ReturnType<typeof fetch>>;

        while (true) {
          attemptedHmPools.add(hmStudioPoolKey(selectedHmChannel));
          let selectedMapping: Record<string, string> = {};
          try {
            selectedMapping = typeof selectedHmChannel.modelMapping === 'string'
              ? JSON.parse(selectedHmChannel.modelMapping || '{}')
              : (selectedHmChannel.modelMapping || {});
          } catch { }
          selectedHmUpstreamModel = selectedMapping[model] || model;
          const formData = buildHmStudioVideoForm({
            model: selectedHmUpstreamModel,
            prompt: String(latestMeta.prompt || latest.inputText || '').trim(),
            duration: Number(latestMeta.seconds) || 6,
            ratio: latestMeta.aspect_ratio || latestMeta.ratio || '16:9',
            resolution: latestMeta.resolution || '720p',
            imageSources: referenceImages,
            videoSources: referenceVideos,
            audioSources: referenceAudios,
            firstFrame: latestMeta.first_frame || latestMeta.firstFrame,
            lastFrame: latestMeta.last_frame || latestMeta.lastFrame,
            functionMode: latestMeta.function_mode,
            upstreamChannel: latestMeta.upstream_channel,
          });
          const headers: Record<string, string> = {};
          if (selectedHmChannel.apiKey) headers.Authorization = `Bearer ${selectedHmChannel.apiKey}`;
          response = await fetch(hmStudioCreateUrl(selectedHmChannel.baseUrl, 'video'), {
            method: 'POST',
            headers,
            body: formData,
            signal: AbortSignal.timeout(selectedHmChannel.timeout || 120_000),
          });
          if (response.ok) break;

          const detail = await response.text().catch(() => '');
          if (!isHmStudioConcurrencyError(response.status, detail)) {
            throw new Error(`HM Studio 提交失败 (${response.status}): ${detail.slice(0, 300)}`);
          }
          ChannelService.disableExecutionTarget(selectedHmChannel, detail);
          const nextHmChannel = ChannelService.findChannelForModel(model);
          if (nextHmChannel && isHmStudioChannel(nextHmChannel) && !attemptedHmPools.has(hmStudioPoolKey(nextHmChannel))) {
            selectedHmChannel = nextHmChannel;
            latestMeta.channelId = nextHmChannel.id;
            latestMeta.channelApiKeyId = nextHmChannel.apiKeyId;
            latestMeta.progressText = '当前 HM Key 已自动停止，正在尝试下一个 Key';
            db.update(contents).set({ metadata: JSON.stringify(latestMeta) }).where(eq(contents.id, contentId)).run();
            continue;
          }

          const attemptedFallbackIds = new Set<number>();
          let overflowPlan = findHmStudioOverflowPlan(overflowRequest, attemptedFallbackIds);
          while (overflowPlan) {
            attemptedFallbackIds.add(overflowPlan.channel.id);
            const fallbackChannel = overflowPlan.channel;
            let fallbackMapping: Record<string, string> = {};
            try {
              fallbackMapping = typeof fallbackChannel.modelMapping === 'string'
                ? JSON.parse(fallbackChannel.modelMapping || '{}')
                : (fallbackChannel.modelMapping || {});
            } catch { }
            const fallbackUpstreamModel = fallbackMapping[overflowPlan.executionModel] || overflowPlan.executionModel;
            let fallbackResponse: Awaited<ReturnType<typeof fetch>>;
            if (overflowPlan.kind === 'wx-haidiyue') {
              const fallbackPayload = buildWxHaidiYueVideoPayload({
                prompt: String(latestMeta.prompt || latest.inputText || '').trim(),
                duration: Number(latestMeta.seconds) || 6,
                aspectRatio: latestMeta.aspect_ratio || latestMeta.ratio || '16:9',
                images: referenceImages,
              });
              fallbackResponse = await fetch(wxHaidiYueCreateUrl(fallbackChannel.baseUrl), {
                method: 'POST',
                headers: { Authorization: `Bearer ${fallbackChannel.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(fallbackPayload),
                signal: AbortSignal.timeout(fallbackChannel.timeout || 120_000),
              });
            } else {
              const imageUrls = referenceImages
                .map((item: string) => convertBase64ToPublicUrl(item, 'mj_overflow_img', latestMeta.publicBaseUrl || ''))
                .filter(Boolean);
              if (findInvalidMjNewApiMaterialUrls(imageUrls).length > 0) {
                throw new Error('视频任务暂时无法提交，请检查 BACKEND_URL');
              }
              const fallbackPayload = buildMjNewApiVideoPayload({
                model: fallbackUpstreamModel,
                prompt: String(latestMeta.prompt || latest.inputText || '').trim(),
                duration: Number(latestMeta.seconds) || 6,
                aspectRatio: latestMeta.aspect_ratio || latestMeta.ratio || '16:9',
                resolution: latestMeta.resolution || '720p',
                images: imageUrls,
                videos: [],
                audios: [],
              });
              fallbackResponse = await fetch(`${fallbackChannel.baseUrl.replace(/\/+$/, '')}/v1/videos`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${fallbackChannel.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(fallbackPayload),
                signal: AbortSignal.timeout(fallbackChannel.timeout || 120_000),
              });
            }

            if (!fallbackResponse.ok) {
              const fallbackDetail = await fallbackResponse.text().catch(() => '');
              if (isHmStudioConcurrencyError(fallbackResponse.status, fallbackDetail)) {
                ChannelService.disableExecutionTarget(fallbackChannel, fallbackDetail);
                overflowPlan = findHmStudioOverflowPlan(overflowRequest, attemptedFallbackIds);
                continue;
              }
              throw new Error(`备用线路提交失败 (${fallbackResponse.status}): ${fallbackDetail.slice(0, 300)}`);
            }

            const fallbackResult = await fallbackResponse.json() as any;
            const fallbackVideoId = fallbackResult.request_id || fallbackResult.id || fallbackResult.task_id;
            if (!fallbackVideoId) throw new Error('备用线路未返回任务 ID');
            latestMeta.videoId = fallbackVideoId;
            latestMeta.channelId = fallbackChannel.id;
            latestMeta.channelApiKeyId = fallbackChannel.apiKeyId;
            latestMeta.upstreamModel = fallbackUpstreamModel;
            latestMeta.requestedModel = model;
            latestMeta.actualModel = overflowPlan.executionModel;
            latestMeta.actualChannel = overflowPlan.kind;
            latestMeta.fallbackFrom = 'hmstudio';
            latestMeta.fallbackReason = 'hmstudio_upstream_concurrency';
            latestMeta.fallbackAt = new Date().toISOString();
            latestMeta.upstreamStatus = 'submitted';
            latestMeta.progressText = '视频生成中';
            latestMeta.progress = 0;
            latestMeta.queueStatus = 'running';
            db.update(contents).set({ status: 'processing', metadata: JSON.stringify(latestMeta) })
              .where(eq(contents.id, contentId)).run();
            const fallbackRecord = db.select().from(contents).where(eq(contents.id, contentId)).get();
            if (fallbackRecord) void resumePollForTask(contentId, fallbackRecord);
            return;
          }
          throw new Error('所有兼容视频线路当前均不可用，请在后台启动线路后重试');
        }

        const payload = await response.json() as any;
        const videoId = payload.task_id || payload.id;
        if (!videoId) throw new Error('HM Studio 未返回任务 ID');

        latestMeta.videoId = videoId;
        latestMeta.channelId = selectedHmChannel.id;
        latestMeta.channelApiKeyId = selectedHmChannel.apiKeyId;
        latestMeta.upstreamModel = selectedHmUpstreamModel;
        latestMeta.upstreamStatus = 'submitted';
        latestMeta.progress = 0;
        latestMeta.queueStatus = 'running';
        db.update(contents).set({ status: 'processing', metadata: JSON.stringify(latestMeta) })
          .where(eq(contents.id, contentId)).run();

        const updatedRecord = db.select().from(contents).where(eq(contents.id, contentId)).get();
        if (updatedRecord) await resumePollForTask(contentId, updatedRecord);
      } catch (error) {
        await failHmQueuedVideo(contentId, error);
        throw error;
      }
    },
  });
  return queued.snapshot;
}

function adoptHmStudioProcessingContent(contentId: number, record: any): HmStudioQueueSnapshot {
  let metadata: Record<string, any> = {};
  try { metadata = JSON.parse(record.metadata || '{}'); } catch { }
  const adopted = hmStudioQueue.adoptRunning({
    id: `video:${contentId}`,
    userKey: metadata.queueUserKey || `user:${record.userId}`,
    poolKey: hmStudioPoolKey(metadata.channelId
      ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null) || {}
      : {}),
    onUpdate: snapshot => persistHmQueueSnapshot(contentId, snapshot),
    task: () => resumePollForTask(contentId, record),
  });
  return adopted.snapshot;
}

export function resumePollForTask(contentId: number, record: any): Promise<void> {
  if (activePolls.has(contentId)) return activePollPromises.get(contentId) || Promise.resolve();
  activePolls.add(contentId);

  let model = record.modelId || '';
  if (model === 'sdas-xh-sd2.0-933-3-pro-720p') {
    model = 'sdas-pd-sd2.0-pro-933-5-720p';
  }
  const meta = MODEL_META[model];
  let videoId = '';
  let metadata: any = {};
  try {
    metadata = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : (record.metadata || {});
    videoId = metadata.videoId || '';
  } catch (e) {
    console.error(`[video-recover] Parse metadata failed for task ${contentId}:`, e);
  }

  const originalChannel = metadata.channelId
    ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null)
    : null;
  const fallbackChannel = findVideoChannel(model);
  const channel = originalChannel ? {
    id: originalChannel.id,
    type: originalChannel.type,
    baseUrl: originalChannel.baseUrl,
    apiKey: originalChannel.apiKey,
    modelMapping: originalChannel.modelMapping,
  } : fallbackChannel;
  if (!channel) {
    console.error(`[video-recover] No channel found for model ${model} in task ${contentId}`);
    activePolls.delete(contentId);
    return failHmQueuedVideo(contentId, new Error(`No channel found for model ${model}`));
  }

  if (!videoId) {
    console.error(`[video-recover] No videoId found in metadata for task ${contentId}`);
    activePolls.delete(contentId);
    return failHmQueuedVideo(contentId, new Error('Upstream task ID is missing'));
  }

  const resolution = metadata.resolution || '720p';
  const video_length = metadata.seconds || 6;

  // Calculate billing rate
  let rate = 0.05;
  if (model === 'seedance-2.0-fast') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_fast_rate')).get();
    rate = parseFloat(row?.value || '4.00');
  } else if (model === 'veo-omni-flash') {
    const row = db.select().from(settings).where(eq(settings.key, 'veo_omni_flash_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'veo-omni-flash-video-edit') {
    rate = 0.09;
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
    rate = parseFloat(row?.value || '3.75');
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
    'sd2-c6'
  ].includes(model);

  let baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const isSeedanceFast = model === 'seedance-2.0-fast';
  const isSoraV4 = model === 'sora-v4-fast' || model === 'sora-v4-pro' || model === 'seedance-2.0';
  const isSudaShui = meta?.series === 'sudashui';
  const isHmStudio = isHmStudioChannel(channel);
  const isWxHaidiYue = isWxHaidiYueChannel(channel);
  const isSnumomWan = isSnumomWanChannel(channel);

  const headers: Record<string, string> = {};
  if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

  const pollingPromise = (async () => {
    console.log(`[video-recover] Starting polling for video task ${contentId} (videoId: ${videoId})`);
    const pollInterval = 5000;
    const startTime = Date.now();
    const createdAt = new Date(record.createdAt).getTime();
    const timeoutStartedAt = Number.isFinite(createdAt) ? createdAt : startTime;
    const pollTimeoutMs = Number.isFinite(env.VIDEO_TASK_POLL_TIMEOUT_MS) && env.VIDEO_TASK_POLL_TIMEOUT_MS > 0
      ? env.VIDEO_TASK_POLL_TIMEOUT_MS
      : 1_800_000;

    while (true) {
      const currentRecord = db.select().from(contents).where(eq(contents.id, contentId)).get();
      if (!currentRecord || currentRecord.status !== 'processing') {
        console.log(`[video-recover] Task ${contentId} is no longer in processing status (or was deleted)`);
        break;
      }

      if (Date.now() - timeoutStartedAt >= pollTimeoutMs) {
        const timeoutMinutes = Math.max(1, Math.round(pollTimeoutMs / 60_000));
        await failHmQueuedVideo(contentId, new Error(`Video generation timed out after ${timeoutMinutes} minutes`));
        break;
      }

      await new Promise(r => setTimeout(r, pollInterval));

      try {
        let pollUrl = `${baseUrl}/v1/videos/${videoId}`;
        if (isHmStudio) {
          pollUrl = hmStudioTaskUrl(baseUrl, videoId);
        } else if (isWxHaidiYue) {
          pollUrl = wxHaidiYueTaskUrl(baseUrl, videoId);
        } else if (isSudaShui) {
          pollUrl = `${baseUrl}/v1/video/generations/${videoId}`;
        }

        const pollResp = await fetch(pollUrl, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });

        if (!pollResp.ok) {
          const detail = await pollResp.text().catch(() => '');
          const failureMessage = formatVideoPollHttpFailure(pollResp.status, detail);
          console.error(`[video-recover] ${failureMessage}`);
          await failHmQueuedVideo(contentId, new Error(failureMessage));
          break;
        }

        const statusData = await pollResp.json() as any;
        let taskStatus = statusData.status;
        let progress = statusData.progress || 0;
        let resultUrl = '';
        let errMsg = '';

        if (isHmStudio) {
          const normalized = normalizeHmStudioTask(statusData, baseUrl);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || 'HM Studio 视频生成失败';
        } else if (isWxHaidiYue) {
          const normalized = normalizeWxHaidiYueTask(statusData, baseUrl);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || normalized.errorCode || '视频生成失败';
        } else if (isSnumomWan) {
          const normalized = normalizeSnumomWanTask(statusData);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || 'snumom 视频生成失败';
          if ((taskStatus === 'completed' || taskStatus === 'success') && !resultUrl) {
            resultUrl = snumomContentUrl(baseUrl, videoId);
          }
        } else if (isSudaShui) {
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

        if (isVideoFailurePayload(statusData)) {
          taskStatus = 'failed';
          errMsg = extractVideoFailureMessage(statusData) || errMsg || '视频生成失败';
        }

        console.log(`[video-recover] Polling task ${contentId}: status=${taskStatus} progress=${progress}%`);

        if (taskStatus === 'processing' || taskStatus === 'queued' || taskStatus === 'pending' || taskStatus === 'submitted' || taskStatus === 'generating' || taskStatus === 'post_processing' || taskStatus === 'finalizing' || taskStatus === 'in_progress') {
          try {
            const meta = JSON.parse(currentRecord.metadata || '{}');
            meta.progress = progress;
            meta.upstreamStatus = taskStatus;
            if (isHmStudio) {
              const progressText = normalizeHmStudioTask(statusData, baseUrl).progressText;
              if (progressText) meta.progressText = progressText;
            }
            db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
          } catch { }
        } else if (taskStatus === 'completed' || taskStatus === 'success') {
          console.log(`[video-recover] ✅ Generating completed: ${resultUrl}`);
          let finalVideoUrl = '';
          try {
            if (resultUrl && resultUrl.includes('llm.chre3.com')) {
              finalVideoUrl = await localizeChre3Video(resultUrl, videoId, model);
            } else {
              finalVideoUrl = await downloadAndLocalizeVideo(resultUrl, videoId, model, metadata.channelId, metadata.channelApiKeyId);
            }
          } catch (localErr: any) {
            console.error(`[video-recover] VPS localization failed; will retry: ${localErr.message}`);
            continue;
          }

          const completedTime = Date.now();
          const createdTime = new Date(currentRecord.createdAt).getTime();
          const durationMs = (!isNaN(createdTime) && createdTime > 0 && completedTime >= createdTime)
            ? (completedTime - createdTime)
            : (Date.now() - startTime);

          logUsage(record.userId, 'generate_video', undefined, durationMs);
          const cost = Number(record.cost) || PricingService.calculateUsageCost(model, {
            resolution,
            seconds: Number(video_length) || 0,
            count: 1,
          });
          let meta = {};
          try {
            meta = JSON.parse(currentRecord.metadata || '{}');
          } catch { }
          meta = {
            ...meta,
            progress: 100,
            queueStatus: 'completed',
            queuePosition: 0,
            upstreamResultUrl: resultUrl || (meta as any).upstreamResultUrl,
            localizedAt: new Date(completedTime).toISOString(),
            durationMs,
            completedAt: new Date(completedTime).toISOString()
          };
          delete (meta as Record<string, any>).progressText;
          db.update(contents).set({
            status: 'completed',
            resultUrl: finalVideoUrl,
            cost: cost,
            metadata: JSON.stringify(meta)
          }).where(eq(contents.id, contentId)).run();
          break;
        } else if (isVideoFailureStatus(taskStatus)) {
          console.error(`[video-recover] ❌ Generating failed: ${errMsg}`);
          // 任务失败，为预扣费退款并将 cost 清零
          await failHmQueuedVideo(contentId, new Error(errMsg));
          break;
        }
      } catch (err: any) {
        console.warn(`[video-recover] Polling exception: ${err.message}`);
      }
    }

    activePolls.delete(contentId);
    activePollPromises.delete(contentId);
    console.log(`[video-recover] Task ${contentId} polling terminated.`);
  })();
  activePollPromises.set(contentId, pollingPromise);
  return pollingPromise;
}

export function resumeAllPendingVideoTasks() {
  console.log('🔍 [video-recover] Scanning for queued and processing video tasks...');
  try {
    const pendingTasks = db.select().from(contents)
      .where(eq(contents.type, 'video'))
      .all()
      .filter(record => record.status === 'queued' || record.status === 'processing');
    console.log(`🔍 [video-recover] Found ${pendingTasks.length} pending video tasks to recover`);

    pendingTasks.forEach((record: any) => {
      const contentId = record.id;
      let metadata: Record<string, any> = {};
      try { metadata = JSON.parse(record.metadata || '{}'); } catch { }
      const originalChannel = metadata.channelId
        ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null)
        : null;
      if (originalChannel && isHmStudioChannel(originalChannel)) {
        try {
          if (metadata.videoId) adoptHmStudioProcessingContent(contentId, record);
          else enqueueHmStudioVideoContent(contentId);
        } catch (error: any) {
          console.error(`[video-recover] Failed to recover HM Studio task ${contentId}:`, error.message);
        }
      } else if (!activePolls.has(contentId)) {
        resumePollForTask(contentId, record);
      }
    });
  } catch (err: any) {
    console.error('⚠️ [video-recover] Scan pending tasks failed:', err.message);
  }
}

export default router;
