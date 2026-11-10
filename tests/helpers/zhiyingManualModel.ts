import { saveZhiyingModelConfiguration } from '../../server/services/zhiyingModelConfigurationService.js';
import { zhiyingCatalogProfile } from '../../server/services/zhiyingCatalogProfile.js';

export const manualId = 'Lx-Seedance2.5-3';
export const manualUpstream = 'sd-2.5-fullblood-line3';
export const manualCatalogRow = {
  id: manualUpstream, media_type: 'video', status: 'available', create_endpoint: '/v1/generations',
  default_duration: 5, default_resolution: '720p', prompt_max: 20000,
  resolutions: { '720p': { durations: Array.from({ length: 30 }, (_, i) => i + 1) } },
  aspect_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  reference_limits: { images: 30, videos: 30, audios: 30, total: 30 },
  reference_modes: ['multi_reference'], reference_image_processing: ['direct'],
  reference_file_max_bytes: 33554432, reference_av_duration_total_max: 30,
};
export const manualDraft = () => ({ modelId: manualId, upstreamModel: manualUpstream,
  limits: zhiyingCatalogProfile(manualCatalogRow).limits, enabled: true, routeEnabled: true });
export const installManualZhiying = (channelId: number) => saveZhiyingModelConfiguration(channelId, manualDraft(), null);
