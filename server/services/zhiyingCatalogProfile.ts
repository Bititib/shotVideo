import type { ZhiyingModelProfile } from '../../shared/zhiyingModelConfiguration.js';
import { validateLimits } from './modelRoutingService.js';

const officialModels = ['seedance-2.0-official', 'seedance-2.0-fast-official', 'seedance-2.5-official'];
/** Only the ordinary file-reference video protocol is configurable here. */
export function zhiyingCatalogProfile(row: any): ZhiyingModelProfile {
  const fail = (reason: string): never => { throw new Error(reason); };
  if (row.media_type !== 'video' || row.available === false || row.status !== undefined && row.status !== 'available')
    fail('当前目录未开放此视频模型');
  const official = officialModels.includes(row.id), line3 = row.id === 'sd-2.5-fullblood-line3';
  if (row.create_endpoint !== '/v1/generations' && !official && !line3) fail('目录未确认支持 /v1/generations 视频协议');
  if (!Number.isSafeInteger(row.prompt_max) || row.prompt_max < 1 || row.prompt_max > 1000000) fail('目录缺少有效提示词上限');
  const resolutions = Object.keys(row.resolutions || {});
  if (!resolutions.length || resolutions.some(r => !/^\d{3,4}p$/.test(r))) fail('目录缺少有效视频清晰度');
  const durations = resolutions.map(r => row.resolutions[r]?.durations);
  if (durations.some(values => !Array.isArray(values) || !values.length || values.some((n: any) => !Number.isSafeInteger(n) || n <= 0 || n > 3600)))
    fail('目录缺少有效时长');
  // A single sales specification must describe a Cartesian product. Do not silently truncate the provider range.
  const values = [...new Set<number>(durations[0])].sort((a, b) => a - b);
  if (durations.some(items => JSON.stringify([...new Set<number>(items)].sort((a, b) => a - b)) !== JSON.stringify(values)))
    fail('各清晰度时长不同，需分别适配规格后开放');
  const refs = row.reference_limits;
  if (!refs || !['images', 'videos', 'audios'].every(k => Number.isSafeInteger(refs[k]) && refs[k] >= 0)) fail('目录缺少素材数量限制');
  if (!Array.isArray(row.aspect_ratios) || !row.aspect_ratios.length || row.aspect_ratios.some((r: any) => typeof r !== 'string' || !/^\d{1,4}:\d{1,4}$/.test(r)))
    fail('目录缺少有效宽高比');
  if (!values.includes(row.default_duration) || !resolutions.includes(row.default_resolution)) fail('目录默认时长或清晰度无效');
  resolutions.sort((a, b) => Number(b === row.default_resolution) - Number(a === row.default_resolution));
  const ratios: string[] = [...row.aspect_ratios];
  if (row.default_aspect_ratio && !ratios.includes(row.default_aspect_ratio)) fail('目录默认比例无效');
  ratios.sort((a, b) => Number(b === (row.default_aspect_ratio || '16:9')) - Number(a === (row.default_aspect_ratio || '16:9')));
  const profile: ZhiyingModelProfile = {
    limits: { minImages: 0, maxImages: refs.images, maxVideos: refs.videos, maxAudios: refs.audios,
      maxReferences: refs.total ?? refs.images + refs.videos + refs.audios, maxOutputs: 1,
      resolutions, ratios, defaultSeconds: row.default_duration,
      duration: { mode: 'options', min: values[0], max: values[values.length - 1], step: 1, values },
      firstFrame: false, lastFrame: false, qualities: [] },
    promptMax: row.prompt_max,
    videoDurationTotal: !official && !line3 && row.id !== 'sd-2.5-fullblood-line2',
    fileMaxBytes: { image: 20 * 1024 ** 2, video: 100 * 1024 ** 2, audio: 100 * 1024 ** 2 },
    referenceMode: Array.isArray(row.reference_modes) && row.reference_modes.includes('multi_reference'),
    directProcessing: Array.isArray(row.reference_image_processing) && row.reference_image_processing.includes('direct'),
  };
  for (const kind of ['image', 'video', 'audio'] as const) {
    const bytes = typeof row.reference_file_max_bytes === 'number' ? row.reference_file_max_bytes : row.reference_file_max_bytes?.[kind];
    if (bytes !== undefined) {
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 100 * 1024 ** 2) fail('目录素材文件大小超出本站已支持范围');
      profile.fileMaxBytes[kind] = bytes;
    }
  }
  if (row.reference_av_duration_total_max !== undefined) {
    if (!Number.isFinite(row.reference_av_duration_total_max) || row.reference_av_duration_total_max <= 0) fail('目录音视频合计时长限制无效');
    profile.avDurationMax = row.reference_av_duration_total_max;
  }
  validateLimits(profile.limits);
  return profile;
}
