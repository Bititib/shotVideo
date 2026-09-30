export const priceUnits: Record<string, string> = { per_call: '/次', per_token: '/百万 Token', per_second: '/秒', per_character: '/字' };
export function priceSource(rule: any) {
  if (!rule) return '加载中';
  return rule.modelPattern === '*' ? '默认规则' : rule.inherited ? '继承默认' : rule.configured ? '独立价格' : '未配置';
}
export function priceSummary(rule: any) {
  if (!rule || (!rule.configured && !rule.inherited)) return '—';
  const input = Number(rule.inputPrice).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
  const extra = Object.keys(rule.extraParams || {}).some(key => key !== 'category');
  return `¥${input}${priceUnits[rule.billingType] || ''}${rule.billingType === 'per_token' ? ` · 输出 ¥${rule.outputPrice}` : ''}${extra ? ' · 含规格价' : ''}`;
}
export function scalePricing(rule: any, percent: number) {
  if (!Number.isFinite(percent) || percent < -100 || percent > 10000) throw Error('调整幅度必须在 -100% 至 10000% 之间');
  const scale = (value: number) => Number((Number(value) * (1 + percent / 100)).toFixed(6));
  return { modelPattern: rule.modelPattern, billingType: rule.billingType, inputPrice: scale(rule.inputPrice), outputPrice: scale(rule.outputPrice),
    extraParams: Object.fromEntries(Object.entries(rule.extraParams || {}).map(([key, value]) => [key, key !== 'category' && typeof value === 'number' ? scale(value) : value])) };
}
