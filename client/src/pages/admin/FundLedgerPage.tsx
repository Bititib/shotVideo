import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { FUND_ACCOUNTS, FUND_KINDS, type FundEntry, type FundLedgerResult } from '../../../../shared/fundLedger';
import { formatBeijingTime } from '../../../../shared/time';

const initial = { accountType: '', accountId: '', userId: '', kind: '', search: '', from: '', to: '' };
const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const inputClass = 'block border rounded-lg p-2 mt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
function kindLabel(item: FundEntry) {
  const label = FUND_KINDS[item.kind] || item.kind;
  if (item.account_type !== 'token_usage') return label;
  return label + (item.kind === 'charge' ? '（已用增加）' : item.kind === 'refund' ? '（已用减少）' : '');
}
function counter(item: FundEntry, value: number) {
  return item.account_type === 'token' && value === -1 ? '不限额' : money(value);
}

export default function FundLedgerPage() {
  const [draft, setDraft] = useState(initial), [filters, setFilters] = useState(initial);
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<FundLedgerResult | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    const params = new URLSearchParams({ ...filters, page: String(page), pageSize: '30' });
    api.get<FundLedgerResult>('/admin/fund-ledger?' + params, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [filters, page, refresh]);
  const field = (key: keyof typeof initial, value: string) => setDraft({ ...draft, [key]: value });

  return <div className="space-y-5">
    <div className="flex flex-wrap gap-3 items-center justify-between">
      <div><h1 className="text-2xl font-bold">资金流水</h1>
        <p className="text-sm opacity-70 mt-2">仅管理员可见 · 个人、组织余额及 Token 剩余 / 已用额度变动</p></div>
      <button className="border rounded-xl px-4 py-2" disabled={busy} onClick={() => setRefresh(v => v + 1)}>刷新</button>
    </div>
    <div id="ledger-help" className="rounded-xl border p-4 text-sm leading-6">
      <p>{data?.startedAt ? '余额记录启用时间：' + formatBeijingTime(data.startedAt) + '（北京时间）。' : '余额从流水功能启用后开始记录。'}启用时数值是核对起点，不代表历史充值或扣费。</p>
      <p>{data?.usageStartedAt ? 'Token 已用额度记录启用时间：' + formatBeijingTime(data.usageStartedAt) + '（北京时间）。' : 'Token 已用额度从新版记录启用后开始记录。'}此前变动不补造，当前累计已用额度不重置。</p>
      <p>选择“Token 已用额度”，填写“用户 ID”，可查看该用户各 Token（含无限额度）的扣费与退款。扣费使已用额度增加，退款使已用额度减少。余额、剩余额度、已用额度属于不同口径，不能相加；共享组织流水不自动归属某个用户。</p>
    </div>
    <form className="flex flex-wrap gap-3 rounded-xl border p-4 items-end" aria-describedby="ledger-help"
      onSubmit={e => { e.preventDefault(); setPage(1); setFilters({ ...draft }); }}>
      <label className="text-sm">账户类型<select aria-label="账户类型" className={inputClass} value={draft.accountType} onChange={e => field('accountType', e.target.value)}>
        <option value="">全部账户</option>{Object.entries(FUND_ACCOUNTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select></label>
      <label className="text-sm">用户 ID<input aria-label="用户 ID" type="number" min="1" step="1" className={inputClass + ' w-28'} value={draft.userId} onChange={e => field('userId', e.target.value)} /></label>
      <label className="text-sm">账户 ID<input aria-label="账户 ID" type="number" min="1" step="1" className={inputClass + ' w-28'} value={draft.accountId} onChange={e => field('accountId', e.target.value)} /></label>
      <label className="text-sm">账户名称<input aria-label="账户名称" className={inputClass + ' w-40'} value={draft.search} onChange={e => field('search', e.target.value)} maxLength={100} /></label>
      <label className="text-sm">变动类型<select aria-label="变动类型" className={inputClass} value={draft.kind} onChange={e => field('kind', e.target.value)}>
        <option value="">全部类型</option>{Object.entries(FUND_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select></label>
      <label className="text-sm">开始日期<input aria-label="开始日期" type="date" className={inputClass} value={draft.from} onChange={e => field('from', e.target.value)} /></label>
      <label className="text-sm">结束日期<input aria-label="结束日期" type="date" className={inputClass} value={draft.to} onChange={e => field('to', e.target.value)} /></label>
      <button className="rounded-lg px-4 py-2 bg-[#53684c] text-white" style={{ color: '#fff' }} type="submit">查询</button>
      <button className="border rounded-lg px-4 py-2" type="button" onClick={() => { setDraft(initial); setFilters(initial); setPage(1); }}>清空</button>
    </form>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <div className="overflow-x-auto rounded-xl border" aria-busy={busy}>
      <table className="w-full text-sm text-left whitespace-nowrap">
        <thead className="bg-black/5"><tr>{['时间（北京） / 流水号', '所属用户', '账户 / 记录口径', '类型', '变动金额 / 额度', '变动前 → 变动后', '操作人', '关联任务'].map(h => <th scope="col" key={h} className="p-3">{h}</th>)}</tr></thead>
        <tbody>{!busy && !error && data?.items.map(item => <tr key={item.id} className="border-t">
          <td className="p-3">{formatBeijingTime(item.created_at)}<div className="text-xs opacity-60">#{item.id}</div></td>
          <td className="p-3">{item.user_id != null ? (item.user_name || '用户') + ' #' + item.user_id : '组织 / 未记录'}</td>
          <td className="p-3">{item.account_name || '未命名'}<div className="text-xs opacity-60">{FUND_ACCOUNTS[item.account_type]} #{item.account_id}</div></td>
          <td className="p-3">{kindLabel(item)}</td>
          <td className="p-3 font-medium">{item.delta === null ? '额度模式变更' : (item.delta > 0 ? '+' : '') + money(item.delta)}</td>
          <td className="p-3">{counter(item, item.balance_before)} → {counter(item, item.balance_after)}</td>
          <td className="p-3">{item.actor_id ? (item.actor_name || '管理员') + ' #' + item.actor_id : '系统 / 未记录'}</td>
          <td className="p-3">{item.content_id ? '#' + item.content_id : '—'}</td>
        </tr>)}</tbody>
      </table>
      {busy ? <p role="status" className="p-8 text-center">正在读取流水…</p> : !error && !data?.items.length ? <p className="p-8 text-center">暂无符合条件的流水</p> : null}
    </div>
    <div className="flex flex-wrap gap-4 items-center justify-end text-sm">
      <span>共 {data?.total ?? 0} 条 · 第 {page} 页</span>
      <button className="border rounded-lg px-3 py-2" disabled={busy || page === 1} onClick={() => setPage(p => p - 1)}>上一页</button>
      <button className="border rounded-lg px-3 py-2" disabled={busy || page * 30 >= (data?.total ?? 0)} onClick={() => setPage(p => p + 1)}>下一页</button>
    </div>
  </div>;
}
