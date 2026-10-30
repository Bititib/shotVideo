import { publicApiModelId, funAiModelKind, funAiModelLimits, FUNAI_MODEL_PREFIX } from '../../shared/funAi.js';
import type { ModelSpecification } from '../../shared/modelRouting.js';
import { getZonghengVideoSpec } from '../../shared/zonghengVideo.js';
import { existingModelLimits } from './modelInputPresets.js';
import { getModelSpecification } from './modelRoutingService.js';
import { getHmStudioAdditionalVideoModel } from '../../shared/hmStudioVideo.js';
import { HUSS_BB_PUBLIC_MODEL, HUSS_HSS_MODEL } from '../../shared/hussBbVideo.js';
import { SI_YUE_TIAN_MINIMAX_MODEL } from '../../shared/siYueTianMinimax.js';
import { HAYA_XG_SEEDANCE_20_MODEL } from '../../shared/hayaVideo.js';
import { isLongxiaModel } from '../../shared/longxiaVideo.js';

export type ParameterRule = {
  type: 'string' | 'integer' | 'number' | 'boolean'; title: string; description?: string;
  enum?: (string | number | boolean)[]; default?: string | number | boolean;
  minimum?: number; maximum?: number; multipleOf?: number; minLength?: number; maxLength?: number;
};
export type ParameterSchema = { type: 'object'; properties: Record<string, ParameterRule>; required: string[]; additionalProperties: false };
// This is a declaration of fields consumed by verified adapters, not a provider-name heuristic.
// Adding an adapter parameter here automatically updates API discovery and plugin controls.
const wanSchema: ParameterSchema = { type: 'object', properties: {
  prompt_extend: { type: 'boolean', title: '提示词智能扩写', description: '由模型扩展提示词；留空使用上游默认行为。' },
}, required: [], additionalProperties: false };
export const VIDEO_PARAMETER_SCHEMAS: Record<string, ParameterSchema> = {
  'wan3.0-video': wanSchema, 'wan3.0-video-prime': wanSchema,
};
const emptySchema = (): ParameterSchema => ({ type: 'object', properties: {}, required: [], additionalProperties: false });

export function videoCapabilities(modelId: string, specification?: ModelSpecification | null) {
  const spec = specification === undefined ? getModelSpecification(modelId) : specification;
  let limits = spec?.kind === 'video' ? spec.limits : existingModelLimits(modelId, 'video');
  if (!spec && limits) {
    // Preset drafts inherit generic ratios. Publish only adapter-confirmed ratios.
    const hm = getHmStudioAdditionalVideoModel(modelId);
    const explicitRatios = [HUSS_BB_PUBLIC_MODEL, HUSS_HSS_MODEL, SI_YUE_TIAN_MINIMAX_MODEL, HAYA_XG_SEEDANCE_20_MODEL].includes(modelId) || isLongxiaModel(modelId);
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
  const ids = spec ? spec.routes.filter(r => r.enabled).map(r => r.executionModel) : [modelId];
  const schemas = ids.map(id => VIDEO_PARAMETER_SCHEMAS[id] || emptySchema());
  const first = schemas[0] || emptySchema();
  const properties = Object.fromEntries(Object.entries(first.properties).filter(([key, rule]) =>
    schemas.every(schema => JSON.stringify(schema.properties[key]) === JSON.stringify(rule))));
  return { canonical_id: publicApiModelId(modelId), capabilityVersion: 1,
    routingLimits, parameterSchema: { ...emptySchema(), properties, required: first.required.filter(k => k in properties) } };
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
