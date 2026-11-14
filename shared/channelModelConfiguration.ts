import type { MediaKind, ModelInputLimits } from './modelRouting.js';

export const CHANNEL_MODEL_ROUTE_PREFIX = 'admin-channel-model-';
export const STANDARD_CHANNEL_IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const;
export const STANDARD_CHANNEL_VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;

export type ChannelModelDraft = {
  modelId: string;
  displayName: string;
  upstreamModel: string;
  kind: MediaKind;
  limits: ModelInputLimits;
};

export type ChannelModelConfiguration = {
  modelId: string;
  displayName: string;
  upstreamModel: string;
  capabilities: string[];
  limits: ModelInputLimits | null;
  enabled: boolean;
  editable: boolean;
};

export type ChannelModelConfigurations = {
  models: ChannelModelConfiguration[];
  canAdd: boolean;
  canSync: boolean;
  addUnavailableReason?: string;
  version: string;
};
