import { useState } from 'react';
import { adminApi } from '../api/admin';
import { priceSummary, scalePricing } from '../utils/adminPricing';

export default function AdminBatch({ items, kind, onDone, onBusy }: { items: any[]; kind: 'models' | 'pricing'; onDone: () => void | Promise<void>; onBusy?: (busy: boolean) => void }) {
  const [plan, setPlan] = useState<any[] | null>(null);
  const [percent, setPercent] = useState('10');
  const [mode, setMode] = useState('scale');
  const [amount, setAmount] = useState('');
  const [output, setOutput] = useState('');
  const [billingType, setBillingType] = useState('per_call');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ name: string; error?: string }>>([]);
  const [error, setError] = useState('');
  const preview = (active?: number) => {
    setError(''); setResults([]);
    try {
      if (kind === 'pricing' && mode === 'fixed' && (!amount.trim() || !Number.isFinite(Number(amount)) || Number(amount) < 0 || (billingType === 'per_token' && (!output.trim() || !Number.isFinite(Number(output)) || Number(output) < 0)))) throw Error('请填写非负的有效单价；Token 计费需同时填写输出价格');
      if (kind === 'pricing' && mode === 'scale' && items.some(item => !item.configured && !item.inherited)) throw Error('未配置价格的模型请使用“设置统一价格”');
      setPlan(items.map(item => ({ id: item.id, model: item.modelPattern, name: item.displayName || item.modelId, before: kind === 'models' ? (item.isActive ? '启用' : '停用') : priceSummary(item), payload: kind === 'models' ? { isActive: active } : mode === 'scale' ? scalePricing(item, percent.trim() ? Number(percent) : NaN) : { modelPattern: item.modelPattern, billingType, inputPrice: Number(amount), outputPrice: billingType === 'per_token' ? Number(output) : 0, extraParams: { category: item.category } } })));
    }
    catch (e: any) { setError(e.message); }
  };
  const execute = async () => {
    if (!plan || busy) return;
    setBusy(true); onBusy?.(true); setResults([]);
    const outcomes: Array<{ name: string; error?: string }> = [];
    try {
      for (const row of plan) {
        try { if (kind === 'models') await adminApi.updateModel(row.id, row.payload); else if (row.id === null) await adminApi.createPricing(row.payload); else await adminApi.updatePricing(row.id, row.payload); outcomes.push({ name: row.name }); }
        catch (e: any) { outcomes.push({ name: row.name, error: e.message || '请求失败，请检查实际状态后重试' }); }
        setResults([...outcomes]);
      }
      setPlan(null); await onDone();
    } finally { setBusy(false); onBusy?.(false); }
  };
  return <section className="rounded-xl border p-3 mb-4 text-sm" aria-label="批量操作">
    <div className="flex flex-wrap items-center gap-3"><span>已选 {items.length} 条</span>
      {kind === 'models' ? <><button disabled={!items.length || busy} onClick={() => preview(1)}>批量启用</button><button disabled={!items.length || busy} onClick={() => preview(0)}>批量停用</button></> : <>
        <select aria-label="批量价格操作" disabled={busy} value={mode} onChange={e => { setMode(e.target.value); setPlan(null); }}><option value="scale">按比例调整</option><option value="fixed">设置统一价格</option></select>
        {mode === 'scale' ? <label>价格调整 % <input aria-label="价格调整百分比" className="w-24 rounded border p-1" type="number" value={percent} disabled={busy} onChange={e => { setPercent(e.target.value); setPlan(null); }} /></label> : <><select aria-label="批量计费方式" value={billingType} disabled={busy} onChange={e => { setBillingType(e.target.value); setPlan(null); }}><option value="per_call">元/次</option><option value="per_second">元/秒</option><option value="per_token">元/百万 Token</option><option value="per_character">元/字</option></select><input aria-label="批量单价" placeholder="单价" type="number" min="0" value={amount} disabled={busy} onChange={e => { setAmount(e.target.value); setPlan(null); }} className="w-24 border p-1" />{billingType === 'per_token' && <input aria-label="批量输出价格" placeholder="输出单价" type="number" min="0" value={output} disabled={busy} onChange={e => { setOutput(e.target.value); setPlan(null); }} className="w-24 border p-1" />}</>}
        <button disabled={!items.length || busy} onClick={() => preview()}>预览批量调价</button><span className="text-xs">{mode === 'scale' ? '输入、输出及规格价格同比调整；继承规则将创建独立价格' : '替换计费方式、单价并清空规格价；未配置模型将创建独立价格'}</span>
      </>}
    </div>
    {error && <p role="alert">{error}</p>}
    {plan && <div className="mt-3 rounded border p-3"><p>即将修改以下 {plan.length} 条，确认后立即生效：</p>{plan.some(row => row.model === '*') && <p className="text-amber-700">包含全局默认规则，将影响继承该规则的模型。</p>}<ul className="max-h-60 overflow-auto my-3">{plan.map(row => <li key={row.model || row.id}>{row.name}：{row.before} → {kind === 'models' ? (row.payload.isActive ? '启用' : '停用') : priceSummary({ ...row.payload, configured: true })}</li>)}</ul><button disabled={busy} onClick={() => void execute()}>{busy ? `执行中 ${results.length}/${plan.length}` : '确认执行'}</button><button className="ml-4" disabled={busy} onClick={() => setPlan(null)}>取消</button></div>}
    {results.length > 0 && <div role="status" className="mt-3"><p>成功 {results.filter(row => !row.error).length} 条，失败 {results.filter(row => row.error).length} 条</p><ul>{results.filter(row => row.error).map((row, index) => <li key={index}>{row.name}：{row.error}</li>)}</ul></div>}
  </section>;
}
