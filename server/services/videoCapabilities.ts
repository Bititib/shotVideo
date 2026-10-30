import { publicApiModelId, funAiModelKind, funAiModelLimits, FUNAI_MODEL_PREFIX } from '../../shared/funAi.js';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { getZonghengVideoSpec } from '../../shared/zonghengVideo.js';
import { existingModelLimits } from './modelInputPresets.js';
import { getModelSpecification } from './modelRoutingService.js';
import { getHmStudioAdditionalVideoModel, getHmStudioPublicVideoModel } from '../../shared/hmStudioVideo.js';
import { HUSS_BB_PUBLIC_MODEL, HUSS_HSS_MODEL } from '../../shared/hussBbVideo.js';
import { SI_YUE_TIAN_MINIMAX_MODEL } from '../../shared/siYueTianMinimax.js';
import { HAYA_XG_SEEDANCE_20_MODEL } from '../../shared/hayaVideo.js';
import { isLongxiaModel } from '../../shared/longxiaVideo.js';
import { SNUMOM_WAN_NSFW_MODEL, SNUMOM_OUTPUT_ONLY_MODELS, isSnumomWanVideoModel } from '../../shared/snumomWanNsfw.js';

export type ParameterRule = {
  type: 'string' | 'integer' | 'number' | 'boolean'; title: string; description?: string;
  enum?: (string | number | boolean)[]; default?: string | number | boolean;
  enumLabels?: string[];
  minimum?: number; maximum?: number; multipleOf?: number; minLength?: number; maxLength?: number;
};
export type ParameterSchema = { type: 'object'; properties: Record<string, ParameterRule>; required: string[]; additionalProperties: false };
// This is a declaration of fields consumed by verified adapters, not a provider-name heuristic.
// Adding an adapter parameter here automatically updates API discovery and plugin controls.
const wanSchema: ParameterSchema = { type: 'object', properties: {
  prompt_extend: { type: 'boolean', title: '提示词智能扩写', description: '由模型扩展提示词；留空使用上游默认行为。' },
}, required: [], additionalProperties: false };
export const VIDEO_PARAMETER_SCHEMAS: Record<string, ParameterSchema> = Object.fromEntries(
  [SNUMOM_WAN_NSFW_MODEL, ...Object.keys(SNUMOM_OUTPUT_ONLY_MODELS)].map(id => [id, wanSchema]));
const emptySchema = (): ParameterSchema => ({ type: 'object', properties: {}, required: [], additionalProperties: false });
const declare = (id: string, properties: Record<string, ParameterRule>) => { VIDEO_PARAMETER_SCHEMAS[id] = { ...emptySchema(), properties }; };
for (const id of ['MiniMax-H3', 'sd2.5-933', 'seedance_v2.0-933']) {
  const multi = id === 'seedance_v2.0-933';
  declare(id, { function_mode: { type: 'string', title: '生成模式',
    enum: [multi ? 'multi_frame' : 'first_last_frames', 'omni_reference'],
    enumLabels: [multi ? '多帧关键帧' : '首尾帧 / 纯文本', '混合素材参考'],
    description: multi ? '多帧需 2–9 张图片，不能带视频或音频；混合素材可使用图片、视频和音频。留空自动判断。'
      : '首尾帧模式最多使用前后两张普通参考图，不能带视频或音频；混合素材按素材顺序引用。留空自动判断。' } });
}
for (const id of ['funai-veo-3.1', 'funai-veo-3.1-lite']) declare(id, {
  audio: { type: 'boolean', title: '生成音轨', description: '控制生成结果是否带音轨；不是上传参考音频。留空使用上游默认行为。' },
});
declare('funai-gemini-omni-flash', { reference_mode: { type: 'string', title: '参考图用途',
  enum: ['frame', 'style', 'element'], enumLabels: ['首帧', '风格参考', '元素参考'],
  description: '普通参考图按所选角色发送；首帧最多 1 张、元素最多 3 张、风格最多 4 张，同时受网站素材数量上限限制。图片与源视频合计最多 4 项。留空使用元素参考。' } });

const parameterNotes: Record<string, string> = {
  'hss-2.5-301010': '已核对 HUSS 视频契约：当前没有额外生成参数；不转发种子、负面提示词或音轨开关。',
  'hss-2.5-301010-渠道B': '已核对 HUSS 统一视频契约：当前没有额外生成参数；使用上方基础规格和参考素材。',
  'grok-imagine-video-1.5': '已核对该渠道 Grok 1.5 文档：没有列出种子、负面提示词或音轨开关，不套用其他渠道参数。',
};

