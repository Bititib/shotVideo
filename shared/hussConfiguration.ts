import { HUSS_HSS_B_MODEL, hussHssModelLimits } from './hussBbVideo.js';
import { HUSS_MJ_MODEL, hussMjLimits } from './hussMidjourney.js';
import type { ChannelModelCatalogEntry, ChannelModelDraft } from './channelModelConfiguration.js';
import { allowsDuration } from './modelRouting.js';
import { hussUnifiedModels, hussUnifiedVideoLimits } from './hussUnifiedModels.js';

export const HUSS_CONFIGURATION_PREFIX = 'admin-channel-model-huss-';
/** Only protocols implemented by the HUSS adapters; authorization is checked separately. */
export function hussConfigurationCatalog(): ChannelModelCatalogEntry[] {
  return [
    { id: HUSS_MJ_MODEL, kind: 'image', limits: hussMjLimits() },
    ...hussUnifiedModels.map(m=>({id:m.id,kind:'video' as const,limits:hussUnifiedVideoLimits(m.id)!})),
    { id: HUSS_HSS_B_MODEL, kind: 'video', limits: hussHssModelLimits() },
  ];
}

export function validateHussConfiguration(draft: ChannelModelDraft, entry = hussConfigurationCatalog().find(e => e.id === draft.upstreamModel)) {
  if (!entry || !entry.limits || entry.unavailableReason || draft.kind !== entry.kind) throw new Error(entry?.unavailableReason || 'HUSS 型号与生成类型不匹配，请从已接入的授权型号中选择');
  if (entry.kind === 'image' && draft.modelId !== HUSS_MJ_MODEL) throw new Error('Midjourney V8.2 请保留原本站模型 ID，以使用风格参数和四图交付');
  const l = draft.limits, supported = entry.limits!;
  const rule = l.duration;
  const seconds = rule.mode === 'options' ? rule.values : rule.mode === 'fixed' ? [rule.min]
    : Array.from({length: Math.floor((rule.max-rule.min)/rule.step)+1},(_,i)=>rule.min+i*rule.step);
  const errors: string[] = [];
  if (l.resolutions.some(v=>!supported.resolutions.includes(v))) errors.push('分辨率可选：'+supported.resolutions.join('、'));
  if (l.ratios.some(v=>!supported.ratios.includes(v))) errors.push('比例可选：'+supported.ratios.join('、'));
  if (l.maxImages>supported.maxImages || l.maxVideos>supported.maxVideos || l.maxAudios>supported.maxAudios || l.minImages<supported.minImages) errors.push(`参考素材最多 ${supported.maxImages} 图、${supported.maxVideos} 视频、${supported.maxAudios} 音频`);
  if (supported.maxReferences !== undefined && (l.maxReferences === undefined || l.maxReferences > supported.maxReferences)) errors.push('参考素材合计上限须不超过 '+supported.maxReferences);
  if (l.firstFrame || l.lastFrame) errors.push('不支持独立首尾帧');
  if (l.maxOutputs !== 1 || l.outputsPerTask !== undefined && l.outputsPerTask !== 1) errors.push('每次提交一份任务');
  if (l.qualities.some(v=>!supported.qualities.includes(v))) errors.push('质量档位不受此型号支持');
  if (entry.kind === 'video' && (!seconds.length || seconds.some(v=>!Number.isSafeInteger(v)||!allowsDuration(supported.duration,v)))) errors.push(`时长须为 ${supported.duration.min}–${supported.duration.max} 秒整数`);
  if (errors.length) throw new Error('HUSS 配置不匹配：'+errors.join('；'));
}
