import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';

export type MinikeyModelDraft = {
  modelId: string; upstreamModel: string; kind: 'video' | 'image' | 'music';
  upstreamChannel: number | null; imageProtocol: 'banana' | 'size';
  limits: ModelInputLimits; enabled: boolean; routeEnabled: boolean;
};
export const minikeyImageSize = (ratio: string) => ({'1:1':'1024x1024','16:9':'1024x576','9:16':'576x1024','4:3':'1024x768','3:4':'768x1024','3:2':'1200x800','2:3':'800x1200'} as Record<string,string>)[ratio];
export type MinikeyModelConfiguration = MinikeyModelDraft & { version: string; editable: boolean; reason?: string };
export type MinikeyCatalogOption = {
  model: string; name: string; kind: MinikeyModelDraft['kind']; maxImages: number;
  durations: number[]; resolutions: string[];
  channels: { id: number; name: string; prices: Record<string, number> }[];
};
export const blankMinikeyModel = (): MinikeyModelDraft => ({ modelId: '', upstreamModel: '', kind: 'video',
  upstreamChannel: null, imageProtocol: 'banana', enabled: true, routeEnabled: true,
  limits: { ...defaultRoutingLimits(), minImages: 1, defaultSeconds: 5, duration: { mode: 'options', min: 5, max: 5, step: 1, values: [5] } } });
