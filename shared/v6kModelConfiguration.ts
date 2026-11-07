import type { ModelInputLimits } from './modelRouting.js';

export type V6kModelDraft = {
  modelId: string;
  displayName: string;
  upstreamModel: string;
  enabled: boolean;
  routeEnabled: boolean;
  limits: ModelInputLimits;
};

export type V6kModelConfiguration = V6kModelDraft & {
  version: string;
  editable: boolean;
  reason?: string;
};

export type V6kRequestSample = {
  seconds?: number;
  resolution?: string;
  ratio?: string;
  images?: number;
  videos?: number;
  audios?: number;
};
