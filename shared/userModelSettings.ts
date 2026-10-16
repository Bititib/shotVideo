export type UserModelAccessMode = 'inherit' | 'allow' | 'deny';
export interface UserModelPrice {
  billingType: string;
  inputPrice: number;
  outputPrice: number;
  extraParams: Record<string, number>;
  revision?: number;
}
export interface UserModelSetting {
  id: number;
  modelId: string;
  displayName: string;
  active: boolean;
  kind?: 'text' | 'image' | 'video' | 'tts' | 'other';
  accessMode: UserModelAccessMode;
  pricingMode: 'inherit' | 'custom';
  defaultPrice: UserModelPrice | null;
  customPrice: UserModelPrice | null;
  effectivePrice: UserModelPrice | null;
  resolutions: string[];
}
