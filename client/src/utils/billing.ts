export type BillingType = 'per_call' | 'per_second' | 'per_token' | 'per_character' | null | undefined;

export function getBillingUnit(billingType: BillingType, kind?: 'video' | 'image'): string {
  if (billingType === 'per_call') return kind === 'video' ? '/条' : kind === 'image' ? '/张' : '/次';
  if (billingType === 'per_second') return '/秒';
  if (billingType === 'per_character') return '/字';
  if (billingType === 'per_token') return '/百万 Token';
  return '';
}
