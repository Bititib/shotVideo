import { createHash } from 'node:crypto';
import { isConfiguredZhiyingModel as isZhiyingVideoModel, configuredZhiyingProfile } from './zhiyingModelRegistry.js';

const referenceAliases = {
  reference_images: ['reference_images', 'image_urls', 'image_url', 'images', 'image_refs', 'reference_image_urls', 'Ingredients_images'],
  reference_videos: ['reference_videos', 'reference_video', 'video_urls', 'video_url', 'videos', 'video_refs', 'reference_video_urls'],
  audio_urls: ['audio_urls', 'audio_url', 'reference_audios', 'audios', 'audio_refs', 'reference_audio_urls'],
};
const permittedFields = new Set([
  'model', 'prompt', 'resolution', 'output_resolution', 'ratio', 'aspect_ratio', 'duration', 'duration_seconds', 'seconds', 'video_length', 'n',
  'canvasRequestId', 'expectedCost', 'local_face_processed', // local client bookkeeping
  ...Object.values(referenceAliases).flat(),
]);

/** Normalize the supported models before adding defaults or merging multipart uploads. */
export function normalizeZhiyingRequest(body: Record<string, any>, defaultSeconds?: number): void {
  if (!isZhiyingVideoModel(body.model)) return;
  const profile = configuredZhiyingProfile(body.model);
  if (body.reference_mode !== undefined && !profile?.referenceMode || body.reference_image_processing !== undefined && !profile?.directProcessing) throw new Error('当前上游型号未声明支持该素材处理参数');
  if (body.resolution === undefined && body.output_resolution === undefined) body.resolution = profile?.limits.resolutions[0];
  if (body.ratio === undefined && body.aspect_ratio === undefined) body.aspect_ratio = profile?.limits.ratios[0];
  for (const field of Object.keys(body)) {
    if (field === 'reference_mode' && body[field] === 'multi_reference'
      || field === 'reference_image_processing' && body[field] === 'direct') continue;
    if (body[field] !== undefined && !permittedFields.has(field)) throw new Error('该视频型号不支持参数：' + field);
  }
  if (body.prompt !== undefined && typeof body.prompt !== 'string') throw new Error('提示词必须为文本');
  const durations = ['duration', 'duration_seconds', 'seconds', 'video_length'].filter(key => body[key] !== undefined);
  if (durations.length) {
    if (durations.some(key => !['number','string'].includes(typeof body[key]) || !Number.isSafeInteger(Number(body[key])) || Number(body[key]) <= 0)
      || new Set(durations.map(key => Number(body[key]))).size !== 1) throw new Error('视频时长字段必须一致且为正整数秒');
    body.video_length = Number(body[durations[0]]);
  } else body.video_length = defaultSeconds ?? configuredZhiyingProfile(body.model)?.limits.defaultSeconds;
  for (const key of ['aspect_ratio','ratio','resolution','output_resolution']) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || !body[key].trim())) throw new Error(key + ' 必须为有效文本');
  }
  if (body.aspect_ratio !== undefined && body.ratio !== undefined && body.aspect_ratio !== body.ratio) throw new Error('aspect_ratio 与 ratio 不一致');
  if (body.resolution !== undefined && body.output_resolution !== undefined && String(body.resolution).toLowerCase() !== String(body.output_resolution).toLowerCase()) throw new Error('resolution 与 output_resolution 不一致');
  for (const [field, aliases] of Object.entries(referenceAliases)) {
    const used = aliases.filter(key => body[key] !== undefined && (!Array.isArray(body[key]) || body[key].length));
    if (used.length > 1) throw new Error('同类素材必须使用一个字段：' + used.join(' / '));
    if (used.length && (body[used[0]] === null || body[used[0]] === '')) throw new Error('参考素材字段不能为空，请省略该字段或传入数组');
    if (used.length) body[field] = body[used[0]];
    for (const alias of aliases) if (alias !== field) delete body[alias];
  }
}

export function zhiyingCredentialFingerprint(channel: { baseUrl: string; apiKey: string }) {
  return createHash('sha256').update(JSON.stringify([channel.baseUrl.replace(/\/+$/, ''), channel.apiKey])).digest('hex');
}

/** Include the key as well as the exact uploaded file list and its order. */
export function zhiyingPayloadHash(key: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify([key, payload])).digest('hex');
}

export function assertZhiyingOriginalChannel(channel: any, metadata: Record<string, any>): void {
  if (!channel || channel.type !== 'zhiying' || !channel.apiKey || channel.id !== metadata.channelId
    || zhiyingCredentialFingerprint(channel) !== metadata.zhiyingCredential) {
    throw new Error('智赢原渠道或执行密钥已变更，保留原任务和预扣，请恢复原凭据后继续');
  }
}
