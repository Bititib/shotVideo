import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

export const FUNAI_BASE_URL = 'https://ztyunjuan.com';
export const FUNAI_MODEL_PREFIX = 'funai-';
export const FUNAI_IMAGE_MODELS = [
  'gpt-image-2', 'gpt-image-medium', 'nano-banana', 'gemini-2.5-flash-image',
  'nano-banana-pro', 'gemini-3-pro-image', 'gemini-3-pro-image-preview',
  'nano-banana2', 'gemini-3.1-flash-image-preview',
] as const;
export const FUNAI_VIDEO_MODELS = [
  'minimax-h3', 'kling-o3', 'kling-o3-pro-v2v-reference', 'kling-o3-standard-v2v-reference',
  'kling-v3', 'kling-v3-omni-v2v-create', 'runway-gen4-turbo', 'runway-gen4.5',
  'happy-horse', 'happy-horse-1.1', 'sora-2', 'sora-2-pro', 'gemini-omni', 'gemini-omni-flash',
  'veo-3.1', 'veo-3.1-fast', 'veo-3.1-lite', 'veo-3.1-fl', 'veo-3.1-fast-fl',
] as const;
const imageRatios = ['1:1', '5:4', '9:16', '21:9', '16:9', '3:2', '4:3', '4:5', '3:4', '2:3'];
const wideRatios = ['16:9', '9:16'];
export function funAiModelKind(model: string): 'image' | 'video' | null {
  return (FUNAI_IMAGE_MODELS as readonly string[]).includes(model) ? 'image'
    : (FUNAI_VIDEO_MODELS as readonly string[]).includes(model) ? 'video' : null;
}
export function isFunAiGeminiImage(model: string) {
  return funAiModelKind(model) === 'image' && !model.startsWith('gpt-image-');
}
/** Public docs checked 2026-10-12; discovery controls availability, never guessed IDs. */
export function funAiModelLimits(model: string): ModelInputLimits {
  const kind = funAiModelKind(model);
  if (!kind) throw new Error('FunAI 尚未适配此模型，请核对文档');
  const l = defaultRoutingLimits();
  if (kind === 'image') return { ...l, maxImages: isFunAiGeminiImage(model) ? 14 : 16,
    maxOutputs: 4, resolutions: ['1K', '2K', '4K'], ratios: [...imageRatios],
    qualities: model === 'gpt-image-2' ? ['low', 'medium', 'high'] : model === 'gpt-image-medium' ? ['medium'] : [] };
  const result: ModelInputLimits = { ...l, ratios: [...wideRatios] };
  const range = (min: number, max: number) => { result.duration = { mode: 'range', min, max, step: 1, values: [] }; };
  const options = (values: number[]) => { result.duration = { mode: values.length === 1 ? 'fixed' : 'options', min: values[0], max: values.at(-1)!, step: 1, values }; };
  if (model === 'minimax-h3') {
    range(5, 15); result.maxImages = 5; result.maxAudios = 3; result.firstFrame = result.lastFrame = true;
    result.resolutions = ['1440p']; result.ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
  } else if (model.startsWith('kling-')) {
    range(3, 15);
    if (model === 'kling-o3' || model === 'kling-v3') {
      result.maxImages = model === 'kling-o3' ? 6 : 2;
      result.maxVideos = model === 'kling-o3' ? 1 : 0;
      result.firstFrame = result.lastFrame = true;
      result.ratios = ['16:9', '1:1', '9:16']; result.resolutions = ['720p', '1080p', '4K'];
    } else {
      result.maxImages = model === 'kling-v3-omni-v2v-create' ? 6 : 4; result.maxVideos = 1;
      result.firstFrame = result.lastFrame = model !== 'kling-v3-omni-v2v-create';
    }
  } else if (model.startsWith('runway-')) {
    options(model === 'runway-gen4-turbo' ? [5, 10] : [5, 8, 10]); result.maxImages = 1; result.firstFrame = true;
    result.minImages = model === 'runway-gen4-turbo' ? 1 : 0;
  } else if (model.startsWith('happy-horse')) {
    range(3, 15); result.maxImages = 9; result.maxVideos = model === 'happy-horse' ? 1 : 0;
    result.firstFrame = true; result.resolutions = ['720p', '1080p']; result.ratios = ['16:9', '9:16', '1:1', '4:3', '3:4'];
  } else if (model.startsWith('sora-')) {
    options([4, 8, 12]); result.maxImages = 1; result.firstFrame = true;
  } else if (model.startsWith('gemini-omni')) {
    range(3, 10);
    // Flash docs conflict about ordinary references. Use the explicit role protocol
    // and its smaller element limit until the provider confirms broader support.
    result.maxImages = model === 'gemini-omni' ? 5 : 3;
    result.maxVideos = model === 'gemini-omni' ? 0 : 1; result.firstFrame = model !== 'gemini-omni';
  } else {
    options(model.includes('-fast') ? [8] : [4, 6, 8]); result.resolutions = ['720p', '1080p'];
    const frames = model.endsWith('-fl') || model === 'veo-3.1-lite';
    result.maxImages = frames ? 2 : 3; result.firstFrame = result.lastFrame = frames;
  }
  return result;
}
