import type { MediaKind, ModelInputLimits } from './modelRouting.js';

export const CHANNEL_MODEL_ROUTE_PREFIX = 'admin-channel-model-';
export const ASYNC_VIDEO_MODEL_ROUTE_PREFIX = CHANNEL_MODEL_ROUTE_PREFIX + 'async-video-';
export const MJ_NEW_API_MODEL_ROUTE_PREFIX = CHANNEL_MODEL_ROUTE_PREFIX + 'mjnewapi-';
export const NEW_TOKEN_MODEL_ROUTE_PREFIX = CHANNEL_MODEL_ROUTE_PREFIX + 'newtoken-';
export const MEGABY_MODEL_ROUTE_PREFIX = CHANNEL_MODEL_ROUTE_PREFIX + 'megaby-';
export const WANFENG_MODEL_ROUTE_PREFIX = CHANNEL_MODEL_ROUTE_PREFIX + 'wanfeng-';
export const channelVideoProtocols = {
  wanfeng: { prefix: WANFENG_MODEL_ROUTE_PREFIX, label: '晚风统一视频', multimedia: true },
  'async-video': { prefix: ASYNC_VIDEO_MODEL_ROUTE_PREFIX, label: 'Vx-乐异步视频', multimedia: false },
  mjnewapi: { prefix: MJ_NEW_API_MODEL_ROUTE_PREFIX, label: 'MJNewAPI 视频 JSON', multimedia: true },
  newtoken: { prefix: NEW_TOKEN_MODEL_ROUTE_PREFIX, label: 'NewToken Seedance 视频', multimedia: true },
  megaby: { prefix: MEGABY_MODEL_ROUTE_PREFIX, label: 'Megaby 视频', multimedia: true },
} as const;
export type ChannelVideoProtocol = keyof typeof channelVideoProtocols;
export const STANDARD_CHANNEL_IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const;
export const STANDARD_CHANNEL_VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;

export type ChannelModelDraft = {
  modelId: string;
  displayName: string;
  upstreamModel: string;
  kind: MediaKind | 'text';
  limits: ModelInputLimits;
  specificationEnabled?: boolean;
  routeEnabled?: boolean;
};

export type ChannelModelConfiguration = {
  modelId: string;
  displayName: string;
  upstreamModel: string;
  capabilities: string[];
  limits: ModelInputLimits | null;
  enabled: boolean;
  editable: boolean;
  specificationEnabled?: boolean;
  routeEnabled?: boolean;
};

export type ChannelModelConfigurations = {
  models: ChannelModelConfiguration[];
  canAdd: boolean;
  image2pro?: boolean;
  canSync: boolean;
  protocol?: ChannelVideoProtocol;
  addUnavailableReason?: string;
  version: string;
};

export type Image2proImageOptions = { referenceLimitPublished?: boolean; customRatios: boolean; customResolutions: boolean; maxImages: number };
export type Image2proUpstreamPricing = {
  video?: number | null;
  textPerRequest?: number | null;
  note?: string;
  textToImage: number | null;
  imageToImage: number | null;
  unit: string;
  checkedAt: string;
  source: string;
};
export type ChannelModelCatalogEntry = { id: string; kind?: MediaKind | 'text'; imageOptions?: Image2proImageOptions; upstreamPricing?: Image2proUpstreamPricing; imageEvidence?: { checkedAt: string; notes: string[] }; limits?: ModelInputLimits };
export type ChannelModelRequestPreview = { method: string; path: string; headers?: Record<string,string>; body: Record<string, unknown> };
