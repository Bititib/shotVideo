/** Fixed public status fields; never expose provider responses or route identifiers. */
export type ModelAvailability = { available: boolean; unavailableReason?: 'credits' | 'credentials' | 'cooldown' | 'configuration'; retryAt?: number };
export function isUpstreamCreditFailure(text: string): boolean {
  if (/\b401\b|\binvalid[\s_-]+(?:api[\s_-]*)?key\b|\bkey[\s_-]+(?:is[\s_-]+)?(?:expired|revoked)\b|unauthori[sz]ed|permission.denied|密钥.*(?:无效|失效)|权限不足/i.test(text)) return false;
  return /\binsufficient[\s_-]+(?:credits?|balance|funds)\b|\bnot[\s_-]+enough[\s_-]+credits?\b|\bcredits?(?:[\s_-]+balance)?\s*(?::|is)?\s*(?:insufficient|exhausted|depleted)\b|积分(?:余额)?不足|余额不足|额度不足/i.test(text);
}
export function modelAvailabilityMessage(model?: Partial<ModelAvailability>, now = Date.now()): string {
  if (!model || model.available !== false) return '';
  const retry = model.retryAt ? model.retryAt > now
    ? '预计 ' + new Date(model.retryAt).toLocaleTimeString('zh-CN', { hour12: false }) + ' 可再次尝试。'
    : '正在刷新可用状态。' : '';
  if (model.unavailableReason === 'credits') return '上游积分不足，已暂停生成；补充额度后重试。' + retry;
  if (model.unavailableReason === 'credentials') return '生成服务的密钥或权限异常，请联系管理员修复后恢复。';
  if (model.unavailableReason === 'cooldown') return '生成服务暂时繁忙，正在等待恢复。' + retry;
  return '该模型暂不可用，请选择其他模型或联系管理员。';
}
