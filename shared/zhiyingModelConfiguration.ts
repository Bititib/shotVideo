import type { ModelInputLimits } from './modelRouting.js';

/** Snapshot of the provider's documented /v1/generations video contract. */
export type ZhiyingModelProfile = {
  limits: ModelInputLimits;
  promptMax: number;
  videoDurationTotal: boolean;
  fileMaxBytes: { image: number; video: number; audio: number };
  avDurationMax?: number;
  referenceMode: boolean;
  directProcessing: boolean;
};
export type ZhiyingModelDraft = {
  modelId: string;
  upstreamModel: string;
  limits: ModelInputLimits;
  enabled: boolean;
  routeEnabled: boolean;
};
export type ZhiyingModelConfiguration = ZhiyingModelDraft & {
  version: string; editable: boolean; reason?: string;
};
export type ZhiyingCatalogOption = {
  id: string; profile?: ZhiyingModelProfile; reason?: string;
};
