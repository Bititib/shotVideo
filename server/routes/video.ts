import { zonghengProtocol, zonghengProtocolSnapshot, zonghengTaskChannel, v6kQueryRetryDelay, isRetiredZonghengTask, RETIRED_ZONGHENG_MESSAGE } from '../services/zonghengProtocol.js';
import { VideoPollTimeout, withVideoPollDeadline, fetchVideoTaskResponse } from '../services/videoPollDeadline.js';
import { refundConfirmedZonghengVideo } from '../services/zonghengSubmissionResolutionService.js';
import { queryZonghengTask } from '../services/zonghengTaskQueryService.js';
import { publicGenerationEvent, publicGenerationError } from '../../shared/generationMessages.js';
import { generationErrorResponse } from '../middleware/generationErrorResponse.js';
import { canonicalZonghengModelId, ZONGHENG_VIDEO_MODELS, ZONGHENG_MODEL_PREFIX, getZonghengVideoSpec, normalizeZonghengVideoResolution } from '../../shared/zonghengVideo.js';
import { isZonghengChannel, buildZonghengVideoPayload, submitZonghengVideo, ZonghengSubmissionError, zonghengTaskUrl, normalizeZonghengTask, zonghengTaskMetadata } from '../services/zonghengAdapter.js';
import { prepareZonghengMedia, validateZonghengMedia } from '../services/zonghengMediaService.js';
import { patchZonghengTask, reviewZonghengTask, zonghengOrder, recordZonghengSubmissionError } from '../services/zonghengTaskService.js';
import videoQuotes from './videoQuotes.js';
import { assertExpectedVideoCost } from '../services/videoQuoteService.js';
import { resolvePublicModelId } from '../services/publicModelNameService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks, prepareSpecificationReferenceImages } from '../services/specificationGenerationService.js';
import { getModelSpecification, specificationAvailable, selectModelRoutes } from '../services/modelRoutingService.js';
import { specificationRequest } from '../services/specificationGenerationService.js';
import { protectVideoSource } from '../middleware/uploadAccess.js';
import { issueUploadUrl, registerUpload, ownsUpload, uploadPath } from '../services/uploadAccess.js';
import { publishReferenceUrl } from '../services/publicReferenceService.js';
import { prepareHmReferenceImages } from '../services/hmStudioReferenceService.js';
import { canvasRequestMiddleware, recordCanvasEvent } from '../middleware/canvasRequest.js';
import { getEnabledPublicModels } from '../services/modelCatalogService.js';
import { hayaVideoSeconds, HAYA_VIDEO_MODELS, HAYA_XG_SEEDANCE_20_MODEL, getHayaVideoSpec, validateHayaVideoInput } from '../../shared/hayaVideo.js';
import { existingModelLimits } from '../services/modelInputPresets.js';
import { isHayaChannel, hayaTaskUrl, normalizeHayaTask, hayaPollDelay, submitHayaVideo, HayaSubmissionError } from '../services/hayaVideoAdapter.js';
import { prepareHayaMedia, validateHayaMedia } from '../services/hayaMediaService.js';
import { patchHayaTask, reviewHayaTask } from '../services/hayaTaskService.js';
import { Router, Request, Response } from 'express';
import { authMiddleware, optionalAuthMiddleware, type AuthRequest } from '../middleware/auth.js';
import { userModelMiddleware } from '../middleware/userModel.js';
import { filterUserModels } from '../services/userModelAccessService.js';
import { tierMiddleware, TierRequest } from '../middleware/tier.js';
import { quotaMiddleware, logUsage } from '../middleware/quota.js';
import { ChannelService } from '../services/channelService.js';
import { BalanceService, type BalanceDeduction } from '../services/balanceService.js';
import { protectsVideoPolling, noteVideoQueryProblem, clearVideoQueryProblem } from '../services/videoPollingSafety.js';
import { finalizeReservedContent } from '../services/contentBillingService.js';
import { ContentService } from '../services/contentService.js';
import { batchContextForRequest, batchStore, recordBatchFailure, markBatchSubmitting, noteBatchQueryProblem, isBatchChannelAtCapacity } from '../services/videoBatchService.js';
import { guardBatchSubmissionResponse, isBatchQueryUncertain } from '../services/videoBatchStore.js';
import { PricingService } from '../services/pricingService.js';
import { hmStudioPoolKey, hmStudioQueue, type HmStudioQueueSnapshot } from '../services/hmStudioQueueService.js';
import { calculateSuccessRate, isWithinRecentDays } from '../services/successRateService.js';
import { calculateVideoModelStatus } from '../services/videoModelStatusService.js';
import {
  buildHmStudioVideoPayload,
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
  isVideoQueryErrorPayload,
  isVideoFailureStatus,
  isTransientVideoPollHttpStatus,
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
  canonicalSnumomVideoModel,
  extractSnumomTaskId,
  normalizeSnumomWanInputMedia,
  isSnumomWanChannel,
  isSnumomWan30VideoModel,
  normalizeSnumomWanTask,
  SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES,
  SNUMOM_GROK_IMAGINE_VIDEO_MODEL,
  SNUMOM_GROK_IMAGINE_VIDEO_SECONDS,
  SNUMOM_SD_MINI_MAX_IMAGES,
  SNUMOM_SD_MINI_MAX_VIDEOS,
  SNUMOM_SD_MINI_MAX_AUDIOS,
  SNUMOM_SD_MINI_MODEL,
  SNUMOM_SD_MINI_SECONDS,
  snumomSdMiniSecondsForResolution,
  snumomWanBillableSeconds,
  snumomContentUrl,
} from '../services/snumomWanAdapter.js';
import { probeReferenceAudioSeconds, probeReferenceVideoSeconds } from '../services/videoDurationProbe.js';
import { reserveLegacyVideo, finalizeLegacyVideo, failLegacyVideo, markLegacyVideoSubmitting } from '../services/legacyVideoBilling.js';
import { settleDirectVideoBilling, refundUnreservedVideo } from '../services/directVideoBillingService.js';
import { sanitizeUpstreamCreateResponse } from '../services/videoTaskMetadataService.js';
import { submissionFailure, SpecificationUpstreamError } from '../services/specificationAdapters.js';
import { HmSubmissionError, classifyHmSubmission, readHmSubmission, hmSubmissionTransportError } from '../services/hmStudioSubmission.js';
import { videoRequestNotSent, explicitVideoCreateError } from '../services/videoSubmissionErrors.js';
import { isSnumomSubmissionRejection } from '../services/snumomSubmissionRejection.js';
import { readVideoRecoveryState, reviewMissingVideoTaskId, reviewUncertainVideoTask, savedVideoTaskId } from '../services/videoRecoveryState.js';
import { claimVideoSubmission, acceptVideoSubmission, endVideoSubmission, releaseVideoSubmission, videoSubmissionPending, videoSubmissionPreparation } from '../services/videoSubmissionGuard.js';
import { canCancelVideoContent } from '../services/videoCancellationEligibility.js';
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
  getHmStudioAdditionalVideoModel,
  normalizeHmStudioVideoResolution,
  HM_STUDIO_ADDITIONAL_VIDEO_MODELS,
  validateHmStudioAdditionalVideoInput,
} from '../services/hmStudioVideoModels.js';
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
  getSiYueTianSeedance25VideoSpec,
  SI_YUE_TIAN_C2_MODELS,
  getSiYueTianC2Model,
  validateSiYueTianSeedance20C2Input,
  SI_YUE_TIAN_SEEDANCE_25_MAX_AUDIOS,
  SI_YUE_TIAN_SEEDANCE_25_MAX_IMAGES,
  SI_YUE_TIAN_SEEDANCE_25_VIDEO_MODELS,
  SI_YUE_TIAN_SEEDANCE_25_VIDEO_SPECS,
  validateSiYueTianSeedance25VideoInput,
} from '../services/siYueTianVideoModels.js';
import {
  buildWxHaidiYueVideoPayload,
  isWxHaidiYueChannel,
  normalizeWxHaidiYueTask,
  resolveWxHaidiYueFaceSplit,
  validateWxHaidiYueVideoInput,
  wxHaidiYueCreateUrl,
  wxHaidiYueTaskUrl,
  WX_HAIDIYUE_FACE_SPLIT_MODEL,
  WX_HAIDIYUE_FACE_SPLIT_MODEL_NAME,
  WX_HAIDIYUE_MODELS,
  WX_HAIDIYUE_MULTIMODAL_MODEL,
  WX_HAIDIYUE_MULTIMODAL_MODEL_NAME,
} from '../services/wxHaidiYueAdapter.js';
import { prepareWxHaidiYueImageUrls } from '../services/wxHaidiYueImageService.js';
import {
  buildMiaowuVideoPayload,
  isMiaowuChannel,
  MIAOWU_SEEDANCE_25_DEAL_MODEL,
  MIAOWU_SEEDANCE_25_PRO_MODEL,
  miaowuVideoCreateUrl,
  miaowuVideoTaskUrl,
  normalizeMiaowuVideoTask,
  validateMiaowuSeedance25DealInput,
  validateMiaowuSeedance25ProInput,
} from '../services/miaowuVideoAdapter.js';
import { buildLongxiaVideoPayload, isLongxiaChannel, isLongxiaModel, longxiaResolution, LONGXIA_MODELS, LONGXIA_SECONDS, longxiaVideoCreateUrl, longxiaVideoTaskUrl, normalizeLongxiaVideoTask } from '../services/longxiaVideoAdapter.js';
import { prepareMiaowuPublicMediaUrls } from '../services/miaowuMediaService.js';
import { downloadAndLocalizeVideo } from '../services/videoLocalizationService.js';
import { prepareVideoForDelivery, cacheVideoForDelivery, videoDeliveryContentType, videoDeliveryExtension } from '../services/videoCompatibilityService.js';
import { resolveBatchArchiveFile } from '../services/videoBatchArchive.js';
import { validateAndNormalizeImageReferences } from '../services/imageReferenceValidationService.js';
import { validateVideoPrompt } from '../services/videoPromptValidation.js';
import { parseUtcTimestamp } from '../../shared/time.js';
export { downloadAndLocalizeVideo } from '../services/videoLocalizationService.js';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { models, settings, contents } from '../db/schema.js';
import { eq, like, and, inArray, gte, sql } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const router = Router();
router.use(['/generate', '/validate'], generationErrorResponse);
router.use('/quote', videoQuotes);
const VIDEO_MODELS_CACHE_TTL_MS = 15_000;
let videoModelsResponseCache: { expiresAt: number; data: any[] } | null = null;
const HM_STUDIO_VIDEO_MODEL_ORDER = [
  HM_STUDIO_PRIMARY_VIDEO_MODEL,
  ...HM_STUDIO_ADDITIONAL_VIDEO_MODELS.map(model => model.id),
];
const HM_STUDIO_VIDEO_MODEL_RANK = new Map(
  HM_STUDIO_VIDEO_MODEL_ORDER.map((modelId, index) => [modelId, index]),
);

export const activePolls = new Set<number>();
// A live request owns submission as well as polling. Recovery must not adopt it
// while the upstream POST is still waiting to return its task ID.
const liveVideoRequests = new Set<number>();
const hayaLiveRequests = new Set<number>();
const zonghengLiveRequests = new Set<number>();
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
  if (uploadPath(dataUrl)) return issueUploadUrl(dataUrl, process.env.BACKEND_URL || (typeof requestOrBaseUrl === 'string' ? requestOrBaseUrl : `${requestOrBaseUrl.protocol}://${requestOrBaseUrl.get('host')}`));
  if (dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
    return dataUrl;
  }

  const requestBaseUrl = typeof requestOrBaseUrl === 'string'
    ? requestOrBaseUrl
    : `${requestOrBaseUrl.headers['x-forwarded-proto'] || requestOrBaseUrl.protocol}://${requestOrBaseUrl.get('host')}`;
  const baseUrl = process.env.BACKEND_URL || requestBaseUrl;
  if (dataUrl.startsWith('/uploads/')) {
    return baseUrl ? `${baseUrl.replace(/\/+$/, '')}${dataUrl}` : dataUrl;
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
    return issueUploadUrl(`${baseUrl.replace(/\/+$/, '')}/uploads/${filename}`);
  } catch (err: any) {
    console.error('[video] convertBase64ToPublicUrl 失败:', err.message);
    return dataUrl;
  }
}

/**
 * 将参考素材保存为本站公开 URL，供 SudaShui 上游读取
 */