export function videoCapabilities(modelId: string, specification?: ModelSpecification | null) {
  const spec = specification === undefined ? getModelSpecification(modelId) : specification;
  let limits = spec?.kind === 'video' ? spec.limits : existingModelLimits(modelId, 'video');
  if (!spec && limits) {
    // Preset drafts inherit generic ratios. Publish only adapter-confirmed ratios.
    const hm = getHmStudioAdditionalVideoModel(modelId);
    const explicitRatios = [HUSS_BB_PUBLIC_MODEL, HUSS_HSS_MODEL, SI_YUE_TIAN_MINIMAX_MODEL, HAYA_XG_SEEDANCE_20_MODEL].includes(modelId) || isLongxiaModel(modelId) || isSnumomWanVideoModel(modelId);
    limits = { ...limits, ratios: hm?.ratios ? [...hm.ratios] : explicitRatios ? limits.ratios : [] };
  }
  if (!limits && modelId.startsWith(FUNAI_MODEL_PREFIX) && funAiModelKind(publicApiModelId(modelId)) === 'video') {
    limits = funAiModelLimits(publicApiModelId(modelId));
  }
  const zh = getZonghengVideoSpec(modelId);
  // Never replace unknown capabilities with defaultRoutingLimits guesses.
  const routingLimits = !spec && zh ? {
    maxImages: zh.references.images, maxVideos: zh.references.videos, maxAudios: zh.references.audios,
    maxOutputs: 1, minImages: 0, firstFrame: false, lastFrame: false, qualities: [],
    resolutions: [zh.resolution], ratios: 'ratios' in zh ? [...zh.ratios] : [],
    duration: { mode: 'options' as const, values: [...zh.seconds], min: zh.seconds[0], max: zh.seconds.at(-1)!, step: 1 },
  } : limits || undefined;
  // Managed models can use several adapters: only advertise a field every enabled route consumes.
  const ids = (spec ? spec.routes.filter(r => r.enabled).map(r => r.executionModel) : [modelId]).map(getHmStudioPublicVideoModel);
  const schemas = ids.map(id => VIDEO_PARAMETER_SCHEMAS[id] || emptySchema());
  const first = schemas[0] || emptySchema();
  const properties = Object.fromEntries(Object.entries(first.properties).filter(([key, rule]) =>
    schemas.every(schema => JSON.stringify(schema.properties[key]) === JSON.stringify(rule))));
  return { canonical_id: publicApiModelId(modelId), capabilityVersion: 1,
    routingLimits, parameterNote: ids.length === 1 ? parameterNotes[ids[0]] : undefined,
    parameterEnumLabels: Object.fromEntries(Object.entries(properties).filter(([, rule]) => rule.enumLabels).map(([key, rule]) => [key, rule.enumLabels])),
    parameterSchema: { ...emptySchema(), properties: Object.fromEntries(Object.entries(properties).map(([key, { enumLabels, ...rule }]) => [key, rule])), required: first.required.filter(k => k in properties) } };
}

/** Called before reservations on both native and external API paths. Multipart uses JSON scalar spelling. */
export function normalizeVideoParameters(body: Record<string, any>, schema: ParameterSchema, multipart = false) {
  let supplied = body.model_parameters ?? {};
  if (multipart && typeof supplied === 'string') {
    try { supplied = JSON.parse(supplied); } catch { throw new Error('model_parameters 必须为 JSON 对象'); }
  }
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).length > 48) throw new Error('model_parameters 必须为参数对象');
  for (const key of Object.keys(supplied)) if (!Object.hasOwn(schema.properties, key)) throw new Error('模型不支持参数：' + key);
  for (const [key, rule] of Object.entries(schema.properties)) {
    let value = Object.hasOwn(supplied, key) ? supplied[key] : body[key];
    if (key === 'prompt_extend' && body.parameters?.prompt_extend !== undefined) {
      if (value !== undefined && value !== body.parameters.prompt_extend) throw new Error('prompt_extend 参数冲突');
      value = body.parameters.prompt_extend;
    }
    if (value === undefined) { if (schema.required.includes(key)) throw new Error('缺少参数：' + key); continue; }
    if (multipart && !Object.hasOwn(supplied, key) && typeof value === 'string') {
      if (rule.type === 'boolean' && ['true', 'false'].includes(value)) value = value === 'true';
      if (['integer', 'number'].includes(rule.type) && value.trim()) value = Number(value);
    }
    if (Object.hasOwn(supplied, key) && body[key] !== undefined && body[key] !== value) throw new Error('参数重复且不一致：' + key);
    const validType = rule.type === 'string' ? typeof value === 'string' : rule.type === 'boolean' ? typeof value === 'boolean'
      : typeof value === 'number' && Number.isFinite(value) && (rule.type !== 'integer' || Number.isSafeInteger(value));
    if (!validType || (rule.enum && !rule.enum.includes(value))) throw new Error('参数类型或选项无效：' + key);
    if (typeof value === 'number' && ((rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)
      || (rule.multipleOf && Math.abs(value / rule.multipleOf - Math.round(value / rule.multipleOf)) > 1e-8))) throw new Error('参数数值超出规格：' + key);
    if (typeof value === 'string' && (value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? 20000))) throw new Error('参数文本长度超出规格：' + key);
    body[key] = value;
  }
  delete body.model_parameters;
}
