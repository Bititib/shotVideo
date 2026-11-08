import { routingMismatches, type ModelInputLimits, type RoutingInput } from './modelRouting.js';
import { zhiyingReferenceMentions } from './zhiyingReferences.js';

export const ZHIYING_BASE_URL = 'https://zhiyingai.xyz';
export const ZHIYING_CHANNEL_TYPE = 'zhiying';
export const ZHIYING_VIDEO_MODELS = ['sd-2.5-fullblood', 'sd-2.5-fullblood-line2'] as const;
export type ZhiyingVideoModel = typeof ZHIYING_VIDEO_MODELS[number];

/** Accept both forms shown in the provider's instructions, without forwarding credentials to another host. */
export function zhiyingApiBase(baseUrl?: string | null): string {
  const value = (baseUrl?.trim() || ZHIYING_BASE_URL).replace(/\/+$/, '');
  if (value !== ZHIYING_BASE_URL && value !== ZHIYING_BASE_URL + '/v1') {
    throw Object.assign(new Error('智赢渠道地址必须为 https://zhiyingai.xyz 或 https://zhiyingai.xyz/v1'), { status: 400 });
  }
  return ZHIYING_BASE_URL;
}

export function isZhiyingVideoModel(id: unknown): id is ZhiyingVideoModel {
  return ZHIYING_VIDEO_MODELS.some(model => model === id);
}

const products = {
  'sd-2.5-fullblood': { displayName: 'Lx-Seedance2.5-1', promptMax: 20000 },
  'sd-2.5-fullblood-line2': { displayName: 'Lx-Seedance2.5-2', promptMax: 45000 },
} as const;

export function zhiyingVideoDisplayName(id: unknown): string | undefined {
  return isZhiyingVideoModel(id) ? products[id].displayName : undefined;
}

export function zhiyingVideoInternalId(id: unknown): ZhiyingVideoModel | undefined {
  return isZhiyingVideoModel(id) ? id : ZHIYING_VIDEO_MODELS.find(model => products[model].displayName === id);
}

export function zhiyingVideoSpec(id: ZhiyingVideoModel) {
  const defaultDuration = 30;
  const limits: ModelInputLimits = {
    minImages: 0, maxImages: 30, maxVideos: 10, maxAudios: 10, maxOutputs: 1, maxReferences: 50,
    resolutions: ['720p'],
    ratios: id === 'sd-2.5-fullblood-line2'
      ? ['16:9', '9:16', '1:1', '21:9']
      : ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    duration: { mode: 'range', min: 5, max: 30, step: 1, values: [] },
    defaultSeconds: defaultDuration, firstFrame: false, lastFrame: false, qualities: [],
  };
  return { ...products[id], defaultDuration, limits };
}

export function validateZhiyingVideoInput(model: ZhiyingVideoModel, prompt: string, input: RoutingInput): string[] {
  const { limits, promptMax } = zhiyingVideoSpec(model);
  const reasons = routingMismatches(limits, input, 'video');
  if (!prompt.trim()) reasons.push('请输入视频描述');
  if (Array.from(prompt).length > promptMax) reasons.push(`${model} 提示词最多 ${promptMax} 个字符`);
  // Canvas emits these one-based labels after resolving stable node bindings.
  // Copied prompts can retain a label after its media was removed; never submit
  // that dangling reference as if uploading the remaining files made it valid.
  const counts = { 图片: input.images, 视频: input.videos, 音频: input.audios };
  for (const mention of zhiyingReferenceMentions(prompt)) {
    const { kind, index } = mention;
    if (!Number.isSafeInteger(index) || index < 1 || index > counts[kind]) {
      const reason = `提示词中的${mention.text}没有对应素材，本次实际提交${counts[kind]}个${kind}参考。请补齐素材或修正引用编号。`;
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return reasons;
}