async function uploadToSudaShui(source: string, publicBaseUrl: string): Promise<string> {
  return source ? publishReferenceUrl(source, publicBaseUrl) : '';
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
  ...Object.fromEntries(ZONGHENG_VIDEO_MODELS.map(spec => [ZONGHENG_MODEL_PREFIX + spec.id, { series: 'zongheng', allowedSeconds: [...spec.seconds], requireRef: false }])),
  ...Object.fromEntries(SI_YUE_TIAN_C2_MODELS.map(spec => [spec.id, { series: 'siyuetian-c2', allowedSeconds: Array.from({ length: spec.maxSeconds - spec.minSeconds + 1 }, (_, i) => i + spec.minSeconds), requireRef: false }])),
  ...Object.fromEntries(HAYA_VIDEO_MODELS.map(spec => [spec.id, { series: 'haya', allowedSeconds: hayaVideoSeconds(spec.id), requireRef: false }])),
  ...Object.fromEntries(SI_YUE_TIAN_SEEDANCE_25_VIDEO_SPECS.map(spec => [spec.id, {
    series: `siyuetian-seedance-2.5-${spec.resolution}`,
    allowedSeconds: Array.from({ length: 27 }, (_, index) => index + 4),
    requireRef: false,
  }])),
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
  'td-seedance-2.5-720p': { series: 'mj-seedance-2.5', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'seedance_v2.5': { series: 'hmstudio-seedance-2.5', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  ...Object.fromEntries(HM_STUDIO_ADDITIONAL_VIDEO_MODELS.map(model => [model.id, {
    series: 'hmstudio-seedance',
    allowedSeconds: Array.from({ length: model.maxSeconds - model.minSeconds + 1 }, (_, index) => model.minSeconds + index),
    requireRef: false,
  }])),
  'xd-seedance-2.5-720p': { series: 'mj-seedance-2.5', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'seedance-2.0-fast': { series: 'seedance-fast', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'veo-omni-flash': { series: 'veo-omni-flash', allowedSeconds: [10], requireRef: false },
  'veo-omni-flash-video-edit': { series: 'veo-omni-flash-video-edit', allowedSeconds: [10], requireRef: false },
  'veo-3-1': { series: 'veo-3-1', allowedSeconds: [8], requireRef: false },
  'seedance-2.0': { series: 'seedance-2.0', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sd2-c7': { series: 'sd2-c7', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  [SI_YUE_TIAN_PRIMARY_VIDEO_MODEL]: { series: 'sd2.5-legacy', allowedSeconds: [30], requireRef: false },
  [WX_HAIDIYUE_FACE_SPLIT_MODEL]: { series: 'wx-haidiyue-sd2.5', allowedSeconds: [30], requireRef: false },
  [WX_HAIDIYUE_MULTIMODAL_MODEL]: { series: 'wx-haidiyue-2.5-s', allowedSeconds: [30], requireRef: false },
  'seedance-2.0-720p': { series: 'seedance-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance-2.0-fast-720p': { series: 'seedance-fast-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance-720': { series: 'seedance-720p', allowedSeconds: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'sd2-mini': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance2.0-933': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'seedance2.0 933': { series: 'seedance-720p', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], requireRef: false },
  'grok-video-1.5（按秒）': { series: 'grok-1.5', allowedSeconds: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  [SNUMOM_GROK_IMAGINE_VIDEO_MODEL]: { series: 'snumom-grok-1.5', allowedSeconds: SNUMOM_GROK_IMAGINE_VIDEO_SECONDS, requireRef: false },
  [SNUMOM_SD_MINI_MODEL]: { series: 'snumom-sd-mini', allowedSeconds: [...SNUMOM_SD_MINI_SECONDS], requireRef: false },
  'grok-imagine-video-1.5-preview': { series: 'grok-1.5', allowedSeconds: [10, 15], requireRef: false },
  [MIAOWU_SEEDANCE_25_DEAL_MODEL]: { series: 'miaowu-seedance-2.5', allowedSeconds: Array.from({ length: 26 }, (_, index) => index + 5), requireRef: false },
  ...Object.fromEntries(LONGXIA_MODELS.map(model => [model, { series: 'longxia-seedance-2.5', allowedSeconds: LONGXIA_SECONDS, requireRef: false }])),
  [MIAOWU_SEEDANCE_25_PRO_MODEL]: { series: 'miaowu-seedance-2.5', allowedSeconds: Array.from({ length: 27 }, (_, index) => index + 4), requireRef: false },
  'seedance-2.5m': { series: 'seedance-2.5', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25], requireRef: false },
  'wan3.0th': { series: 'wan3.0', allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'wan3.0-video': { series: 'snumom-wan3.0', allowedSeconds: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  'wan3.0-video-prime': { series: 'snumom-wan3.0', allowedSeconds: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], requireRef: false },
  [JULUN_MINIMAX_H3_MODEL]: { series: 'julun-minimax-h3', allowedSeconds: [10, 15], requireRef: false },
};

const DEFAULT_VIDEO_MODELS = [
  ...ZONGHENG_VIDEO_MODELS.map(spec => ({ id: ZONGHENG_MODEL_PREFIX + spec.id, name: '纵横科技 · ' + spec.id, description: spec.resolution + '；' + spec.seconds.join('、') + '秒', maxSeconds: spec.seconds[spec.seconds.length - 1], icon: '🎬' })),
  ...SI_YUE_TIAN_C2_MODELS.map(spec => ({ id: spec.id, name: `${spec.name} · 四月天`, description: `最多${spec.images}图、${spec.videos}视频、${spec.audios}音频；按次计费`, maxSeconds: spec.maxSeconds, icon: '🎬' })),
  ...SI_YUE_TIAN_SEEDANCE_25_VIDEO_SPECS.map(spec => ({
    id: spec.id,
    name: `Seedance 2.5 ${spec.resolution} · 四月天`,
    description: `四月天线路；4-30秒；最多30图、0视频、10音频；¥${spec.price}/次`,
    maxSeconds: 30,
    icon: '🎬',
  })),
  { id: 'seedance_v2.5', name: 'HM-Seedance V2.5', description: '720p；支持4-30秒；最多10张图片参考，不支持音频和视频参考', maxSeconds: 30, icon: '🎬' },
  ...HM_STUDIO_ADDITIONAL_VIDEO_MODELS.map(model => ({
    id: model.id,
    name: model.displayName,
    description: model.description,
    maxSeconds: model.maxSeconds,
    icon: '🎬',
  })),
  { id: 'ad-seedance-2.5-480p', name: 'Seedance 2.5 480p（AD）', description: '支持最多30张图片、10个视频、10段音频参考，不限制人脸，按秒计费 ¥0.35/秒', maxSeconds: 30, icon: '🎬' },
  { id: 'vd-seedance-2.5-480p', name: 'Seedance 2.5 480p（VD）', description: '过真人，支持9图3视频0音频，4-30秒，按秒计费 ¥0.25/秒', maxSeconds: 30, icon: '🎬' },
  { id: 'vd-seedance-2.5-720p', name: 'Seedance 2.5 720p（VD）', description: '过真人，支持9图3视频0音频，4-30秒，按秒计费 ¥0.30/秒', maxSeconds: 30, icon: '🎬' },
  { id: 'td-seedance-2.5-720p', name: 'Seedance 2.5 720p（TD）', description: '支持4-30秒、30图10视频10音频参考，固定720p，按次计费；售价以后台统一计费设置为准', maxSeconds: 30, icon: '🎬' },
  { id: 'wan3.0th', name: 'Wan 3.0 视频大模型 (wan3.0th)', description: '按秒计费，¥0.14/秒；720p；支持4-30秒文生视频和多参考视频；最多10张图片、5个视频、5段音频公网URL，音频仅支持WAV；支持1:1、16:9、9:16、4:3、3:4', maxSeconds: 30, icon: '🌟' },
  { id: 'wan3.0-video', name: 'Wan 3.0 Video（标准版）', description: '支持 2-30 秒、480P/720P/1080P；最多 10 图、5 视频、5 音频参考；参考视频时长计入计费秒数', maxSeconds: 30, icon: '🌊' },
  { id: 'wan3.0-video-prime', name: 'Wan 3.0 Video Prime（高速版）', description: '生成速度更快；支持 2-30 秒、480P/720P/1080P；最多 10 图、5 视频、5 音频参考；参考视频时长计入计费秒数', maxSeconds: 30, icon: '⚡' },
  { id: SNUMOM_GROK_IMAGINE_VIDEO_MODEL, name: 'Grok Imagine Video 1.5', description: '支持 1-15 秒、480P/720P；最多 7 张参考图；不支持参考视频或音频；按次计费 ¥0.60/次', maxSeconds: 15, icon: '✕' },
  { id: SNUMOM_SD_MINI_MODEL, name: 'Seedance 2.0 Mini', description: '支持 9 图、3 视频、3 音频参考，不卡脸；480p 支持 15 秒，720p 仅支持 10 秒；按次计费 ¥0.60/次', maxSeconds: 15, icon: 'SD' },
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
  { id: 'seedance-2.0', name: 'Seedance 2.0', description: 'Seedance 2.0 文生/图生视频，支持720p，支持图片参考，4-15秒，固定按次计费 ¥1.50/次', maxSeconds: 15, icon: '🎬' },
  { id: MIAOWU_SEEDANCE_25_DEAL_MODEL, name: 'Seedance 2.5 Deal', description: '喵呜 API；支持5-30秒、480p/720p；最多30张图片和10段音频参考，不支持视频参考；按次计费', maxSeconds: 30, icon: '🎬' },
  { id: MIAOWU_SEEDANCE_25_PRO_MODEL, name: 'Seedance 2.5 Pro', description: '喵呜 API；支持4-30秒、480p/720p；最多30张图片、10个视频和10段音频参考；参考视频时长不得超过输出时长；按秒计费', maxSeconds: 30, icon: '🎬' },
  { id: WX_HAIDIYUE_FACE_SPLIT_MODEL, name: WX_HAIDIYUE_FACE_SPLIT_MODEL_NAME, description: '支持真人；固定30秒；最多9张参考图；固定按次计费 ¥2.00/次', maxSeconds: 30, icon: '👤' },
  { id: WX_HAIDIYUE_MULTIMODAL_MODEL, name: WX_HAIDIYUE_MULTIMODAL_MODEL_NAME, description: '海底月多模态模型；固定30秒；最多30图、10视频、10音频；固定按次计费 ¥6.00/次', maxSeconds: 30, icon: '🎬' },
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
    faceSplitEnabled: channel.faceSplitEnabled,
  };
  return null;
}

/**
 * 自动将 Grok 视频下载并本地化保存到 `data/uploads` 目录中，防止上游链接失效或鉴权失败
 */
export async function downloadAndLocalizeGrokVideo(url: string, videoId: string, model: string): Promise<string> {
  return downloadAndLocalizeVideo(url, videoId, model);
}

/**
 * 将 4月天渠道 (llm.chre3.com) 的 H.265 视频下载、转码为 H.264 并本地化保存。
 * 使用 UUID 唯一临时文件名，防止并发冲突；转码完成后原子 rename 交付。
 */
export async function localizeChre3Video(url: string, videoId: string, model: string): Promise<string> {
  return downloadAndLocalizeVideo(url, videoId, model);
}
/** GET /api/video/models — 可用的视频模型列表（公开，不需要登录） */
router.get('/models', optionalAuthMiddleware, (req: AuthRequest, res: Response) => {
  if (req.userId) res.setHeader('Cache-Control', 'private, no-store');
  if (!req.userId && env.NODE_ENV === 'production' && videoModelsResponseCache?.expiresAt > Date.now()) {
    res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    return res.json(videoModelsResponseCache.data);
  }

  const publicSourceModels = filterUserModels(req.userId, getEnabledPublicModels('video'))
    .map(m => ({ id: m.modelId, name: m.displayName, description: m.description }));

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
  const quotePrice = PricingService.createQuoteResolver(false, req.userId ?? null);
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
        id: contents.id,
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
    const managedSpec = getModelSpecification(m.id);
    const preset = DEFAULT_VIDEO_MODELS.find(d => d.id === m.id);
    const meta = MODEL_META[m.id];
    const multiplier = meta?.series === '1.5' ? 1.2 : 1.0;

    let rates: Record<string, number>;
    const siYueTianSeedance25Spec = getSiYueTianSeedance25VideoSpec(m.id);
    if (siYueTianSeedance25Spec) {
      rates = {
        [siYueTianSeedance25Spec.resolution]: quotePrice(m.id, { resolution: siYueTianSeedance25Spec.resolution }).rate,
      };
    } else if (isLongxiaModel(m.id)) {
      const resolution = longxiaResolution(m.id);
      rates = { [resolution]: quotePrice(m.id, { resolution, seconds: 1 }).rate };
    } else if (m.id === 'sora-v4-fast') {
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
    } else if (m.id === SI_YUE_TIAN_PRIMARY_VIDEO_MODEL) {
      const rate = settingNumber('sd2_5_rate', '3.50');
      rates = {
        '720p': rate,
      };
    } else if (WX_HAIDIYUE_MODELS.includes(m.id as typeof WX_HAIDIYUE_MODELS[number])) {
      rates = {
        '720p': quotePrice(m.id, { resolution: '720p' }).rate,
      };
    } else if (m.id === 'sd2-mini') {
      const rate = settingNumber('sd2_mini_rate', '2.00');
      rates = {
        '720p': rate,
      };
    } else if (getSiYueTianC2Model(m.id)) {
      rates = { '720p': quotePrice(m.id, { resolution: '720p' }).rate };
    } else if (m.id === 'seedance-2.0') {
      const rate = settingNumber('seedance_2_0_rate', '1.50');
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
    } else if (m.id === 'seedance_v2.5' || getHmStudioAdditionalVideoModel(m.id)) {
      const spec = getHmStudioAdditionalVideoModel(m.id);
      rates = Object.fromEntries((spec?.resolutions || [spec?.resolution || '720p']).map(resolution => [
        resolution, quotePrice(m.id, { resolution }).rate,
      ]));
    } else if (m.id === 'td-seedance-2.5-720p' || m.id === 'xd-seedance-2.5-720p') {
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
    } else if (m.id === SNUMOM_SD_MINI_MODEL) {
      const rate = quotePrice(m.id, { resolution: '720p', seconds: 10 }).rate;
      rates = { '480p': rate, '720p': rate };
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
    const configuredResolutions = getZonghengVideoSpec(m.id) ? [getZonghengVideoSpec(m.id)!.resolution] : getHayaVideoSpec(m.id) ? [getHayaVideoSpec(m.id)!.resolution] : Object.keys(rates).length > 0 ? Object.keys(rates) : ['720p'];
    rates = Object.fromEntries(configuredResolutions.map(resolution => [
      resolution,
      quotePrice(m.id, { resolution }).rate,
    ]));

    const targetIds = statsTargetIds(m.id);
    const modelRecentRows = targetIds.flatMap(targetId => recentRowsByModel.get(targetId) || []);
    const successCalls = modelRecentRows.filter(r => r.status === 'completed' || r.status === 'success' || Boolean(r.resultUrl?.trim())).length;
    const failureCalls = modelRecentRows.filter(r => r.status === 'failed').length;
    const successStats = calculateSuccessRate(successCalls, failureCalls);
    const available = managedSpec ? specificationAvailable(managedSpec) : findVideoChannel(m.id, activeVideoChannels) !== null
      || (m.id === HM_STUDIO_PRIMARY_VIDEO_MODEL && hmStudioOverflowAvailable);

    return {
      id: m.id,
      name: m.name || preset?.name || m.id,
      description: m.description || preset?.description || 'AI 视频生成服务',
      available,
      modelStatus: calculateVideoModelStatus(recentRowsByModel.get(m.id) || [], available),
      routingLimits: managedSpec?.limits ?? (m.id === HAYA_XG_SEEDANCE_20_MODEL ? existingModelLimits(m.id, 'video') : undefined),
      maxSeconds: managedSpec?.limits.duration.max ?? preset?.maxSeconds,
      allowedSeconds: managedSpec ? managedSpec.limits.duration.mode === 'fixed' ? [managedSpec.limits.duration.min] : managedSpec.limits.duration.mode === 'options' ? managedSpec.limits.duration.values : Array.from({ length: Math.floor((managedSpec.limits.duration.max - managedSpec.limits.duration.min) / managedSpec.limits.duration.step) + 1 }, (_, index) => managedSpec.limits.duration.min + index * managedSpec.limits.duration.step) : meta?.allowedSeconds || null,
      requireRef: meta?.requireRef || false,
      series: meta?.series || 'legacy',
      rates: managedSpec ? Object.fromEntries(managedSpec.limits.resolutions.map(r => [r, quotePrice(m.id, { resolution: r }).rate])) : rates,
      billingType,
      successRate: successStats.rate,
      successRateEstimated: successStats.estimated,
      totalCalls: successStats.sampleSize,
    };
  });

  const availableModels = result.filter(m => m.available || Boolean(m.routingLimits)).sort((left, right) => {
    const leftRank = HM_STUDIO_VIDEO_MODEL_RANK.get(left.id);
    const rightRank = HM_STUDIO_VIDEO_MODEL_RANK.get(right.id);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return 0;
  });
  if (!req.userId && env.NODE_ENV === 'production') {
    videoModelsResponseCache = {
      expiresAt: Date.now() + VIDEO_MODELS_CACHE_TTL_MS,
      data: availableModels,
    };
    res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
  }
  res.json(availableModels);
});

/** POST /api/video/generate — SSE 流式视频生成（异步轮询模式） */
router.post(['/generate', '/validate'], authMiddleware, canvasRequestMiddleware, tierMiddleware('video'), userModelMiddleware('nd-seedance-2.0-720p'), quotaMiddleware, async (req: TierRequest, res: Response) => {
  let batchContext: ReturnType<typeof batchContextForRequest> = null;
  try {
    batchContext = batchContextForRequest(req);
    if (batchContext) req.body = batchContext.body;
  } catch (error: any) { return res.status(409).json({ error: error.message }); }
  if (req.path === '/validate' && getModelSpecification(resolvePublicModelId(req.body?.model || ''))) {
    try { const spec = getModelSpecification(resolvePublicModelId(req.body.model))!;
      const body = { ...req.body, resolution: req.body.resolution || spec.limits.resolutions[0], video_length: req.body.video_length ?? req.body.seconds ?? req.body.duration ?? (spec.limits.duration.mode === 'options' ? spec.limits.duration.values[0] : spec.limits.duration.min) };
      const origin = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
      const request = specificationRequest(body, 'video', origin), input = request.input;
      const candidates = selectModelRoutes(spec, input); const quote = PricingService.quote(spec.modelId, { resolution: input.resolution, seconds: input.seconds, count: 1 }, false, req.userId);
      if (!quote.billingType) throw Object.assign(new Error('该规格尚未配置用户售价'), { status: 400 });
      if (candidates.some(target => isHmStudioChannel(target.channel))) await prepareSpecificationReferenceImages(request, candidates, [origin]);
      return res.status(candidates.length ? 200 : 503).json(candidates.length ? { valid: true, unitCost: quote.cost,
        reference_images: request.images, first_frame: request.firstFrame, last_frame: request.lastFrame,
        pricingSnapshot: quote.pricingSnapshot } : { error: '没有匹配线路' });
    } catch (e: any) { return res.status(e.status || 400).json({ error: e.message }); }
  }
  if (await handleSpecificationGeneration(req, res, 'video')) return;
  if (typeof req.body?.model === 'string') req.body.model = canonicalSnumomVideoModel(canonicalZonghengModelId(req.body.model));
  if (isSnumomWan30VideoModel(req.body?.model)) {
    const durations = [req.body.video_length, req.body.seconds, req.body.duration, req.body.parameters?.duration, req.body.duration_seconds]
      .filter(value => value !== undefined).map(Number);
    if (durations.some(value => !Number.isFinite(value)) || new Set(durations).size > 1) {
      return res.status(400).json({ error: '视频时长参数必须是有效数字且保持一致' });
    }
    if (durations.length) req.body.video_length = durations[0];
  }
  const {
    prompt,
    model = 'nd-seedance-2.0-720p',
    aspect_ratio = '16:9',
    video_length = getZonghengVideoSpec(model)?.seconds[0] || 6,
    resolution: requestedResolution,
    reference_images: rawReferenceImages = [],   // base64 dataURL 数组
    reference_videos = [],   // 新多视频数组字段
    reference_video = '',    // 旧单值兼容字段
    audio_urls = [],         // 新多音频数组字段
    audio_url = '',          // 旧单值兼容字段
    first_frame: rawFirstFrame = '',
    last_frame: rawLastFrame = '',
    face,                    // HM Studio 旧版兼容字段
    face_processing,         // 旧版兼容字段；HM 本站处理全局关闭，上游 face 始终开启
    face_split,              // 海底月参考图人脸拆分（仅实际路由到海底月时发送）
    local_face_processed = false, // 已由浏览器完成眼嘴拆分，避免上游再次处理
    compliance_enabled,      // 是否开启合规素材/过人脸
    compliance_mode,         // 合规素材风格
  } = req.body;
  let reference_images: string[] = Array.isArray(rawReferenceImages) ? rawReferenceImages : [];
  let first_frame = rawFirstFrame, last_frame = rawLastFrame;
  const resolution = normalizeZonghengVideoResolution(model, requestedResolution) || normalizeHmStudioVideoResolution(model, requestedResolution) || requestedResolution || getHayaVideoSpec(model)?.resolution || (isLongxiaModel(model) ? longxiaResolution(model) : undefined) || (isJulunMinimaxH3Model(model) ? JULUN_MINIMAX_H3_RESOLUTION : '720p');

  // 向后兼容：合并旧单值字段到新数组
  const finalVideos: string[] = (Array.isArray(reference_videos) && reference_videos.length > 0)
    ? reference_videos
    : (reference_video ? [reference_video] : []);
  const finalAudios: string[] = (Array.isArray(audio_urls) && audio_urls.length > 0)
    ? audio_urls
    : (audio_url ? [audio_url] : []);
  let snumomInputMedia: Array<{ type: 'file' | 'link'; url: string }> = [];
  let snumomPromptExtend: boolean | undefined;
  if (model === 'wan3.0-video' || model === 'wan3.0-video-prime') {
    try { snumomInputMedia = normalizeSnumomWanInputMedia(req.body?.input?.media); }
    catch (error: any) { return res.status(400).json({ error: error.message }); }
    const promptExtend = req.body?.parameters?.prompt_extend ?? req.body?.prompt_extend;
    if (promptExtend !== undefined && typeof promptExtend !== 'boolean') {
      return res.status(400).json({ error: 'prompt_extend 必须是布尔值' });
    }
    snumomPromptExtend = promptExtend;
  }

  const promptValidationError = validateVideoPrompt(prompt);
  if (promptValidationError) {
    return res.status(400).json({ error: promptValidationError });
  }

  if (model === MJ_OVERFLOW_VIDEO_MODEL) {
    return res.status(404).json({ error: '该模型不可直接调用' });
  }

  const meta = MODEL_META[model];
  const c2Error = validateSiYueTianSeedance20C2Input(model, reference_images.length, finalVideos.length, finalAudios.length);
  if (c2Error) return res.status(400).json({ error: c2Error });
  if (getSiYueTianC2Model(model) && resolution !== '720p') {
    return res.status(400).json({ error: `${model} 仅支持720p` });
  }

  const siYueTianSeedance25ValidationError = validateSiYueTianSeedance25VideoInput(model, {
    seconds: Number(video_length),
    resolution,
    imageCount: reference_images.length,
    videoCount: finalVideos.length,
    audioCount: finalAudios.length,
  });
  if (siYueTianSeedance25ValidationError) {
    return res.status(400).json({ error: siYueTianSeedance25ValidationError });
  }

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

  if (isLongxiaModel(model)) {
    try {
      buildLongxiaVideoPayload({ model, prompt, seconds: Number(video_length), ratio: aspect_ratio, resolution,
        imageUrls: reference_images, videoUrls: finalVideos, audioUrls: finalAudios, firstFrame: first_frame, lastFrame: last_frame });
    } catch (error: any) { return res.status(400).json({ error: error.message }); }
  }

  if (model === MIAOWU_SEEDANCE_25_DEAL_MODEL) {
    const validationError = validateMiaowuSeedance25DealInput({
      seconds: Number(video_length),
      resolution,
      imageCount: reference_images.length,
      videoCount: finalVideos.length,
      audioCount: finalAudios.length,
    });
    if (validationError) return res.status(400).json({ error: validationError });
  }

  if (model === MIAOWU_SEEDANCE_25_PRO_MODEL) {
    const validationError = validateMiaowuSeedance25ProInput({
      seconds: Number(video_length),
      resolution,
      imageCount: reference_images.length,
      videoCount: finalVideos.length,
      audioCount: finalAudios.length,
    });
    if (validationError) return res.status(400).json({ error: validationError });
  }

  const hmStudioAdditionalValidationError = validateHmStudioAdditionalVideoInput(model, {
    seconds: Number(video_length),
    resolution,
    imageCount: reference_images.length,
    videoCount: finalVideos.length,
    audioCount: finalAudios.length,
    hasFirstFrame: Boolean(first_frame),
    hasLastFrame: Boolean(last_frame),
  });
  if (hmStudioAdditionalValidationError) {
    return res.status(400).json({ error: hmStudioAdditionalValidationError });
  }

  if (model === 'td-seedance-2.5-720p') {
    if (resolution !== '720p') return res.status(400).json({ error: 'td-seedance-2.5-720p 仅支持 720p' });
    if (reference_images.length > 30) return res.status(400).json({ error: 'td-seedance-2.5-720p 最多支持 30 张参考图片' });
    if (finalVideos.length > 10) return res.status(400).json({ error: 'td-seedance-2.5-720p 最多支持 10 个参考视频' });
    if (finalAudios.length > 10) return res.status(400).json({ error: 'td-seedance-2.5-720p 最多支持 10 段参考音频' });
  }

  if (model === SI_YUE_TIAN_PRIMARY_VIDEO_MODEL) {
    if (Number(video_length) !== 30) return res.status(400).json({ error: 'sd2.5 固定支持 30 秒' });
    if (resolution !== '720p') return res.status(400).json({ error: 'sd2.5 仅支持 720p' });
    if (reference_images.length > 9) return res.status(400).json({ error: 'sd2.5 最多支持 9 张参考图片' });
    if (finalVideos.length > 0 || finalAudios.length > 0) {
      return res.status(400).json({ error: 'sd2.5 不支持视频或音频参考' });
    }
  }

  const wxHaidiYueValidationError = validateWxHaidiYueVideoInput(model, {
    seconds: Number(video_length),
    resolution,
    ratio: aspect_ratio,
    imageCount: reference_images.length,
    videoCount: finalVideos.length,
    audioCount: finalAudios.length,
    hasFirstFrame: Boolean(first_frame),
    hasLastFrame: Boolean(last_frame),
  });
  if (wxHaidiYueValidationError) return res.status(400).json({ error: wxHaidiYueValidationError });

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
    const wanRatios = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
    const smartDuration = model === 'wan3.0-video' && Number(video_length) === -1;
    if (!wanRatios.includes(aspect_ratio)) return res.status(400).json({ error: `${model} 不支持比例 ${aspect_ratio}` });
    if (!['480p', '720p', '1080p'].includes(String(resolution).toLowerCase())) {
      return res.status(400).json({ error: `${model} 仅支持 480p、720p、1080p` });
    }
    if (reference_images.length > 10) return res.status(400).json({ error: `${model} 最多支持 10 张参考图片` });
    if (finalVideos.length > 5) return res.status(400).json({ error: `${model} 最多支持 5 个参考视频` });
    if (finalAudios.length > 5) return res.status(400).json({ error: `${model} 最多支持 5 段参考音频` });
    if (Number(video_length) === -1 && !smartDuration) return res.status(400).json({ error: `${model} 不支持智能时长 -1` });
    if (smartDuration && finalVideos.length === 0) return res.status(400).json({ error: 'wan3.0-video 智能时长 -1 必须提供参考视频' });
    if (snumomInputMedia.length > 0 && (first_frame || last_frame)) return res.status(400).json({ error: '文档/网页参考不能与首帧或尾帧混用' });
    if (reference_images.length + finalVideos.length + finalAudios.length + snumomInputMedia.length > 20) {
      return res.status(400).json({ error: `${model} 参考素材总数最多 20 个` });
    }
  }

  if (model === SNUMOM_GROK_IMAGINE_VIDEO_MODEL) {
    if (reference_images.length + (first_frame ? 1 : 0) > SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES) {
      return res.status(400).json({ error: `${model} 最多支持 ${SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES} 张参考图片` });
    }
    if (finalVideos.length > 0 || finalAudios.length > 0) return res.status(400).json({ error: `${model} 不支持参考视频或参考音频` });
    if (last_frame) return res.status(400).json({ error: `${model} 不支持尾帧参考` });
    if (first_frame && reference_images.length > 0) return res.status(400).json({ error: `${model} 的首帧图不能与普通参考图混用` });
  }

  if (model === SNUMOM_SD_MINI_MODEL) {
    const requiredSeconds = snumomSdMiniSecondsForResolution(resolution);
    if (requiredSeconds === null) {
      return res.status(400).json({ error: `${model} 仅支持 480p 或 720p` });
    }
    if (Number(video_length) !== requiredSeconds) {
      return res.status(400).json({ error: `${model} 使用 ${String(resolution).toLowerCase()} 时仅支持 ${requiredSeconds} 秒` });
    }
    if (reference_images.length > SNUMOM_SD_MINI_MAX_IMAGES) {
      return res.status(400).json({ error: `${model} 最多支持 ${SNUMOM_SD_MINI_MAX_IMAGES} 张参考图片` });
    }
    if (finalVideos.length > SNUMOM_SD_MINI_MAX_VIDEOS) return res.status(400).json({ error: `${model} 最多支持 ${SNUMOM_SD_MINI_MAX_VIDEOS} 个参考视频` });
    if (finalAudios.length > SNUMOM_SD_MINI_MAX_AUDIOS) return res.status(400).json({ error: `${model} 最多支持 ${SNUMOM_SD_MINI_MAX_AUDIOS} 段参考音频` });
    if (first_frame || last_frame) return res.status(400).json({ error: `${model} 不支持首尾帧参考` });
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
  const smartSnumomDuration = model === 'wan3.0-video' && Number(video_length) === -1;
  if (meta?.allowedSeconds && !smartSnumomDuration && !meta.allowedSeconds.includes(Number(video_length))) {
    return res.status(400).json({ error: `模型 ${model} 只支持 ${meta.allowedSeconds.join('/')} 秒` });
  }

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
    if (reference_images.length > 0 || finalVideos.length > 0 || finalAudios.length > 0 || snumomInputMedia.length > 0) {
      return res.status(400).json({ error: 'snumom 首帧/尾帧不能与普通参考图、视频、音频或文档/网页混用' });
    }
    if (last_frame && !first_frame) {
      return res.status(400).json({ error: '使用尾帧时必须同时提供首帧' });
    }
  }



  // Finish HM image preparation before any reservation/task/queue creation.
  try {
    const requestOrigin = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    if (isHmStudioChannel(channel)) {
      const count = reference_images.length;
      const prepared = await prepareHmReferenceImages([
        ...reference_images, ...(first_frame ? [first_frame] : []), ...(last_frame ? [last_frame] : []),
      ], process.env.BACKEND_URL || requestOrigin, [requestOrigin]);
      reference_images = prepared.slice(0, count);
      if (last_frame) last_frame = prepared[count + Number(Boolean(first_frame))];
      if (first_frame) first_frame = prepared[count];
    } else {
      reference_images = await validateAndNormalizeImageReferences(reference_images, {
        trustedOrigins: [requestOrigin, process.env.BACKEND_URL || ''],
        trustedRemoteOrigins: (process.env.REFERENCE_IMAGE_REMOTE_ORIGINS || 'https://filer2.fdai.xyz').split(/[\s,]+/).filter(Boolean),
      });
    }
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
  if (isZonghengChannel(channel)) {
    try {
      buildZonghengVideoPayload({ model: upstreamModel, prompt, seconds: Number(video_length), ratio: aspect_ratio, resolution,
        images: reference_images, videos: finalVideos, audios: finalAudios, firstFrame: first_frame, lastFrame: last_frame,
        quality: req.body.quality, negativePrompt: req.body.negative_prompt, generateAudio: req.body.generate_audio }, zonghengProtocol(channel));
      const options = { baseUrl: channel.baseUrl, apiKey: channel.apiKey, publicBaseUrl: process.env.BACKEND_URL || req.protocol + '://' + req.get('host') };
      await validateZonghengMedia([...reference_images, first_frame, last_frame].filter(Boolean), 'image', options);
      await validateZonghengMedia(finalVideos, 'video', options);
      await validateZonghengMedia(finalAudios, 'audio', options);
    } catch (error: any) { return res.status(400).json({ error: error.message }); }
  }
  if (isHayaChannel(channel)) {
    const error = validateHayaVideoInput(upstreamModel, { seconds: Number(video_length), resolution, ratio: aspect_ratio,
      imageCount: reference_images.length, videoCount: finalVideos.length, audioCount: finalAudios.length, firstFrame: first_frame, lastFrame: last_frame });
    if (error) return res.status(400).json({ error });
    try {
      const options = { baseUrl: channel.baseUrl, apiKey: channel.apiKey,
        publicBaseUrl: process.env.BACKEND_URL || req.protocol + '://' + req.get('host') };
      await validateHayaMedia(reference_images, 'image', options);
      await validateHayaMedia(finalVideos, 'video', options);
      await validateHayaMedia(finalAudios, 'audio', options);
    } catch (error: any) { return res.status(400).json({ error: error.message }); }
  }

  let referenceVideoDurations: number[] = [];
  let referenceVideoRawDurations: number[] = [];
  let referenceVideoSeconds = 0;
  let referenceAudioDurations: number[] = [];
  let referenceAudioRawDurations: number[] = [];
  let referenceAudioSeconds = 0;
  let billingOutputSeconds = Number(video_length);
  if (isSnumomWanChannel(channel) && isSnumomWan30VideoModel(model) && finalVideos.length > 0) {
    try {
      const probed = await probeReferenceVideoSeconds(finalVideos);
      referenceVideoRawDurations = probed.rawDurations;
      referenceVideoDurations = probed.durations;
      referenceVideoSeconds = probed.total;
      if (smartSnumomDuration) billingOutputSeconds = referenceVideoDurations[0];
      if (referenceVideoDurations.some(seconds => seconds < 1 || seconds > 15) || referenceVideoSeconds > 15) {
        return res.status(400).json({ error: 'Wan 3.0 参考视频单段须为 1-15 秒，合计不能超过 15 秒' });
      }
      if (billingOutputSeconds + referenceVideoSeconds > 30) {
        return res.status(400).json({ error: 'Wan 3.0 输出时长与参考视频总时长合计不能超过 30 秒' });
      }
    } catch (error: any) {
      return res.status(400).json({ error: `无法探测参考视频时长：${error?.message || '未知错误'}` });
    }
  }
  if (isSnumomWanChannel(channel) && isSnumomWan30VideoModel(model) && finalAudios.length > 0) {
    try {
      const probed = await probeReferenceAudioSeconds(finalAudios);
      referenceAudioRawDurations = probed.rawDurations;
      referenceAudioDurations = probed.durations;
      referenceAudioSeconds = probed.total;
      if (referenceAudioSeconds > 15) return res.status(400).json({ error: 'Wan 3.0 参考音频总时长不能超过 15 秒' });
    } catch (error: any) {
      return res.status(400).json({ error: `无法探测参考音频时长：${error?.message || '未知错误'}` });
    }
  }
  const billableSeconds = snumomWanBillableSeconds(model, billingOutputSeconds, referenceVideoSeconds);

  // Reuse exactly the same model/material checks before a batch is charged.
  if (req.path === '/validate') {
    const quote = PricingService.quote(model, { resolution, seconds: billableSeconds, count: 1 }, false, req.userId);
    if (!['per_call', 'per_second'].includes(quote.billingType || '') || !Number.isFinite(quote.cost) || quote.cost < 0) return res.status(400).json({ error: '该模型未配置有效价格' });
    return res.json({ unitCost: quote.cost, resolution, reference_images, first_frame, last_frame, pricingSnapshot: quote.pricingSnapshot });
  }
  if (batchContext && isBatchChannelAtCapacity(channel)) {
    return res.status(429).json({ code: 'BATCH_CAPACITY', error: '渠道正在忙，任务保持排队，不重新扣费' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let resumeAfterPollTimeout = false;
  let contentId: number | null = null;
  const sendEvent = (data: Record<string, any>) => {
    if (contentId !== null) data = { ...data, canCancel: canCancelVideoContent(db.select().from(contents).where(eq(contents.id, contentId)).get()) };
    recordCanvasEvent(req, data);
    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(publicGenerationEvent(data))}\n\n`);
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
  } else if (model === 'seedance-2.0') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_rate')).get();
    rate = parseFloat(row?.value || '1.50');
  } else if (model === 'sora-v4-pro') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'sd2-c7') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_c7_rate')).get();
    rate = parseFloat(row?.value || '0.50');
  } else if (model === SI_YUE_TIAN_PRIMARY_VIDEO_MODEL) {
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
    'seedance-2.0',
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
    'ad-seedance-2.5-480p',
    'xd-seedance-2.5-720p',
    ...SI_YUE_TIAN_SEEDANCE_25_VIDEO_MODELS,
  ].includes(model);
  const outputSeconds = Number.isFinite(billingOutputSeconds) && billingOutputSeconds > 0 ? billingOutputSeconds : 6;
  const estimatedSeconds = snumomWanBillableSeconds(model, outputSeconds, referenceVideoSeconds);
  const pricingUsage = { resolution, seconds: estimatedSeconds, count: 1 };
  const unifiedQuote = batchContext?.pricingSnapshot ? { ...PricingService.quoteSnapshot(batchContext.pricingSnapshot, pricingUsage), pricingSnapshot: batchContext.pricingSnapshot }
    : PricingService.quote(model, pricingUsage, false, req.userId);
  if (!['per_call', 'per_second'].includes(unifiedQuote.billingType || '')) {
    sendEvent({ type: 'error', message: `模型 ${model} 尚未在计费设置中配置价格` });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  try { if (!batchContext) assertExpectedVideoCost(req.body, unifiedQuote.cost); } catch (error: any) { sendEvent({ type: 'error', message: error.message }); res.write('data: [DONE]\n\n'); return res.end(); }
  const estimatedRate = unifiedQuote.rate;
  const estimatedCost = batchContext ? 0 : unifiedQuote.cost;

  // 1. 提交任务时优先原子预扣费
  let predeductedBalance: number | null = null;
  let balanceDeduction: BalanceDeduction | null = null;
  let billingReservationId: string | undefined;

  // 插入初始的 'processing' 内容记录，确保刷新页面时正在生成中的记录不会丢失
  try {
    const saveContent = () => ContentService.save({
      userId: req.userId!,
      orgId: req.orgId || null,
      type: 'video',
      title: (prompt as string).slice(0, 200),
      inputText: prompt as string,
      modelId: model,
      cost: estimatedCost,
      status: 'processing',
      metadata: {
        ...(billingReservationId ? { billingReservationId, reservedCost: estimatedCost, billingStatus: 'reserved' } : {}),
        pricingSnapshot: unifiedQuote.pricingSnapshot,
        ...videoSubmissionPreparation(),
        ...(batchContext ? { batchId: batchContext.batch.id, batchItemId: batchContext.item.id,
          batchAttempt: batchContext.item.attempts, batchReservedAmount: batchContext.item.unit_cost, billingStatus: 'batch_reserved' } : {}),
        resolution,
        seconds: estimatedSeconds,
        billableSeconds: estimatedSeconds,
        requestedSeconds: Number(video_length),
        outputSeconds,
        referenceVideoSeconds,
        referenceVideoRawDurations,
        referenceVideoDurations,
        referenceAudioSeconds,
        referenceAudioRawDurations,
        referenceAudioDurations,
        snumomInputMedia,
        aspect_ratio,
        model,
        prompt: prompt as string,
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
        face: isHmStudioChannel(dbChannel) ? true : undefined,
        face_processing: isHmStudioChannel(dbChannel) ? false : undefined,
        local_face_processed: Boolean(local_face_processed),
        face_split: isWxHaidiYueChannel(dbChannel)
          ? (local_face_processed ? false : (model === WX_HAIDIYUE_FACE_SPLIT_MODEL ? true : resolveWxHaidiYueFaceSplit(dbChannel, face_split)))
          : undefined,
        billingSource: 'user',
        billingBalanceSource: batchContext ? JSON.parse(batchContext.item.receipt).source : balanceDeduction?.source,
        billingOrgId: batchContext ? JSON.parse(batchContext.item.receipt).orgId : balanceDeduction?.orgId,
        queueUserKey: `user:${req.userId}`,
        queueEnqueuedAt: new Date().toISOString(),
        publicBaseUrl: process.env.BACKEND_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`
      }
    });
    contentId = batchContext
      ? batchStore.attach(batchContext.item.id, batchContext.item.attempts, req.userId!, saveContent)
      : reserveLegacyVideo(req.userId!, estimatedCost, charge => {
        balanceDeduction = charge.receipt; predeductedBalance = charge.receipt.balance;
        billingReservationId = charge.id;
        return saveContent();
      }, { model, pricingSnapshot: unifiedQuote.pricingSnapshot }).contentId;
    if (estimatedCost > 0) sendEvent({ type: 'billing', cost: estimatedCost, resolution, seconds: estimatedSeconds, rate: estimatedRate, billingType: unifiedQuote.billingType, remainingBalance: predeductedBalance });
    if (contentId !== null) {
      if (!isHmStudioChannel(channel)) {
        liveVideoRequests.add(contentId);
        activePolls.add(contentId);
      }
      sendEvent({ type: 'content_id', contentId });
    }
  } catch (e) {
    console.error('[content] 初始视频记录保存失败:', e);
    sendEvent({ type: 'error', message: (e as Error).message || '视频预扣或记录保存失败，未提交上游' });
    return res.end();
  }

  /** 生成成功后更新内容（已在前置预扣费，无需重复扣费） */
  const billUsage = (finalVideoUrl: string, upstreamResultUrl?: string, actualCost?: number, upstreamBillingUsage?: unknown) => {
    const elapsed = Date.now() - startTime;
    // Usage analytics must not prevent a successful reservation from settling.
    try { logUsage(req.userId!, 'generate_video', undefined, elapsed); }
    catch (error: any) { console.warn('[video] 使用统计写入失败，继续结算原预扣:', error.message); }
    if (contentId !== null) {
      try {
        const current = db.select().from(contents).where(eq(contents.id, contentId)).get();
        let completedMetadata: Record<string, any> = {};
        try { completedMetadata = JSON.parse(current?.metadata || '{}'); } catch { }
        completedMetadata.progress = 100;
        completedMetadata.upstreamStatus = 'completed';
        completedMetadata.queueStatus = 'completed';
        completedMetadata.queuePosition = 0;
        completedMetadata.completedAt = new Date().toISOString();
        const submittedAt = parseUtcTimestamp(current?.createdAt);
        completedMetadata.durationMs = Number.isFinite(submittedAt)
          ? Math.max(0, Date.parse(completedMetadata.completedAt) - submittedAt)
          : elapsed;
        if (upstreamResultUrl) completedMetadata.upstreamResultUrl = upstreamResultUrl;
        if (upstreamBillingUsage) completedMetadata.upstreamBillingUsage = upstreamBillingUsage;
        delete completedMetadata.progressText;
        if (finalizeLegacyVideo(contentId, 'completed', completedMetadata, finalVideoUrl, 1, actualCost)) return;
        db.update(contents).set({
          status: 'completed',
          resultUrl: finalVideoUrl || null,
          cost: batchContext ? sql`cost` : actualCost ?? estimatedCost,
          metadata: JSON.stringify(completedMetadata),
        }).where(eq(contents.id, contentId)).run();
      } catch (e) { console.error('[content] 视频记录更新失败:', e); throw e; }
    }
  };

  /** 任务失败时自动退款 */
  let failureHandled = false;
  let paidRequestStarted = false;
  let videoId = '';
  let rejectedSubmission: SpecificationUpstreamError | null = null;
  const submitVideoRequest: typeof fetch = async (url, options) => {
    paidRequestStarted = true;
    rejectedSubmission = null;
    const response = await fetch(url, options);
    if (!response.ok) {
      try { rejectedSubmission = submissionFailure(response.status, await response.clone().text(), channel, true, response.headers); }
      catch { /* An unreadable response is uncertain, never a confirmed rejection. */ }
    }
    if (response.ok) {
      try {
        const body = await response.clone().json();
        if (explicitVideoCreateError(body, response.headers)) rejectedSubmission = submissionFailure(response.status, JSON.stringify(body), channel, true, response.headers);
      } catch { /* Leave malformed accepted responses protected. */ }
    }
    return response;
  };
  const refundFailedTask = (errMsg: string, confirmedUpstreamFailure = false, knownStage?: 'query' | 'local') => {
    if (failureHandled) return;
    confirmedUpstreamFailure ||= rejectedSubmission?.confirmedFailure === true;
    if (!confirmedUpstreamFailure && contentId !== null) {
      const current = db.select().from(contents).where(eq(contents.id, contentId)).get();
      const metadata = JSON.parse(current?.metadata || '{}');
      if (metadata.videoId && protectsVideoPolling(channel, metadata)) {
        noteVideoQueryProblem(contentId, errMsg, true);
        sendEvent({ type: 'status', message: '原任务查询异常，未确认生成失败，未退款；请管理员恢复查询' });
        return;
      }
    }
    failureHandled = true;
    if (contentId !== null) endVideoSubmission(contentId, confirmedUpstreamFailure ? 'rejected' : 'unknown');
    const readableError = clarifyVideoCapacityFailure(
      extractVideoFailureMessage(errMsg) || '视频生成失败',
      isHmStudioChannel(channel),
    );
    if (!confirmedUpstreamFailure && contentId !== null) {
      const current = db.select().from(contents).where(eq(contents.id, contentId)).get();
      const meta = JSON.parse(current?.metadata || '{}');
      if (meta.billingSubmissionStarted || ['submitting', 'unknown', 'accepted'].includes(meta.videoSubmissionState) || savedVideoTaskId(meta)) {
        if (!recordBatchFailure(contentId, readableError, false)) reviewUncertainVideoTask(contentId, readableError, videoId || savedVideoTaskId(meta) ? knownStage || 'query' : 'submission', videoId || undefined);
        activePolls.delete(contentId);
        sendEvent({ type: 'status', message: '任务结果待核实，请在生成记录查看原任务，请勿重复提交' });
        return;
      }
    }
    console.error(`[video] ❌ 生成失败: ${readableError}`);
    try {
    if (contentId !== null && recordBatchFailure(contentId, readableError, confirmedUpstreamFailure)) {
      activePolls.delete(contentId);
      sendEvent({ type: 'error', message: readableError });
      return;
    }
    if (contentId !== null && isZonghengChannel(channel) && confirmedUpstreamFailure) {
      refundConfirmedZonghengVideo(contentId, readableError);
      activePolls.delete(contentId);
      sendEvent({ type: 'error', message: readableError });
      return;
    }
    if (contentId !== null && failLegacyVideo(contentId, readableError, confirmedUpstreamFailure)) { activePolls.delete(contentId); sendEvent({ type: 'error', message: readableError }); return; }
    if (contentId !== null) {
      activePolls.delete(contentId);
      try {
        const current = db.select().from(contents).where(eq(contents.id, contentId)).get();
        const failedMetadata = withVideoFailureMetadata(current?.metadata, readableError);
        failedMetadata.billingStatus = estimatedCost > 0 ? 'refunded' : 'not_charged';
        failedMetadata.queueRefunded = estimatedCost > 0;
        failedMetadata.refundAmount = estimatedCost;
        failedMetadata.refundTarget = estimatedCost > 0
          ? (balanceDeduction?.source === 'org' ? 'organization_balance' : 'user_balance')
          : 'not_charged';
        if (estimatedCost > 0) failedMetadata.refundedAt = new Date().toISOString();
        db.update(contents).set({
          status: 'failed',
          cost: 0,
          metadata: JSON.stringify(failedMetadata),
        }).where(eq(contents.id, contentId)).run();
      } catch (dbErr) { console.error('[video] 失败状态更新错误:', dbErr); throw dbErr; }
    }
    sendEvent({ type: 'error', message: readableError });
    } catch (error: any) {
      if (contentId !== null) {
        const current = db.select().from(contents).where(eq(contents.id, contentId)).get();
        db.update(contents).set({ metadata: JSON.stringify({ ...JSON.parse(current?.metadata || '{}'), upstreamStatus: 'failed', refundPending: true }) }).where(eq(contents.id, contentId)).run();
        reviewUncertainVideoTask(contentId, error.message || '退款处理待核实', 'settlement');
        activePolls.delete(contentId);
      }
      sendEvent({ type: 'status', message: '生成已失败，退款处理待核实；请勿重复提交。' });
    }
  };

  let baseUrl = channel.baseUrl.replace(/\/+$/, '');
  const requestPublicBaseUrl = process.env.BACKEND_URL
    || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
  let preparedWxImagesPromise: Promise<string[]> | null = null;
  const getPreparedWxImages = () => {
    preparedWxImagesPromise ??= prepareWxHaidiYueImageUrls(reference_images, {
      publicBaseUrl: requestPublicBaseUrl,
      mediaBaseUrl: env.WX_HAIDIYUE_IMAGE_BASE_URL || requestPublicBaseUrl,
    });
    return preparedWxImagesPromise;
  };
  const wxMediaBaseUrl = env.WX_HAIDIYUE_IMAGE_BASE_URL || requestPublicBaseUrl;
  const getPreparedWxVideos = () => finalVideos.map(source => publishReferenceUrl(source, wxMediaBaseUrl));
  const getPreparedWxAudios = () => finalAudios.map(source => publishReferenceUrl(source, wxMediaBaseUrl));
  const size = RATIO_TO_SIZE[aspect_ratio] || '1280x720';
  const isSeedanceFast = model === 'seedance-2.0-fast';
  const isSoraV4 = model === 'sora-v4-fast' || model === 'sora-v4-pro';
  const isSudaShui = meta?.series === 'sudashui';
  let isHmStudio = isHmStudioChannel(channel);
  let isWxHaidiYue = isWxHaidiYueChannel(channel);
  let isJulunSd25 = model === SI_YUE_TIAN_PRIMARY_VIDEO_MODEL && isJulunChannel(channel);
  const isSnumomWan = isSnumomWanChannel(channel);
  let isMjNewApi = isMjNewApiChannel(channel);
  const isLongxia = isLongxiaChannel(channel);
  const isMiaowu = isMiaowuChannel(channel);
  const isHaya = isHayaChannel(channel);
  const isZongheng = isZonghengChannel(channel);
  const zonghengApiProtocol = zonghengProtocol(channel);
  const zonghengSnapshot = isZongheng ? zonghengProtocolSnapshot(channel) : {};
  let zonghengInitialTask: any;
  let zonghengDelay = 20_000;
  const isVeoOmni = model === 'veo-omni-flash';
  const isVeoOmniEdit = model === 'veo-omni-flash-video-edit';
  const isVeo31 = model === 'veo-3-1';
  const isWan30 = model === 'wan3.0th' || model === 'wan3.0-video' || model === 'wan3.0-video-prime';
  const isSeedanceJsonModel = [
    ...SI_YUE_TIAN_C2_MODELS.map(spec => spec.id),
    ...SI_YUE_TIAN_SEEDANCE_25_VIDEO_MODELS,
    'seedance-2.0',
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
    'td-seedance-2.5-720p',
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
    if (!markBatchSubmitting(contentId)) return res.end();
    if (!markLegacyVideoSubmitting(contentId)) return res.end();
    if (contentId !== null) claimVideoSubmission(contentId, dbChannel?.timeout || 300_000);

    if (isZongheng) {
      if (contentId === null) throw new Error('本地任务保存失败，未提交纵横科技');
      try {
        const options = { baseUrl, apiKey: channel.apiKey, publicBaseUrl: requestPublicBaseUrl };
        const images = await prepareZonghengMedia(reference_images, 'image', options);
        const videos = await prepareZonghengMedia(finalVideos, 'video', options);
        const audios = await prepareZonghengMedia(finalAudios, 'audio', options);
        const frames = await prepareZonghengMedia([first_frame, last_frame].filter(Boolean), 'image', options);
        const job = await submitZonghengVideo(baseUrl, channel.apiKey, { model: upstreamModel, prompt, seconds: Number(video_length), ratio: aspect_ratio, resolution,
          images, videos, audios, firstFrame: frames[0], lastFrame: frames[1], quality: req.body.quality,
          negativePrompt: req.body.negative_prompt, generateAudio: req.body.generate_audio }, zonghengOrder(contentId),
          () => { paidRequestStarted = true; patchZonghengTask(contentId!, { ...zonghengSnapshot, zonghengSubmissionStarted: new Date().toISOString() }); }, dbChannel?.timeout, zonghengApiProtocol);
        zonghengInitialTask = job.initialTask;
        videoId = job.taskId; zonghengDelay = job.pollDelay;
        patchZonghengTask(contentId, { ...zonghengSnapshot, videoId, zonghengPollDelay: job.pollDelay, zonghengInitialTask: job.initialTask });
      } catch (error: any) {
        recordZonghengSubmissionError(contentId, error);
        endVideoSubmission(contentId, error instanceof ZonghengSubmissionError && error.uncertain || videoId ? 'unknown' : 'rejected');
        if (error instanceof ZonghengSubmissionError && error.uncertain || videoId) {
          reviewZonghengTask(contentId, error.message || '提交结果待核实，上游未提供具体原因');
          sendEvent({ type: 'status', message: publicGenerationError(error.message, ['V6K']) + '；提交结果待核实，请勿重复提交' });
        } else refundFailedTask(error.message, true);
        if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n');
        return;
      }
    } else if (isHaya) {
      if (contentId === null) throw new Error('本地任务保存失败，未提交 Haya');
      holdHayaSubmission(contentId);
      try {
        sendEvent({ type: 'status', message: '正在上传 Haya 参考素材...' });
        const options = { baseUrl, apiKey: channel.apiKey, publicBaseUrl: requestPublicBaseUrl };
        const images = await prepareHayaMedia(reference_images, 'image', options);
        const videos = await prepareHayaMedia(finalVideos, 'video', options);
        const audios = await prepareHayaMedia(finalAudios, 'audio', options);
        const job = await submitHayaVideo(baseUrl, channel.apiKey, { model: upstreamModel, prompt, seconds: Number(video_length), ratio: aspect_ratio, resolution, images, videos, audios },
          () => { paidRequestStarted = true; patchHayaTask(contentId!, { hayaSubmissionStarted: new Date().toISOString(), hayaMedia: { images, videos, audios } }); },
          requestId => patchHayaTask(contentId!, { requestId }));
        videoId = job.taskId;
        patchHayaTask(contentId, { videoId, requestId: job.requestId });
      } catch (error: any) {
        if ((error instanceof HayaSubmissionError && error.uncertain) || videoId) {
          reviewHayaTask(contentId, error.message);
          activePolls.delete(contentId);
sendEvent({ type: 'status', message: 'Haya 提交结果待核实，费用保留，请勿重复提交；请在历史记录中核实原任务' });
        } else refundFailedTask(error.message, true);
        if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n');
        return;
      }
    } else if (failoverReason && (isWxHaidiYue || isMjNewApi)) {
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
            model: selectedUpstreamModel,
            prompt: prompt.trim(),
            duration: Number(video_length) || 6,
            aspectRatio: aspect_ratio,
            images: await getPreparedWxImages(),
            videos: getPreparedWxVideos(),
            audios: getPreparedWxAudios(),
            faceSplit: local_face_processed
              ? false
              : model === WX_HAIDIYUE_FACE_SPLIT_MODEL
              ? true
              : resolveWxHaidiYueFaceSplit(overflowPlan.channel, face_split),
          });
          createResp = await submitVideoRequest(wxHaidiYueCreateUrl(overflowPlan.channel.baseUrl), {
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
          createResp = await submitVideoRequest(`${overflowPlan.channel.baseUrl.replace(/\/+$/, '')}/v1/videos`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${overflowPlan.channel.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(overflowPlan.channel.timeout || 120_000),
          });
        }

        guardBatchSubmissionResponse(Boolean(batchContext), createResp);
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
        rejectedSubmission = submissionFailure(createResp.status, detail, overflowPlan.channel, true, createResp.headers);
        if (!rejectedSubmission.confirmedFailure || !isHmStudioConcurrencyError(createResp.status, detail)) {
          refundFailedTask(upstreamDiagnostic(String(model), '视频提交', detail, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        sendEvent({ type: 'status', message: '当前备用线路暂时满载，正在尝试下一条线路...' });
        overflowPlan = findHmStudioOverflowPlan(overflowInput, attemptedFallbackIds);
      }

      if (!videoId) {
        refundFailedTask('所有兼容视频线路当前均不可用，请在后台启动线路后重试');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
    } else if (isHmStudio) {
      sendEvent({ type: 'status', message: '正在整理素材并提交 HM Studio 任务...' });
      const payload = buildHmStudioVideoPayload({
        localMediaBaseUrl: process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`,
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
        face: true,
      });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (channel.apiKey) headers.Authorization = `Bearer ${channel.apiKey}`;

      const createResp = await submitVideoRequest(hmStudioCreateUrl(baseUrl, 'video'), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(dbChannel?.timeout || 120_000),
      });
      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isWxHaidiYue) {
      sendEvent({ type: 'status', message: '正在提交视频任务...' });
      const payload = buildWxHaidiYueVideoPayload({
        model: upstreamModel,
        prompt: prompt.trim(),
        duration: Number(video_length) || 5,
        aspectRatio: aspect_ratio,
        images: await getPreparedWxImages(),
        videos: getPreparedWxVideos(),
        audios: getPreparedWxAudios(),
        faceSplit: local_face_processed
          ? false
          : model === WX_HAIDIYUE_FACE_SPLIT_MODEL
          ? true
          : resolveWxHaidiYueFaceSplit(channel, face_split),
      });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (channel.apiKey) headers.Authorization = `Bearer ${channel.apiKey}`;
      const createResp = await submitVideoRequest(wxHaidiYueCreateUrl(baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(dbChannel?.timeout || 120_000),
      });
      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] wx-海底月提交失败 (${createResp.status}): ${errText.slice(0, 300)}`);
        refundFailedTask(upstreamDiagnostic('wx-海底月', '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
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

      const createResp = await submitVideoRequest(`${baseUrl}/v1/videos`, {
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
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const job = await createResp.json() as any;
      videoId = job.id || job.task_id;
    } else if (isLongxia) {
      sendEvent({ type: 'status', message: '正在提交 LongXia 视频任务...' });
      const payload = buildLongxiaVideoPayload({ model: upstreamModel, prompt, seconds: Number(video_length), ratio: aspect_ratio,
        resolution, imageUrls: reference_images, videoUrls: finalVideos, audioUrls: finalAudios });
      const createResp = await submitVideoRequest(longxiaVideoCreateUrl(baseUrl), {
        method: 'POST', headers: { Authorization: 'Bearer ' + channel.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(dbChannel?.timeout || 120_000),
      });
      if (!createResp.ok) {
        const detail = await createResp.text().catch(() => '');
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', detail, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.task_id || job.id;
    } else if (isMiaowu) {
      sendEvent({ type: 'status', message: '正在整理素材并提交喵呜 API 视频任务...' });
      const miaowuPublicBaseUrl = process.env.BACKEND_URL
        || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
      const imageUrls = prepareMiaowuPublicMediaUrls(reference_images, 'image', { publicBaseUrl: miaowuPublicBaseUrl });
      const videoUrls = prepareMiaowuPublicMediaUrls(finalVideos, 'video', { publicBaseUrl: miaowuPublicBaseUrl });
      const audioUrls = prepareMiaowuPublicMediaUrls(finalAudios, 'audio', { publicBaseUrl: miaowuPublicBaseUrl });
      const payload = buildMiaowuVideoPayload({
        model: upstreamModel,
        prompt,
        seconds: Number(video_length) || 5,
        ratio: aspect_ratio,
        resolution,
        imageUrls,
        videoUrls,
        audioUrls,
      });
      const createResp = await submitVideoRequest(miaowuVideoCreateUrl(baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(dbChannel?.timeout || 120_000),
      });
      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.id || job.task_id;
    } else if (isSudaShui) {
      sendEvent({ type: 'status', message: '正在上传素材并提交 SudaShui 任务...' });

      const imageUrls: string[] = [];
      for (const img of (reference_images || []).slice(0, 9)) {
        imageUrls.push(await uploadToSudaShui(img, process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`));
      }
      const videoUrls: string[] = [];
      for (const v of finalVideos.slice(0, 3)) {
        videoUrls.push(await uploadToSudaShui(v, process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`));
      }
      const audioUpUrls: string[] = [];
      for (const a of finalAudios.slice(0, 3)) {
        audioUpUrls.push(await uploadToSudaShui(a, process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`));
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

      const createResp = await submitVideoRequest(sudaShuiVideoCreateUrl(baseUrl), {
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
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
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

      const createResp = await submitVideoRequest(`${baseUrl}/v1/videos`, {
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
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
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

      const createResp = await submitVideoRequest(`${baseUrl}/v1/videos`, {
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
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
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
      const createResp = await submitVideoRequest(`${baseUrl}/v1/videos`, {
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
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
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

      const createResp = await submitVideoRequest(`${baseUrl}/v1/videos`, {
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
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
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

      const createResp = await submitVideoRequest(`${baseUrl}/v1/video/generations`, {
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
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
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
      const createResp = await submitVideoRequest(`${baseUrl}/v1/videos`, {
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
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.id || job.task_id;
    } else if (isSnumomWan && (isWan30 || model === SNUMOM_SD_MINI_MODEL || model === SNUMOM_GROK_IMAGINE_VIDEO_MODEL)) {
      const snumomModelLabel = model === SNUMOM_SD_MINI_MODEL ? 'SD Mini' : model === SNUMOM_GROK_IMAGINE_VIDEO_MODEL ? 'Grok 1.5' : 'WAN3.0';
      sendEvent({ type: 'status', message: `正在整理并提交 snumom ${snumomModelLabel} 任务...` });

      const maxImages = model === SNUMOM_SD_MINI_MODEL ? SNUMOM_SD_MINI_MAX_IMAGES
        : model === SNUMOM_GROK_IMAGINE_VIDEO_MODEL ? SNUMOM_GROK_IMAGINE_VIDEO_MAX_IMAGES : 10;
      const maxVideos = model === SNUMOM_SD_MINI_MODEL ? SNUMOM_SD_MINI_MAX_VIDEOS
        : model === SNUMOM_GROK_IMAGINE_VIDEO_MODEL ? 0 : 5;
      const maxAudios = model === SNUMOM_SD_MINI_MODEL ? SNUMOM_SD_MINI_MAX_AUDIOS
        : model === SNUMOM_GROK_IMAGINE_VIDEO_MODEL ? 0 : 5;
      const imageUrls = (reference_images || []).slice(0, maxImages)
        .map((item: string) => convertBase64ToPublicUrl(item, 'snumom_wan3_img', req))
        .filter(Boolean);
      const videoUrls = finalVideos.slice(0, maxVideos)
        .map(item => convertBase64ToPublicUrl(item, 'snumom_wan3_video', req))
        .filter(Boolean);
      const audioUrls = finalAudios.slice(0, maxAudios)
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
        seconds: billingOutputSeconds,
        resolution,
        aspectRatio: aspect_ratio,
        images: frameImages.length > 0
          ? frameImages
          : imageUrls.map(url => ({ url, role: 'reference_image' })),
        videos: videoUrls.map(url => ({ url })),
        audios: audioUrls.map(url => ({ url })),
        smartDuration: smartSnumomDuration,
        promptExtend: snumomPromptExtend,
        inputMedia: snumomInputMedia,
      });
      const createResp = await submitVideoRequest(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${channel.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(dbChannel?.timeout || 120_000),
      });
      const responseText = await createResp.text().catch(() => '');
      if (!createResp.ok) {
        const rejection = submissionFailure(createResp.status, responseText, channel, true, createResp.headers);
        refundFailedTask(rejection.message, !rejection.uncertain);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      let job: any;
      try { job = responseText ? JSON.parse(responseText) : null; }
      catch { job = null; }
      if (isSnumomSubmissionRejection(createResp.status, responseText, channel, createResp.headers) || explicitVideoCreateError(job, createResp.headers) || job && isVideoFailurePayload(job)) {
        refundFailedTask(extractVideoFailureMessage(job) || `snumom ${snumomModelLabel} 明确拒绝了任务`, true);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      videoId = extractSnumomTaskId(job, createResp.headers);
      if (!videoId) {
        if (contentId !== null) endVideoSubmission(contentId, 'unknown');
        const reason = job
          ? 'snumom 已受理请求，但响应中没有可识别的任务 ID'
          : 'snumom 已受理请求，但返回了无法解析的任务响应';
        const diagnostics = {
          submissionReviewReason: reason,
          progressText: '上游已受理，任务编号待核实，请勿重复提交',
          upstreamCreateHttpStatus: createResp.status,
          upstreamCreateResponse: sanitizeUpstreamCreateResponse(job ?? responseText),
          upstreamRequestId: createResp.headers.get('x-request-id') || undefined,
        };
        if (contentId !== null) {
          if (batchContext) noteBatchQueryProblem(contentId, diagnostics.progressText);
          else finalizeLegacyVideo(contentId, 'review', diagnostics);
          activePolls.delete(contentId);
        }
        sendEvent({ type: 'status', message: '上游任务编号待核实，费用已保留，请勿重复提交' });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (contentId !== null) {
        acceptVideoSubmission(contentId, videoId, {
          channelId: Number(dbChannel?.id || channel.id) || null,
          channelApiKeyId: Number(dbChannel?.apiKeyId) || null,
          provider: 'snumom',
        });
      }
    } else if (isWan30) {
      sendEvent({ type: 'status', message: '正在整理 WAN3.0 多模态参考素材...' });

      const imageUrls = (reference_images || []).slice(0, 10)
        .map((item: string) => convertBase64ToPublicUrl(item, 'wan3_img', req));
      const videoUrls = finalVideos.slice(0, 5)
        .map(item => convertBase64ToPublicUrl(item, 'wan3_video', req));
      const audioUrls = finalAudios.slice(0, 5)
        .map(item => convertBase64ToPublicUrl(item, 'wan3_audio', req));

      const createResp = await submitVideoRequest(`${baseUrl}/v1/videos`, {
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
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
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
      paidRequestStarted = true;
      const createResp = await submitSiYueTianOverflowPlan(overflowPlan, {
        prompt: prompt.trim(),
        ratio: aspect_ratio,
        imageUrls,
      });
      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        rejectedSubmission = submissionFailure(createResp.status, errText, channel, true, createResp.headers);
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const job = await createResp.json() as any;
      videoId = job.request_id || job.task_id || job.id;
    } else if (isSeedanceJsonModel) {
      sendEvent({ type: 'status', message: '正在处理素材并提交 Seedance 2.0 任务...' });

      // 将 base64 素材保存到本地并生成自托管公网 URL
      const imageUrls: string[] = [];
      const siYueTianSeedance25Spec = getSiYueTianSeedance25VideoSpec(model);
      const c2Spec = getSiYueTianC2Model(model);
      const isVd25 = model === 'vd-seedance-2.5-480p' || model === 'vd-seedance-2.5-720p';
      const isAd25 = model === 'ad-seedance-2.5-480p';
      const maxImgCount = c2Spec?.images ?? (siYueTianSeedance25Spec
        ? SI_YUE_TIAN_SEEDANCE_25_MAX_IMAGES
        : ((isAd25 || model === 'sd2.5') ? 30 : 9));
      for (const img of (reference_images || []).slice(0, maxImgCount)) {
        const url = convertBase64ToPublicUrl(img, 'sd2_ref', req);
        if (url) imageUrls.push(url);
      }
      const videoRefUrls: string[] = [];
      const isNoVideoModel = Boolean(siYueTianSeedance25Spec) || model === 'sd2.5' || model === 'sd2-mini' || model === 'seedance2.0-933' || model === 'seedance2.0 933' || model.includes('noface');
      const maxVidCount = c2Spec?.videos ?? (isAd25 ? 10 : (isNoVideoModel ? 0 : 3));
      for (const v of finalVideos.slice(0, maxVidCount)) {
        const url = convertBase64ToPublicUrl(v, 'sd2_vid', req);
        if (url) videoRefUrls.push(url);
      }
      const audioRefUrls: string[] = [];
      const maxAudCount = c2Spec?.audios ?? (siYueTianSeedance25Spec
        ? SI_YUE_TIAN_SEEDANCE_25_MAX_AUDIOS
        : (isAd25 ? 10 : (isVd25 ? 0 : (model === 'sd2.5' ? 0 : 3))));
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

      const createResp = await submitVideoRequest(`${baseUrl}/v1/videos`, {
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
          && rejectedSubmission?.confirmedFailure === true
          && isHmStudioConcurrencyError(createResp.status, errText);
        guardBatchSubmissionResponse(Boolean(batchContext), createResp);
        if (!canOverflowSiYueTian) {
          console.error(`[video] sd2 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
          refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        failoverFrom = 'siyuetian';
        failoverReason = 'siyuetian_upstream_concurrency';
        sendEvent({ type: 'status', message: '四月天上游暂时满载，正在尝试备用线路...' });

        const overflowPlan = findSiYueTianOverflowPlan(overflowInput);
        if (overflowPlan) {
          paidRequestStarted = true;
          rejectedSubmission = null;
          const fallbackResponse = await submitSiYueTianOverflowPlan(overflowPlan, {
            prompt: prompt.trim(),
            ratio: aspect_ratio,
            imageUrls,
          });
          guardBatchSubmissionResponse(Boolean(batchContext), fallbackResponse);
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
            rejectedSubmission = submissionFailure(fallbackResponse.status, fallbackDetail, overflowPlan.channel, true, fallbackResponse.headers);
            refundFailedTask(upstreamDiagnostic(String(model), '视频提交', fallbackDetail, channel?.apiKey || '', fallbackResponse.status, fallbackResponse.headers.get('x-request-id') || undefined));
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
      const maxRefs = model === SNUMOM_SD_MINI_MODEL
        ? SNUMOM_SD_MINI_MAX_IMAGES
        : meta?.requireRef ? 1 : 5;
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

      const createResp = await submitVideoRequest(`${baseUrl}/v1/videos`, {
        method: 'POST',
        headers,
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '');
        console.error(`[video] 创建任务失败: ${createResp.status} ${errText.slice(0, 300)}`);
        refundFailedTask(upstreamDiagnostic(String(model), '视频提交', errText, channel?.apiKey || '', createResp.status, createResp.headers.get('x-request-id') || undefined));
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
        acceptVideoSubmission(contentId, String(videoId), { provider: isSnumomWan ? 'snumom' : channel.type || '',
          channelId: Number(dbChannel?.id || channel.id) || null, channelApiKeyId: Number(dbChannel?.apiKeyId) || null });
        {
          const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
          if (row) {
            const meta = JSON.parse(row.metadata || '{}');
            meta.videoId = videoId;
            if (isHaya) meta.hayaNeedsReview = false;
            db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
          }
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
    const pollInterval = isLongxia ? 30_000 : 5000;
    const maxTransientPollFailures = 6;
    let consecutiveTransientPollFailures = 0;

    const protectedPolling = !isHaya && !isZongheng && protectsVideoPolling(channel, { videoId, ...(batchContext ? { batchItemId: batchContext.item.id } : {}) });
    const acceptedPollingStartedAt = Date.now();

    const headers: Record<string, string> = {};
    if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

    while (true) {
      if (protectedPolling && Date.now() - acceptedPollingStartedAt >= (env.VIDEO_TASK_POLL_TIMEOUT_MS || 1_800_000)) {
        if (contentId !== null) noteVideoQueryProblem(contentId, '原任务自动查询已达到时限', true);
        sendEvent({ type: 'status', message: '原任务自动查询已暂停，未退款，请管理员恢复查询' });
        if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
        return;
      }
      if (!zonghengInitialTask) await new Promise(r => setTimeout(r, isZongheng ? zonghengDelay : isHaya ? hayaPollDelay(consecutiveTransientPollFailures) : pollInterval));

      // 检查客户端是否断开仅进行日志记录，不终止后台轮询以完成计费和数据库更新
      if (res.writableEnded || res.destroyed) {
        console.log(`[video] 客户端已断开，后台继续轮询任务 ${videoId}...`);
      }

      try {
        let pollUrl = `${baseUrl}/v1/videos/${videoId}`;
        if (isZongheng) {
          pollUrl = zonghengTaskUrl(baseUrl, videoId);
        } else if (isHaya) {
          pollUrl = hayaTaskUrl(baseUrl, videoId);
        } else if (isHmStudio) {
          pollUrl = hmStudioTaskUrl(baseUrl, videoId);
        } else if (isWxHaidiYue) {
          pollUrl = wxHaidiYueTaskUrl(baseUrl, videoId);
        } else if (isLongxia) {
          pollUrl = longxiaVideoTaskUrl(baseUrl, videoId);
        } else if (isMiaowu) {
          pollUrl = miaowuVideoTaskUrl(baseUrl, videoId);
        } else if (isSudaShui) {
          pollUrl = `${baseUrl}/v1/video/generations/${videoId}`;
        }

        const pollResp = isZongheng && zonghengInitialTask ? globalThis.Response.json(zonghengInitialTask) : isZongheng
          ? await queryZonghengTask(videoId, dbChannel?.id, dbChannel?.apiKeyId, channel, zonghengSnapshot)
          : protectedPolling ? await fetchVideoTaskResponse(pollUrl, { headers })
          : await fetch(pollUrl, { headers, signal: AbortSignal.timeout(15_000) });

        if (!pollResp.ok) {
          const detail = await pollResp.text().catch(() => '');
          const failureMessage = formatVideoPollHttpFailure(pollResp.status, detail);
          if (isSnumomWan && ++consecutiveTransientPollFailures < maxTransientPollFailures) continue;
          if (protectedPolling) {
            if (contentId !== null) noteVideoQueryProblem(contentId, failureMessage);
            continue;
          }
          if (isHaya || isZongheng) {
            consecutiveTransientPollFailures++;
            if (isZongheng) zonghengDelay = v6kQueryRetryDelay(consecutiveTransientPollFailures, pollResp.headers.get('retry-after'));
            if (contentId !== null) (isZongheng ? patchZonghengTask : patchHayaTask)(contentId, { progressText: '查询暂时不可用，继续查询原任务，不会重复生成' });
            continue;
          }
          if (batchContext && contentId) {
            noteBatchQueryProblem(contentId, '上游状态查询暂时不可用，正在查询原任务，不会重复生成');
            continue;
          }
          if (isWxHaidiYue && isTransientVideoPollHttpStatus(pollResp.status)) {
            consecutiveTransientPollFailures++;
            if (consecutiveTransientPollFailures < maxTransientPollFailures) {
              console.warn(`[video] ${failureMessage}; retrying (${consecutiveTransientPollFailures}/${maxTransientPollFailures})`);
              sendEvent({
                type: 'status',
                message: `海底月状态查询暂时不可用，正在自动重试（${consecutiveTransientPollFailures}/${maxTransientPollFailures}）...`,
              });
              continue;
            }
          }
          console.error(`[video] ${failureMessage}`);
          refundFailedTask(failureMessage);
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }

        if (!isHaya) consecutiveTransientPollFailures = 0;
        const status = await pollResp.json() as any;
        if (zonghengInitialTask) { zonghengInitialTask = undefined; if (contentId !== null) patchZonghengTask(contentId, { zonghengInitialTask: undefined }); }
        if (contentId !== null && db.select().from(contents).where(eq(contents.id, contentId)).get()?.status !== 'processing') {
          if (!res.destroyed && !res.writableEnded) res.end();
          return;
        }
        if (protectedPolling && (isVideoQueryErrorPayload(status)
          || ((status.task_id || status.id) && String(status.task_id || status.id) !== videoId))) {
          if (contentId !== null) noteVideoQueryProblem(contentId, '查询响应异常或任务 ID 不一致');
          continue;
        }
        let taskStatus = status.status;
        if (contentId !== null) clearVideoQueryProblem(contentId);
        let progress = status.progress || 0;
        let resultUrl = '';
        let errMsg = '';
        let snumomBillingUsage: ReturnType<typeof normalizeSnumomWanTask>['billingUsage'] = null;

        if (isZongheng) {
          const normalized = normalizeZonghengTask(status, baseUrl, zonghengApiProtocol, videoId);
          taskStatus = normalized.status; progress = normalized.progress; resultUrl = normalized.resultUrl; errMsg = normalized.error;
          zonghengDelay = normalized.pollDelay;
        } else if (isHaya) {
          const normalized = normalizeHayaTask(status, baseUrl, videoId);
          consecutiveTransientPollFailures = 0;
          taskStatus = normalized.status; progress = normalized.progress; resultUrl = normalized.resultUrl; errMsg = normalized.error;
        } else if (isHmStudio) {
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
        } else if (isLongxia) {
          const normalized = normalizeLongxiaVideoTask(status);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || 'LongXia 视频生成失败';
        } else if (isMiaowu) {
          const normalized = normalizeMiaowuVideoTask(status, baseUrl, videoId);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || '喵呜 API 视频生成失败';
        } else if (isSnumomWan) {
          const normalized = normalizeSnumomWanTask(status, referenceVideoSeconds);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || 'snumom 视频生成失败';
          snumomBillingUsage = normalized.billingUsage;
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

        if (!isHaya && !isZongheng && isVideoFailurePayload(status)) {
          if (batchContext && isBatchQueryUncertain(status, taskStatus)) {
            if (contentId) noteBatchQueryProblem(contentId, '上游查询返回异常，继续核实原任务');
            continue;
          }
          taskStatus = 'failed';
          errMsg = extractVideoFailureMessage(status) || errMsg || '视频生成失败';
        }

        console.log(`[video] 轮询 (${isSudaShui ? 'SudaShui' : isSoraV4 ? 'SoraV4' : isSeedanceFast ? 'SeedanceFast' : 'Default'}): contentId=${contentId} taskId=${videoId} status=${taskStatus} progress=${progress}%`);

        if (taskStatus === 'processing' || taskStatus === 'queued' || taskStatus === 'pending' || taskStatus === 'submitted' || taskStatus === 'generating' || taskStatus === 'post_processing' || taskStatus === 'finalizing' || taskStatus === 'in_progress') {
          sendEvent({ type: 'progress', progress });
          const hmProgressText = isZongheng ? normalizeZonghengTask(status, baseUrl, zonghengApiProtocol, videoId).progressText : isHmStudio ? normalizeHmStudioTask(status, baseUrl).progressText : '';
          sendEvent({ type: 'status', message: hmProgressText || `视频生成中 ${progress}%` });
          // 将实时进度写入数据库，以便前端刷新页面后恢复时能读取
          if (contentId !== null) {
            try {
              const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
              if (row) {
                const meta = JSON.parse(row.metadata || '{}');
                meta.progress = progress;
                meta.upstreamStatus = taskStatus;
                if (protectedPolling) { delete meta.upstreamQueryError; meta.progressText = `视频生成中 ${progress}%`; }
                if (isZongheng) Object.assign(meta, zonghengTaskMetadata(status, baseUrl, zonghengApiProtocol, videoId));
                if (hmProgressText) meta.progressText = hmProgressText;
                db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
              }
            } catch { }
          }
        } else if (taskStatus === 'completed' || taskStatus === 'success') {
          if (!resultUrl) {
            if (protectedPolling && contentId !== null) {
              noteVideoQueryProblem(contentId, '上游已完成，等待视频地址');
              continue;
            }
            if (isZongheng) {
              if (contentId !== null) patchZonghengTask(contentId, {upstreamStatus:taskStatus,upstreamGenerated:true,upstreamDeliveryPending:true,progress:99,progressText:'视频已生成，正在等待结果交付'});
              sendEvent({type:'status',message:'视频已生成，正在等待结果交付'});
              continue;
            }
            if (batchContext && contentId) {
              noteBatchQueryProblem(contentId, '上游已完成，等待视频链接，不会重复生成');
              continue;
            }
            refundFailedTask('上游任务已完成，但没有返回视频链接');
            if (!res.destroyed && !res.writableEnded) {
              res.write('data: [DONE]\n\n');
              res.end();
            }
            return;
          }
          console.log(`[video] ✅ 生成完成: ${resultUrl}`);
          if (contentId !== null) {
            const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
            const metadata = JSON.parse(row?.metadata || '{}');
            db.update(contents).set({ metadata: JSON.stringify({ ...metadata, ...(isZongheng ? zonghengTaskMetadata(status, baseUrl, zonghengApiProtocol, videoId) : {}), progress: 100, upstreamStatus: taskStatus, upstreamResultUrl: resultUrl, progressText: '视频已生成，正在保存到本站存储' }) }).where(eq(contents.id, contentId)).run();
          }
          sendEvent({ type: 'progress', progress: 100 });
          sendEvent({ type: 'status', message: '视频已生成，正在保存到本站存储' });

          // Persist every completed video on the VPS before exposing it to users.
          let finalVideoUrl = '';
          try {
            if (resultUrl && resultUrl.includes('llm.chre3.com')) {
              finalVideoUrl = isZongheng || protectedPolling
                ? await withVideoPollDeadline(() => localizeChre3Video(resultUrl, videoId, model), 360_000, 'Video result storage')
                : await localizeChre3Video(resultUrl, videoId, model);
            } else {
              finalVideoUrl = isZongheng || protectedPolling
                ? await withVideoPollDeadline(() => downloadAndLocalizeVideo(resultUrl, videoId, model, dbChannel?.id, dbChannel?.apiKeyId), 360_000, 'Video result storage')
                : await downloadAndLocalizeVideo(resultUrl, videoId, model, dbChannel?.id, dbChannel?.apiKeyId);
            }
          } catch (localErr: any) {
            if ((isZongheng || protectedPolling) && localErr instanceof VideoPollTimeout) throw localErr;
            console.error(`[video] VPS localization failed; task remains processing: ${localErr.message}`);
            sendEvent({ type: 'status', message: '视频已生成，正在保存到本站存储' });
            continue;
          }

          if (contentId !== null && db.select().from(contents).where(eq(contents.id, contentId)).get()?.status !== 'processing') {
            if (!res.destroyed && !res.writableEnded) res.end();
            return;
          }
          const actualQuote = snumomBillingUsage && isSnumomWan30VideoModel(model)
            ? PricingService.quoteSnapshot(unifiedQuote.pricingSnapshot, {
                resolution: snumomBillingUsage.resolution || resolution,
                seconds: snumomBillingUsage.billableSeconds,
                count: 1,
              })
            : null;
          try { billUsage(finalVideoUrl, resultUrl, actualQuote?.cost, snumomBillingUsage || undefined); }
          catch (error: any) {
            if (contentId !== null) {
              db.update(contents).set({ resultUrl: finalVideoUrl }).where(eq(contents.id, contentId)).run();
              reviewUncertainVideoTask(contentId, error.message || '生成结果已保留，费用结算待核实', 'settlement', videoId);
            }
            sendEvent({ type: 'status', message: '生成结果已保留，费用结算待核实，请勿重复提交' });
            if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n');
            return;
          }
          if (contentId !== null && db.select().from(contents).where(eq(contents.id, contentId)).get()?.status === 'review') {
            sendEvent({ type: 'status', message: '视频已生成，费用结算待核实，原结果已保存，请勿重复提交', contentId });
            activePolls.delete(contentId);
            if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n');
            return;
          }
          sendEvent({ type: 'complete', videoUrl: finalVideoUrl });
          if (contentId !== null) activePolls.delete(contentId);
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        } else if (isVideoFailureStatus(taskStatus)) {
          refundFailedTask(errMsg, true);
          if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }
      } catch (pollErr: any) {
        if ((isZongheng || protectedPolling) && pollErr instanceof VideoPollTimeout && contentId !== null) {
          console.warn('[video] Poll deadline reached; handing original task to recovery:', contentId);
          resumeAfterPollTimeout = true;
          sendEvent({ type: 'status', message: '正在后台同步原任务结果，请勿重复提交' });
          if (!res.destroyed && !res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
          return;
        }
        if (protectedPolling && contentId !== null) noteVideoQueryProblem(contentId, pollErr.message || '查询连接异常');
        if (isHaya) consecutiveTransientPollFailures++;
        console.warn(`[video] 轮询异常: contentId=${contentId} taskId=${videoId} ${pollErr.message}`);
        // 轮询失败不立即退出，继续重试
      }
    }

  } catch (err: any) {
    console.error(`[video] 生成失败:`, err.name, err.message, err.cause?.message || '');
    if (err.code === 'VIDEO_SUBMISSION_CONFLICT') {
      sendEvent({ type: 'status', message: '原任务已提交，请查询原任务，勿重复提交' });
      if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n');
      return;
    }
    const msg = transportDiagnostic(String(model), '视频生成请求', err);
    const saved = contentId !== null ? readVideoRecoveryState(contentId) : null;
    const accepted = videoId || saved && savedVideoTaskId(JSON.parse(saved.metadata || '{}'));
    refundFailedTask(msg, !accepted && !(err instanceof SpecificationUpstreamError && err.uncertain) && (!paidRequestStarted || videoRequestNotSent(err)
      || err instanceof SpecificationUpstreamError && err.confirmedFailure), accepted ? 'local' : undefined);
    res.write('data: [DONE]\n\n');
    res.end();
  } finally {
    if (contentId !== null) {
      liveVideoRequests.delete(contentId);
      releaseVideoSubmission(contentId);
      if (!isHmStudio) activePolls.delete(contentId);
    }
    if (isHaya && contentId !== null) releaseHayaSubmission(contentId);
    if (resumeAfterPollTimeout && contentId !== null) {
      const row = db.select().from(contents).where(eq(contents.id, contentId)).get();
      if (row?.status === 'processing') void resumePollForTask(contentId, row);
    }
  }
});

// 视频下载代理，解决浏览器跨域下载变成播放的问题
router.get('/download', protectVideoSource, async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const filename = req.query.filename as string || 'video.mp4';

    const local = /^\/(?:api\/)?uploads\//.test(url) || /^https?:\/\//.test(url) && new URL(url).pathname.startsWith('/uploads/');
    const compatiblePath = local
      ? await prepareVideoForDelivery(resolveBatchArchiveFile(url.replace(/^\/api\/uploads\//, '/uploads/'), path.resolve('data/uploads')))
      : await cacheVideoForDelivery(url, videoSourceHeaders(url));
    res.type(videoDeliveryContentType(compatiblePath));
    return res.download(compatiblePath, filename.replace(/\.(mp4|webm|mov|mkv|m4v)$/i, '') + videoDeliveryExtension(compatiblePath));
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
setInterval(cleanVideoCache, 12 * 60 * 60 * 1000).unref();

function videoSourceHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (new URL(url).hostname === 'llm.chre3.com') {
    const channel = findVideoChannel('sd2-c7');
    if (channel?.apiKey) headers.Authorization = `Bearer ${channel.apiKey}`;
  }
  return headers;
}

// Playback and downloads prefer H.264, with original fallback and native Range support.
router.get('/play', protectVideoSource, async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    const local = /^\/(?:api\/)?uploads\//.test(url);
    const compatiblePath = local
      ? await prepareVideoForDelivery(resolveBatchArchiveFile(url.replace(/^\/api\/uploads\//, '/uploads/'), path.resolve('data/uploads')))
      : await cacheVideoForDelivery(url, videoSourceHeaders(url));
    res.type(videoDeliveryContentType(compatiblePath));
    return res.sendFile(compatiblePath);
  } catch (err: any) {
    console.error('[video/play] H.264 playback failed:', err.message);
    res.status(502).send('H.264 视频准备失败，请稍后重试');
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
    const compatibleFile = await prepareVideoForDelivery(outputFile);
    const stat = fs.statSync(compatibleFile);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="merged.mp4"');
    const stream = fs.createReadStream(compatibleFile);
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
  if (!record || record.status === 'completed' || record.status === 'failed' || record.status === 'review') return;
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

export async function failHmQueuedVideo(contentId: number, error: unknown, confirmedUpstreamFailure = false): Promise<void> {
  const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
  if (!record || record.status === 'failed' || record.status === 'completed') return;
  let metadata: Record<string, any> = {};
  try { metadata = JSON.parse(record.metadata || '{}'); } catch { }
  const rawMessage = error instanceof Error ? error.message : String(error || '视频任务失败');
  const pollingChannel = metadata.channelId ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null) : null;
  if (!confirmedUpstreamFailure && metadata.videoId && protectsVideoPolling(pollingChannel, metadata)) {
    noteVideoQueryProblem(contentId, rawMessage, true); return;
  }
  if (recordBatchFailure(contentId, rawMessage, confirmedUpstreamFailure)) return;
  if (metadata.billingReservationId && !metadata.managedSpecification) {
    const failedAt = new Date().toISOString();
    finalizeReservedContent(contentId, confirmedUpstreamFailure ? 'failed' : 'review', {
      error: rawMessage,
      ...(confirmedUpstreamFailure ? { failedAt, progressText: undefined } : { progressText: '上游结果暂时无法确认，费用保留待核实' }),
      upstreamStatus: confirmedUpstreamFailure ? 'failed' : metadata.upstreamStatus || 'unknown',
    });
    return;
  }
  if (!confirmedUpstreamFailure && (savedVideoTaskId(metadata) || metadata.videoSubmissionState)) {
    reviewUncertainVideoTask(contentId, rawMessage); return;
  }
  if (failLegacyVideo(contentId, rawMessage, confirmedUpstreamFailure)) return;
  const taskChannel = metadata.channelId
    ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null)
    : null;
  const message = clarifyVideoCapacityFailure(rawMessage, isHmStudioChannel(taskChannel));
  if (isZonghengChannel(taskChannel) && confirmedUpstreamFailure) {
    refundConfirmedZonghengVideo(contentId, message);
    return;
  }
  refundUnreservedVideo(contentId, message);
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

        let referenceImages: string[] = latestMeta.reference_images || latestMeta.image_urls || [];
        const referenceVideos = latestMeta.reference_videos || latestMeta.video_urls || [];
        const referenceAudios = latestMeta.audio_urls || [];
        let firstFrame = latestMeta.first_frame || latestMeta.firstFrame;
        let lastFrame = latestMeta.last_frame || latestMeta.lastFrame;

        // HM owns face processing for every HM channel task, including legacy
        // queued tasks resumed after a restart. Never run the local processor.
        latestMeta.face_processing = false;
        latestMeta.face = true;
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

        if (!markBatchSubmitting(contentId)) return;
        if (!markLegacyVideoSubmitting(contentId)) return;
        claimVideoSubmission(contentId, selectedHmChannel.timeout || 120_000);
        if (latestMeta.batchItemId) latestMeta.batchSubmissionStarted = new Date().toISOString();

        while (true) {
          attemptedHmPools.add(hmStudioPoolKey(selectedHmChannel));
          let selectedMapping: Record<string, string> = {};
          try {
            selectedMapping = typeof selectedHmChannel.modelMapping === 'string'
              ? JSON.parse(selectedHmChannel.modelMapping || '{}')
              : (selectedHmChannel.modelMapping || {});
          } catch { }
          selectedHmUpstreamModel = selectedMapping[model] || model;
          const payload = buildHmStudioVideoPayload({
            model: selectedHmUpstreamModel,
            prompt: String(latestMeta.prompt || latest.inputText || '').trim(),
            duration: Number(latestMeta.seconds) || 6,
            ratio: latestMeta.aspect_ratio || latestMeta.ratio || '16:9',
            resolution: latestMeta.resolution || '720p',
            imageSources: referenceImages,
            localMediaBaseUrl: process.env.BACKEND_URL || latestMeta.publicBaseUrl,
            videoSources: referenceVideos,
            audioSources: referenceAudios,
            firstFrame,
            lastFrame,
            functionMode: latestMeta.function_mode,
            upstreamChannel: latestMeta.upstream_channel,
            face: true,
          });
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (selectedHmChannel.apiKey) headers.Authorization = `Bearer ${selectedHmChannel.apiKey}`;
          try { response = await fetch(hmStudioCreateUrl(selectedHmChannel.baseUrl, 'video'), {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(selectedHmChannel.timeout || 120_000),
          }); } catch (error: any) { throw hmSubmissionTransportError(error, selectedHmChannel.apiKey); }
          if (response.ok) break;

          const detail = await response.text().catch(() => '');
          let hmBody: any; try { hmBody = JSON.parse(detail); } catch { hmBody = detail; }
          const hmDecision = classifyHmSubmission(response.status, hmBody, response.headers);
          if (hmDecision.outcome !== 'rejected' || !isHmStudioConcurrencyError(response.status, detail)) {
            await readHmSubmission(new globalThis.Response(detail, { status: response.status, headers: response.headers }), selectedHmChannel.apiKey);
          }
          // Temporary capacity is not an administrator disabling this channel/key.
          const nextHmChannel = ChannelService.findChannelsForModel(model)
            .find(candidate => isHmStudioChannel(candidate) && !attemptedHmPools.has(hmStudioPoolKey(candidate)));
          if (nextHmChannel && isHmStudioChannel(nextHmChannel) && !attemptedHmPools.has(hmStudioPoolKey(nextHmChannel))) {
            selectedHmChannel = nextHmChannel;
            latestMeta.channelId = nextHmChannel.id;
            latestMeta.channelApiKeyId = nextHmChannel.apiKeyId;
            latestMeta.progressText = '当前 HM Key 暂时满载，正在尝试下一个 Key';
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
                model: fallbackUpstreamModel,
                prompt: String(latestMeta.prompt || latest.inputText || '').trim(),
                duration: Number(latestMeta.seconds) || 6,
                aspectRatio: latestMeta.aspect_ratio || latestMeta.ratio || '16:9',
                images: await prepareWxHaidiYueImageUrls(referenceImages, {
                  publicBaseUrl: latestMeta.publicBaseUrl || process.env.BACKEND_URL,
                  mediaBaseUrl: env.WX_HAIDIYUE_IMAGE_BASE_URL
                    || latestMeta.publicBaseUrl
                    || process.env.BACKEND_URL,
                }),
                videos: referenceVideos.map((source: string) => publishReferenceUrl(source, latestMeta.publicBaseUrl || process.env.BACKEND_URL)),
                audios: referenceAudios.map((source: string) => publishReferenceUrl(source, latestMeta.publicBaseUrl || process.env.BACKEND_URL)),
                faceSplit: latestMeta.local_face_processed
                  ? false
                  : model === WX_HAIDIYUE_FACE_SPLIT_MODEL
                  ? true
                  : resolveWxHaidiYueFaceSplit(fallbackChannel, latestMeta.face_split),
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

            guardBatchSubmissionResponse(Boolean(latestMeta.batchItemId), fallbackResponse);
            if (!fallbackResponse.ok) {
              const fallbackDetail = await fallbackResponse.text().catch(() => '');
              const rejection = submissionFailure(fallbackResponse.status, fallbackDetail, fallbackChannel, true, fallbackResponse.headers);
              if (rejection.confirmedFailure && isHmStudioConcurrencyError(fallbackResponse.status, fallbackDetail)) {
                overflowPlan = findHmStudioOverflowPlan(overflowRequest, attemptedFallbackIds);
                continue;
              }
              throw rejection;
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
            acceptVideoSubmission(contentId, String(fallbackVideoId), { provider: fallbackChannel.type || '', channelId: Number(fallbackChannel.id) || null, channelApiKeyId: Number(fallbackChannel.apiKeyId) || null });
            if (fallbackRecord) void resumePollForTask(contentId, fallbackRecord);
            return;
          }
          throw new HmSubmissionError(upstreamDiagnostic('HM Studio', '提交被拒绝，当前没有可用备用线路', hmBody, selectedHmChannel.apiKey, response.status), 'rejected', response.status);
        }

        const { taskId: videoId } = await readHmSubmission(response, selectedHmChannel.apiKey);

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
        acceptVideoSubmission(contentId, String(videoId), { provider: selectedHmChannel.type || '', channelId: Number(selectedHmChannel.id) || null, channelApiKeyId: Number(selectedHmChannel.apiKeyId) || null });
        if (updatedRecord) await resumePollForTask(contentId, updatedRecord);
      } catch (error) {
        const rejected = error instanceof HmSubmissionError && error.outcome === 'rejected'
          || error instanceof SpecificationUpstreamError && error.confirmedFailure;
        // Detached queue jobs persist failures but their rejected completion may
        // have no HTTP caller. Keep a bounded, redacted task-specific log too.
        console.warn('[hm-video-task]', JSON.stringify({
          contentId, at: new Date().toISOString(), outcome: rejected ? 'rejected' : 'unknown',
          diagnostic: transportDiagnostic('HM Studio', '队列任务异常', error, channel.apiKey || ''),
        }));
        endVideoSubmission(contentId, rejected ? 'rejected' : 'unknown');
        await failHmQueuedVideo(contentId, error, rejected);
        throw error;
      } finally { releaseVideoSubmission(contentId); }
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
  if (liveVideoRequests.has(contentId)) return Promise.resolve();
  if (hayaLiveRequests.has(contentId) || zonghengLiveRequests.has(contentId)) return Promise.resolve();
  record = readVideoRecoveryState(contentId);
  if (!record || !['processing', 'queued', 'review'].includes(record.status)) return Promise.resolve();
  if (videoSubmissionPending(contentId, JSON.parse(record.metadata || '{}'))) return Promise.resolve();
  if (JSON.parse(record.metadata || '{}').managedSpecification) { resumeSpecificationTasks(); return Promise.resolve(); }
  // A queue job becomes "processing" before its POST returns a task ID.
  // Browser detail polling must not fail/refund that in-flight submission.
  // The queue owner starts polling once it has persisted the upstream ID.
  if (hmStudioQueue.has(`video:${contentId}`)) {
    let pendingMeta: Record<string, any> = {};
    try { pendingMeta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata || {}; } catch { }
    if (!savedVideoTaskId(pendingMeta)) return Promise.resolve();
  }
  if (activePolls.has(contentId)) {
    const existingPromise = activePollPromises.get(contentId);
    if (existingPromise) return existingPromise;
    // A poller that terminated unexpectedly in an older process path could leave
    // only the Set marker behind. Clear it so the periodic recovery scan can
    // actually adopt the task again.
    activePolls.delete(contentId);
  }
  activePolls.add(contentId);

  let model = canonicalZonghengModelId(record.modelId || '');
  if (model === 'sdas-xh-sd2.0-933-3-pro-720p') {
    model = 'sdas-pd-sd2.0-pro-933-5-720p';
  }
  const meta = MODEL_META[model];
  let videoId = '';
  let metadata: any = {};
  try {
    metadata = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : (record.metadata || {});
    videoId = savedVideoTaskId(metadata);
  } catch (e) {
    console.error(`[video-recover] Parse metadata failed for task ${contentId}:`, e);
  }
  if (!videoId) {
    activePolls.delete(contentId);
    if (metadata.zonghengSubmissionStarted) {
      reviewZonghengTask(contentId, '纵横科技提交被中断，请核实原订单，禁止重复提交');
    } else if (metadata.hayaSubmissionStarted) {
      reviewHayaTask(contentId, 'Haya 提交被中断，未保存任务 ID，请联系管理员核实，禁止重复提交');
    } else {
      reviewMissingVideoTaskId(contentId);
    }
    return Promise.resolve();
  }

  const configuredChannel = metadata.channelId
    ? ChannelService.getChannelRaw(Number(metadata.channelId), Number(metadata.channelApiKeyId) || null)
    : null;
  if (configuredChannel && isZonghengChannel(configuredChannel) && isRetiredZonghengTask(metadata)) {
    activePolls.delete(contentId); reviewZonghengTask(contentId, RETIRED_ZONGHENG_MESSAGE); return Promise.resolve();
  }
  const originalChannel = configuredChannel && isZonghengChannel(configuredChannel) ? zonghengTaskChannel(configuredChannel, metadata) : configuredChannel;
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
  } else if (model === 'seedance-2.0') {
    const row = db.select().from(settings).where(eq(settings.key, 'seedance_2_0_rate')).get();
    rate = parseFloat(row?.value || '1.50');
  } else if (model === 'sora-v4-pro') {
    const row = db.select().from(settings).where(eq(settings.key, 'sora_v4_pro_rate')).get();
    rate = parseFloat(row?.value || '0.25');
  } else if (model === 'sd2-c7') {
    const row = db.select().from(settings).where(eq(settings.key, 'sd2_c7_rate')).get();
    rate = parseFloat(row?.value || '0.50');
  } else if (model === SI_YUE_TIAN_PRIMARY_VIDEO_MODEL) {
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
    'seedance-2.0',
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
  const isSoraV4 = model === 'sora-v4-fast' || model === 'sora-v4-pro';
  const isSudaShui = meta?.series === 'sudashui';
  const isHmStudio = isHmStudioChannel(channel);
  const isWxHaidiYue = isWxHaidiYueChannel(channel);
  const isSnumomWan = isSnumomWanChannel(channel);
  const isLongxia = isLongxiaChannel(channel);
  const isMiaowu = isMiaowuChannel(channel);
  const isHaya = isHayaChannel(channel);
  const isZongheng = isZonghengChannel(channel);
  const protectedPolling = !isHaya && !isZongheng && protectsVideoPolling(channel, metadata);
  const zonghengApiProtocol = zonghengProtocol(channel, metadata);
  let zonghengInitialTask = metadata.zonghengInitialTask;
  let zonghengDelay = Number(metadata.zonghengPollDelay) || 20_000;

  const headers: Record<string, string> = {};
  if (channel.apiKey) headers['Authorization'] = `Bearer ${channel.apiKey}`;

  const pollingPromise = (async () => {
    try {
      console.log(`[video-recover] Starting polling for video task ${contentId} (videoId: ${videoId})`);
      const pollInterval = isLongxia ? 30_000 : 5000;
      const startTime = Date.now();
      const createdAt = parseUtcTimestamp(metadata.recoveryPollingStartedAt || record.createdAt);
      const timeoutStartedAt = Number.isFinite(createdAt) ? createdAt : startTime;
      const pollTimeoutMs = Number.isFinite(env.VIDEO_TASK_POLL_TIMEOUT_MS) && env.VIDEO_TASK_POLL_TIMEOUT_MS > 0
        ? env.VIDEO_TASK_POLL_TIMEOUT_MS
        : 1_800_000;

      let consecutiveTransientPollFailures = 0;
      const maxTransientPollFailures = 6;
      let hasPolledUpstream = false;
      while (true) {
      const currentRecord = db.select().from(contents).where(eq(contents.id, contentId)).get();
      if (!currentRecord || currentRecord.status !== 'processing') {
        console.log(`[video-recover] Task ${contentId} is no longer in processing status (or was deleted)`);
        break;
      }

      // A recovered task may already be older than the normal polling window
      // while the upstream result is available. Always perform one upstream
      // check before declaring such a task timed out.
      if (!isHaya && !isZongheng && !metadata.batchItemId && hasPolledUpstream && Date.now() - timeoutStartedAt >= pollTimeoutMs) {
        const timeoutMinutes = Math.max(1, Math.round(pollTimeoutMs / 60_000));
        await failHmQueuedVideo(contentId, new Error(`Video generation timed out after ${timeoutMinutes} minutes`));
        break;
      }

      if (!zonghengInitialTask) await new Promise(r => setTimeout(r, isZongheng ? zonghengDelay : isHaya ? hayaPollDelay(consecutiveTransientPollFailures) : pollInterval));

      try {
        hasPolledUpstream = true;
        let pollUrl = `${baseUrl}/v1/videos/${videoId}`;
        if (isZongheng) {
          pollUrl = zonghengTaskUrl(baseUrl, videoId);
        } else if (isHaya) {
          pollUrl = hayaTaskUrl(baseUrl, videoId);
        } else if (isHmStudio) {
          pollUrl = hmStudioTaskUrl(baseUrl, videoId);
        } else if (isWxHaidiYue) {
          pollUrl = wxHaidiYueTaskUrl(baseUrl, videoId);
        } else if (isLongxia) {
          pollUrl = longxiaVideoTaskUrl(baseUrl, videoId);
        } else if (isMiaowu) {
          pollUrl = miaowuVideoTaskUrl(baseUrl, videoId);
        } else if (isSudaShui) {
          pollUrl = `${baseUrl}/v1/video/generations/${videoId}`;
        }

        const pollResp = isZongheng && zonghengInitialTask ? globalThis.Response.json(zonghengInitialTask) : isZongheng
          ? await queryZonghengTask(videoId, Number(metadata.channelId) || undefined, Number(metadata.channelApiKeyId) || null, channel, metadata)
          : protectedPolling ? await fetchVideoTaskResponse(pollUrl, { headers })
          : await fetch(pollUrl, { headers, signal: AbortSignal.timeout(15_000) });

        if (!pollResp.ok) {
          const detail = await pollResp.text().catch(() => '');
          const failureMessage = formatVideoPollHttpFailure(pollResp.status, detail);
          if (isSnumomWan && ++consecutiveTransientPollFailures < maxTransientPollFailures) continue;
          if (protectedPolling) {
            noteVideoQueryProblem(contentId, failureMessage);
            continue;
          }
          if (isHaya || isZongheng) {
            consecutiveTransientPollFailures++;
            if (isZongheng) zonghengDelay = v6kQueryRetryDelay(consecutiveTransientPollFailures, pollResp.headers.get('retry-after'));
            if (contentId !== null) (isZongheng ? patchZonghengTask : patchHayaTask)(contentId, { progressText: '查询暂时不可用，继续查询原任务，不会重复生成' });
            continue;
          }
          if (metadata.batchItemId) {
            noteBatchQueryProblem(contentId, '上游状态查询暂时不可用，正在查询原任务，不会重复生成');
            continue;
          }
          if (isWxHaidiYue && isTransientVideoPollHttpStatus(pollResp.status)) {
            consecutiveTransientPollFailures++;
            if (consecutiveTransientPollFailures < maxTransientPollFailures) {
              console.warn(`[video-recover] ${failureMessage}; retrying (${consecutiveTransientPollFailures}/${maxTransientPollFailures})`);
              continue;
            }
          }
          console.error(`[video-recover] ${failureMessage}`);
          await failHmQueuedVideo(contentId, new Error(failureMessage));
          break;
        }

        if (!isHaya) consecutiveTransientPollFailures = 0;
        const statusData = await pollResp.json() as any;
        if (zonghengInitialTask) { zonghengInitialTask = undefined; if (contentId !== null) patchZonghengTask(contentId, { zonghengInitialTask: undefined }); }
        if (db.select().from(contents).where(eq(contents.id, contentId)).get()?.status !== 'processing') break;
        if (protectedPolling && (isVideoQueryErrorPayload(statusData)
          || ((statusData.task_id || statusData.id) && String(statusData.task_id || statusData.id) !== videoId))) {
          noteVideoQueryProblem(contentId, '查询响应异常或任务 ID 不一致');
          continue;
        }
        let taskStatus = statusData.status;
        clearVideoQueryProblem(contentId);
        let progress = statusData.progress || 0;
        let resultUrl = '';
        let errMsg = '';
        let snumomBillingUsage: ReturnType<typeof normalizeSnumomWanTask>['billingUsage'] = null;

        if (isZongheng) {
          const normalized = normalizeZonghengTask(statusData, baseUrl, zonghengApiProtocol, videoId);
          taskStatus = normalized.status; progress = normalized.progress; resultUrl = normalized.resultUrl; errMsg = normalized.error;
          zonghengDelay = normalized.pollDelay;
        } else if (isHaya) {
          const normalized = normalizeHayaTask(statusData, baseUrl, videoId);
          consecutiveTransientPollFailures = 0;
          taskStatus = normalized.status; progress = normalized.progress; resultUrl = normalized.resultUrl; errMsg = normalized.error;
        } else if (isHmStudio) {
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
        } else if (isLongxia) {
          const normalized = normalizeLongxiaVideoTask(statusData);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || 'LongXia 视频生成失败';
        } else if (isMiaowu) {
          const normalized = normalizeMiaowuVideoTask(statusData, baseUrl, videoId);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || '喵呜 API 视频生成失败';
        } else if (isSnumomWan) {
          const normalized = normalizeSnumomWanTask(statusData, Number(metadata.referenceVideoSeconds) || 0);
          taskStatus = normalized.status;
          progress = normalized.progress;
          resultUrl = normalized.resultUrl;
          errMsg = normalized.error || 'snumom 视频生成失败';
          snumomBillingUsage = normalized.billingUsage;
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

        if (!isHaya && !isZongheng && isVideoFailurePayload(statusData)) {
          if (metadata.batchItemId && isBatchQueryUncertain(statusData, taskStatus)) {
            noteBatchQueryProblem(contentId, '上游查询返回异常，继续核实原任务');
            continue;
          }
          taskStatus = 'failed';
          errMsg = extractVideoFailureMessage(statusData) || errMsg || '视频生成失败';
        }

        console.log(`[video-recover] Polling task ${contentId}: taskId=${videoId} status=${taskStatus} progress=${progress}%`);

        if (taskStatus === 'processing' || taskStatus === 'queued' || taskStatus === 'pending' || taskStatus === 'submitted' || taskStatus === 'generating' || taskStatus === 'post_processing' || taskStatus === 'finalizing' || taskStatus === 'in_progress') {
          try {
            const meta = JSON.parse(currentRecord.metadata || '{}');
            meta.progress = progress;
            meta.upstreamStatus = taskStatus;
            if (protectedPolling) { delete meta.upstreamQueryError; meta.progressText = `视频生成中 ${progress}%`; }
            if (isZongheng) Object.assign(meta, zonghengTaskMetadata(statusData, baseUrl, zonghengApiProtocol, videoId));
            if (isHmStudio) {
              const progressText = normalizeHmStudioTask(statusData, baseUrl).progressText;
              if (progressText) meta.progressText = progressText;
            }
            db.update(contents).set({ metadata: JSON.stringify(meta) }).where(eq(contents.id, contentId)).run();
          } catch { }
        } else if (taskStatus === 'completed' || taskStatus === 'success') {
          if (!resultUrl) {
            if (protectedPolling) {
              noteVideoQueryProblem(contentId, '上游已完成，等待视频地址');
              continue;
            }
            if (isZongheng) {
              patchZonghengTask(contentId, {upstreamStatus:taskStatus,upstreamGenerated:true,upstreamDeliveryPending:true,progress:99,progressText:'视频已生成，正在等待结果交付'});
              continue;
            }
            if (metadata.batchItemId) {
              noteBatchQueryProblem(contentId, '上游已完成，等待视频链接，不会重复生成');
              continue;
            }
            await failHmQueuedVideo(contentId, new Error('上游任务已完成，但没有返回视频链接'));
            break;
          }
          console.log(`[video-recover] ✅ Generating completed: ${resultUrl}`);
          const latest = db.select().from(contents).where(eq(contents.id, contentId)).get();
          const savingMetadata = JSON.parse(latest?.metadata || '{}');
          db.update(contents).set({ metadata: JSON.stringify({ ...savingMetadata, ...(isZongheng ? zonghengTaskMetadata(statusData, baseUrl, zonghengApiProtocol, videoId) : {}), progress: 100, upstreamStatus: taskStatus, upstreamResultUrl: resultUrl, progressText: '视频已生成，正在保存到本站存储' }) }).where(eq(contents.id, contentId)).run();
          let finalVideoUrl = '';
          try {
            if (resultUrl && resultUrl.includes('llm.chre3.com')) {
              finalVideoUrl = isZongheng || protectedPolling
                ? await withVideoPollDeadline(() => localizeChre3Video(resultUrl, videoId, model), 360_000, 'Video result storage')
                : await localizeChre3Video(resultUrl, videoId, model);
            } else {
              finalVideoUrl = isZongheng || protectedPolling
                ? await withVideoPollDeadline(() => downloadAndLocalizeVideo(resultUrl, videoId, model, metadata.channelId, metadata.channelApiKeyId), 360_000, 'Video result storage')
                : await downloadAndLocalizeVideo(resultUrl, videoId, model, metadata.channelId, metadata.channelApiKeyId);
            }
          } catch (localErr: any) {
            console.error(`[video-recover] VPS localization failed; will retry: ${localErr.message}`);
            continue;
          }

          if (db.select().from(contents).where(eq(contents.id, contentId)).get()?.status !== 'processing') break;
          const completedTime = Date.now();
          const createdTime = parseUtcTimestamp(currentRecord.createdAt);
          const durationMs = (!isNaN(createdTime) && createdTime > 0 && completedTime >= createdTime)
            ? (completedTime - createdTime)
            : (Date.now() - startTime);

          logUsage(record.userId, 'generate_video', undefined, durationMs);
          const cost = metadata.batchItemId ? 0 : (metadata.pricingSnapshot || metadata.billingReservationId ? Number(record.cost) : (Number(record.cost) || PricingService.calculateUsageCost(model, {
            resolution,
            seconds: Number(video_length) || 0,
            count: 1,
          })));
          let meta = {};
          try {
            meta = JSON.parse(currentRecord.metadata || '{}');
          } catch { }
          meta = {
            ...meta,
            progress: 100,
            upstreamStatus: taskStatus,
            queueStatus: 'completed',
            queuePosition: 0,
            upstreamResultUrl: resultUrl || (meta as any).upstreamResultUrl,
            localizedAt: new Date(completedTime).toISOString(),
            durationMs,
            completedAt: new Date(completedTime).toISOString()
          };
          delete (meta as Record<string, any>).progressText;
          if (metadata.recoveryPrecharged) {
            Object.assign(meta, { billingStatus: 'charged_after_recovery', requiresReview: false, upstreamStatus: taskStatus });
            delete (meta as any).upstreamQueryError;
          }
          if (isHaya) {
            delete (meta as Record<string, any>).hayaNeedsReview;
            delete (meta as Record<string, any>).error;
          }
          const actualQuote = snumomBillingUsage && isSnumomWan30VideoModel(model) && metadata.pricingSnapshot
            ? PricingService.quoteSnapshot(metadata.pricingSnapshot, {
                resolution: snumomBillingUsage.resolution || resolution,
                seconds: snumomBillingUsage.billableSeconds,
                count: 1,
              })
            : null;
          if (snumomBillingUsage) Object.assign(meta, { upstreamBillingUsage: snumomBillingUsage });
          try {
          if (finalizeReservedContent(contentId, 'completed', meta, finalVideoUrl)) break;
          if (finalizeLegacyVideo(contentId, 'completed', meta, finalVideoUrl, 1, actualQuote?.cost)) break;
          if (actualQuote && !metadata.batchItemId) {
            const settlement = settleDirectVideoBilling(contentId, actualQuote.cost, meta, finalVideoUrl);
            if (settlement.settled) break;
          }
          db.update(contents).set({
            status: 'completed',
            resultUrl: finalVideoUrl,
            cost: metadata.batchItemId ? sql`cost` : cost,
            metadata: JSON.stringify(meta)
          }).where(eq(contents.id, contentId)).run();
          } catch (error: any) {
            db.update(contents).set({ resultUrl: finalVideoUrl }).where(eq(contents.id, contentId)).run();
            reviewUncertainVideoTask(contentId, error.message || '生成结果已保留，费用结算待核实', 'settlement', videoId);
          }
          break;
        } else if (isVideoFailureStatus(taskStatus)) {
          console.error(`[video-recover] ❌ Generating failed: ${errMsg}`);
          // 任务失败，为预扣费退款并将 cost 清零
          await failHmQueuedVideo(contentId, new Error(errMsg), true);
          break;
        }
      } catch (err: any) {
        if (protectedPolling) noteVideoQueryProblem(contentId, err.message || '查询连接异常');
        if (isHaya) consecutiveTransientPollFailures++;
        console.warn(`[video-recover] Polling exception for task ${contentId}: ${err.message}`);
      }
      }
    } catch (err: any) {
      // Keep the DB task recoverable. The periodic scan (and API status reads)
      // can start a fresh poller after this marker is released.
      console.error(`[video-recover] Poller terminated unexpectedly for task ${contentId}: ${err?.message || err}`);
    } finally {
      activePolls.delete(contentId);
      activePollPromises.delete(contentId);
      console.log(`[video-recover] Task ${contentId} polling terminated.`);
    }
  })();
  activePollPromises.set(contentId, pollingPromise);
  return pollingPromise;
}

export function holdZonghengSubmission(id: number) { zonghengLiveRequests.add(id); activePolls.add(id); }
export function releaseZonghengSubmission(id: number) { zonghengLiveRequests.delete(id); activePolls.delete(id); }
export function holdHayaSubmission(contentId: number) { hayaLiveRequests.add(contentId); activePolls.add(contentId); }
export function releaseHayaSubmission(contentId: number) { hayaLiveRequests.delete(contentId); activePolls.delete(contentId); }

export function resumeAllPendingVideoTasks() {
  resumeSpecificationTasks();
  console.log('🔍 [video-recover] Scanning for queued and processing video tasks...');
  try {
    const pendingTasks = db.select().from(contents)
      .where(eq(contents.type, 'video'))
      .all()
      .filter(record => record.status === 'queued' || record.status === 'processing' || record.status === 'review');
    console.log(`🔍 [video-recover] Found ${pendingTasks.length} pending video tasks to recover`);

    pendingTasks.forEach((record: any) => {
      const contentId = record.id;
      if (liveVideoRequests.has(contentId)) return;
      if (hayaLiveRequests.has(contentId) || zonghengLiveRequests.has(contentId)) return;
      record = readVideoRecoveryState(contentId);
      if (!record || !['processing', 'queued', 'review'].includes(record.status)) return;
      let metadata: Record<string, any> = {};
      try { metadata = JSON.parse(record.metadata || '{}'); } catch { }
      if (metadata.managedSpecification) return;
      if (videoSubmissionPending(contentId, metadata)) return;
      if (record.status === 'review') return;
      if (metadata.billingReservationId && metadata.billingSubmissionStarted && !metadata.videoId) {
        finalizeLegacyVideo(contentId, 'review', { error: '上游提交被中断且未保存任务 ID，请核实原任务，禁止重复提交' }); return;
      }
      // A server interruption after POST but before saving its task ID is not a
      // confirmed failure. Never re-submit that batch attempt automatically.
      if (metadata.zonghengSubmissionStarted && !metadata.videoId) {
        if (metadata.zonghengSubmissionDiagnostics?.requestNotSent === true) {
          refundConfirmedZonghengVideo(contentId, '连接生成服务失败，请求未发送');
          return;
        }
        reviewZonghengTask(contentId, '纵横科技提交被中断，请核实原订单，禁止重复提交'); return;
      }
      if (metadata.hayaSubmissionStarted && !metadata.videoId) {
        reviewHayaTask(contentId, 'Haya 提交被中断，未保存任务 ID，请核实原任务');
        return;
      }
      if (metadata.batchItemId && metadata.batchSubmissionStarted && !metadata.videoId) return;
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
      } else {
        void resumePollForTask(contentId, record);
      }
    });
  } catch (err: any) {
    console.error('⚠️ [video-recover] Scan pending tasks failed:', err.message);
  }
}

export default router;
import { upstreamDiagnostic, transportDiagnostic } from '../services/upstreamDiagnostic.js';
