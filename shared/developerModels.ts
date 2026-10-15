import type { ModelInputLimits } from './modelRouting.js';
import type { VideoModelStatus } from './videoModelStatus.js';

export type DeveloperModelKind = 'text' | 'image' | 'video' | 'tts' | 'other';
export type DeveloperEndpoint = '/v1/chat/completions' | '/v1/images/generations' | '/v1/images/edits' | '/v1/videos';
export interface DeveloperModelPricing {
  currency: 'CNY';
  billing_type: 'per_call' | 'per_token' | 'per_second' | 'per_character';
  unit: 'request' | 'second' | 'million_tokens' | 'character';
  unit_price: number;
  output_unit_price: number;
  resolution_prices: Record<string, number>;
}
export interface DeveloperModel {
  id: string;
  canonicalId: string;
  name: string;
  description: string;
  kinds: DeveloperModelKind[];
  endpoints: DeveloperEndpoint[];
  limits: ModelInputLimits | null;
  pricing: DeveloperModelPricing | null;
  available: boolean;
  health: VideoModelStatus | null;
}
export interface DeveloperModelCatalog {
  token: { id: number; name: string; maskedKey: string };
  checkedAt: string;
  items: DeveloperModel[];
}
