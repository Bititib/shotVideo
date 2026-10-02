/** Display precision only; never round the stored balance when editing other fields. */
export function balanceInput(value: number | string | null | undefined): string {
  if (typeof value === 'string') return value;
  return Number.isFinite(value) ? Number(value).toFixed(2) : '0.00';
}

export function balanceUpdate(draft: { balance: unknown; balanceChanged?: boolean; isNew?: boolean }, allowUnlimited = false): { balance?: number } {
  if (!draft.balanceChanged && !draft.isNew) return {};
  const value = String(draft.balance ?? '').trim();
  const balance = Number(value);
  if (!value || !Number.isFinite(balance) || (balance < 0 && !(allowUnlimited && balance === -1))) {
    throw new Error(allowUnlimited ? '余额需为非负金额，或填写 -1 表示无限额度' : '请输入有效的非负余额');
  }
  return { balance };
}
