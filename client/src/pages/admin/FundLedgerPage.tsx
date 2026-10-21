import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { FUND_ACCOUNTS, FUND_KINDS, type FundEntry, type FundLedgerResult, type FundTask } from '../../../../shared/fundLedger';
import { formatBeijingTime } from '../../../../shared/time';

const initial = { scope: 'wallet', accountType: '', accountId: '', userId: '', contentId: '', kind: '', search: '', from: '', to: '' };
const views = [
  { id: 'wallet', label: '钱包收支', description: '只看实际个人 / 组织余额变化。同一笔消费的 Token 用量不会再混进来。' },
  { id: 'usage', label: 'Token 用量', description: '这是累计消费计数，不是第二次扣钱。扣费记为用量增加，退款记为用量减少。' },
  { id: 'quota', label: 'Token 剩余额度', description: '单独核对有限 Token 的剩余额度；无限 Token 的消费请看“Token 用量”。' },
];
const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const inputClass = 'block border rounded-lg p-2 mt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
const operationLabels: Record<string, string> = {
  api_call: 'API 消费', token_charge: 'Token 消费登记', token_refund: 'Token 退款登记',
  generate_video_prededuct: '视频生成预扣', generate_video_refund: '视频失败退款',
  generate_video_actual_refund: '实际费用退差额', generate_video_actual_supplement: '实际费用补扣',
  generate_video_supplement: '实际费用补扣', generate_video_recovery: '恢复任务扣款',
  video_batch_prededuct: '批量任务预扣', video_batch_refund: '批量任务退款',
  specification_generate_prededuct: '销售规格预扣', specification_generate_refund: '销售规格退款',
  specification_refund: '销售规格退款', reconciliation_refund: '人工核实退款',
  generate_image_prededuct: '图片生成预扣', generate_image_refund: '图片生成退款',
  generate_tts_prededuct: '语音合成预扣', generate_tts_refund: '语音合成退款',
  admin_user_balance: '管理员调整余额', recharge: '充值', refund: '退款',
};
function kindLabel(item: FundEntry) {
  if (item.account_type === 'token_usage') {
    if (item.kind === 'charge') return '用量增加（扣费 / 预扣）';
    if (item.kind === 'refund') return '用量减少（退款）';
  }
  return FUND_KINDS[item.kind] || item.kind;
}
function counter(item: FundEntry, value: number) {
  return item.account_type === 'token' && value === -1 ? '不限额' : money(value);
}
const inView = (item: FundEntry, scope: string) => scope === 'wallet'
  ? ['user', 'org'].includes(item.account_type) : item.account_type === (scope === 'usage' ? 'token_usage' : 'token');

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
  const switchView = (scope: string) => {
    const next = { ...filters, scope, accountType: '', accountId: '', search: '', kind: '' };
    setPage(1); setDraft(next); setFilters(next);
  };
  const selectTask = (id: number) => {
    const next = { ...filters, contentId: String(id) };
    setPage(1); setDraft(next); setFilters(next);
  };
  const renderTask = (task: FundTask) => <div key={task.id} className="space-y-1 py-1">
    <button type="button" className="font-semibold text-[#53684c] underline underline-offset-2 focus-visible:outline focus-visible:outline-2"
      aria-label={'筛选任务 ' + task.id} onClick={() => selectTask(task.id)}>任务 #{task.id}</button>
    {task.model && <div className="text-xs break-all">{task.model}</div>}
    {task.upstreamIds.map(id => <div key={id} className="text-xs break-all select-all text-gray-600">上游：{id}</div>)}
    {!task.upstreamIds.length && <div className="text-xs text-gray-600">上游 ID 尚未记录</div>}
  </div>;
  const taskCell = (item: FundEntry) => {
    const tasks = item.tasks || (item.content_id ? [{ id: item.content_id, model: null, status: null, userId: item.user_id, upstreamIds: [] }] : []);
    if (tasks.length === 1) return renderTask(tasks[0]);
    if (tasks.length > 1) return <details><summary className="cursor-pointer font-medium">{tasks.length} 个任务（批次汇总）</summary>
      <p className="text-xs text-gray-600 my-1">这是一笔批次款，不能按任务数重复计算。</p>{tasks.map(renderTask)}</details>;
    return <span className="text-xs text-gray-600">{item.operation?.startsWith('video_batch') ? '批次变动，尚无已关联任务'
      : ['charge', 'refund'].includes(item.kind) ? '未关联任务（不按时间猜配）' : '非任务变动'}</span>;
  };
  const visible = (data?.items || []).filter(item => inView(item, filters.scope));
  const accountOptions = Object.entries(FUND_ACCOUNTS).filter(([key]) => inView({ account_type: key } as FundEntry, filters.scope));
  const view = views.find(v => v.id === filters.scope)!;

  return <div className="space-y-5">
    <div className="flex flex-wrap gap-3 items-center justify-between">
      <div><h1 className="text-2xl font-bold">资金流水</h1>
        <p className="text-sm text-gray-600 mt-2">按用户和任务核对扣款、退款；钱包与 Token 计数分开查看。</p></div>
      <button className="border rounded-xl px-4 py-2" disabled={busy} onClick={() => setRefresh(v => v + 1)}>刷新</button>
    </div>
    <div role="tablist" aria-label="流水口径" className="flex flex-wrap gap-2">
      {views.map(v => <button key={v.id} type="button" role="tab" id={'ledger-tab-' + v.id} aria-controls="ledger-panel"
        tabIndex={filters.scope === v.id ? 0 : -1}
        onKeyDown={event => {
          const index = views.findIndex(item => item.id === v.id);
          const next = event.key === 'ArrowRight' ? (index + 1) % views.length
            : event.key === 'ArrowLeft' ? (index + views.length - 1) % views.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault(); switchView(views[next].id);
          document.getElementById('ledger-tab-' + views[next].id)?.focus();
        }}
        aria-selected={filters.scope === v.id} onClick={() => switchView(v.id)}
        className={'rounded-xl border px-4 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 '
          + (filters.scope === v.id ? 'bg-[#53684c] text-white' : 'bg-white text-gray-800')}>{v.label}</button>)}
    </div>
    <div id="ledger-help" className="rounded-xl border p-4 text-sm leading-6 bg-black/[0.02]">
      <p className="font-medium">{view.description}</p>
      <p className="text-gray-600 mt-1">点击任务编号可筛选该任务的所有相关流水。多笔扣款保留原样，不会为了合并显示而隐藏；补扣、恢复扣款也须分别核对。</p>
      <details className="mt-2 text-gray-600"><summary className="cursor-pointer">记录起点与历史缺失说明</summary>
        <p>{data?.startedAt ? '余额流水自 ' + formatBeijingTime(data.startedAt) + '（北京时间）启用。' : '余额从流水功能启用后开始记录。'}
          {data?.usageStartedAt ? 'Token 用量流水自 ' + formatBeijingTime(data.usageStartedAt) + '（北京时间）启用。' : ''}</p>
        <p>启用时数值只是核对起点，历史未记录的扣费和任务关联不猜配。价格、历史余额、累计用量不重置；不同口径不能相加。共享组织未关联任务的流水不自动归属个人。</p>
      </details>
    </div>
    <form className="flex flex-wrap gap-3 rounded-xl border p-4 items-end" aria-describedby="ledger-help"
      onSubmit={e => { e.preventDefault(); setPage(1); setFilters({ ...draft }); }}>
      <label className="text-sm">用户 ID<input aria-label="用户 ID" type="number" min="1" step="1" className={inputClass + ' w-28'} value={draft.userId} onChange={e => field('userId', e.target.value)} /></label>
      <label className="text-sm">本地任务 ID<input aria-label="本地任务 ID" type="number" min="1" step="1" className={inputClass + ' w-32'} value={draft.contentId} onChange={e => field('contentId', e.target.value)} /></label>
      <label className="text-sm">变动类型<select aria-label="变动类型" className={inputClass} value={draft.kind} onChange={e => field('kind', e.target.value)}>
        <option value="">全部类型</option>{Object.entries(FUND_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select></label>
      <label className="text-sm">开始日期<input aria-label="开始日期" type="date" className={inputClass} value={draft.from} onChange={e => field('from', e.target.value)} /></label>
      <label className="text-sm">结束日期<input aria-label="结束日期" type="date" className={inputClass} value={draft.to} onChange={e => field('to', e.target.value)} /></label>
      <label className="text-sm">账户类型<select aria-label="账户类型" className={inputClass} value={draft.accountType} onChange={e => field('accountType', e.target.value)}>
        <option value="">当前口径全部账户</option>{accountOptions.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select></label>
      <label className="text-sm">账户 ID<input aria-label="账户 ID" type="number" min="1" step="1" className={inputClass + ' w-28'} value={draft.accountId} onChange={e => field('accountId', e.target.value)} /></label>
      <label className="text-sm">账户名称<input aria-label="账户名称" className={inputClass + ' w-36'} value={draft.search} onChange={e => field('search', e.target.value)} maxLength={100} /></label>
      <button className="rounded-lg px-4 py-2 bg-[#53684c] text-white" style={{ color: '#fff' }} type="submit">查询</button>
      <button className="border rounded-lg px-4 py-2" type="button" onClick={() => { const next = { ...initial, scope: filters.scope }; setDraft(next); setFilters(next); setPage(1); }}>清空</button>
    </form>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <div id="ledger-panel" role="tabpanel" aria-labelledby={'ledger-tab-' + filters.scope} className="overflow-x-auto rounded-xl border" aria-busy={busy}>
      <table className="w-full text-sm text-left min-w-[850px]">
        <thead className="bg-black/5"><tr>{['时间（北京） / 流水号', '关联任务（点击筛选）', '用户 / 账户', '类型 / 操作来源', filters.scope === 'usage' ? '已用额度变动' : '收支 / 额度变动', filters.scope === 'usage' ? '已用额度：变动前 → 后' : '余额：变动前 → 后'].map(h => <th scope="col" key={h} className="p-3">{h}</th>)}</tr></thead>
        <tbody>{!busy && !error && visible.map(item => <tr key={item.id} className="border-t align-top">
          <td className="p-3 whitespace-nowrap">{formatBeijingTime(item.created_at)}<div className="text-xs text-gray-600">流水 #{item.id}</div></td>
          <td className="p-3 min-w-[200px] max-w-[280px]">{taskCell(item)}</td>
          <td className="p-3">{item.user_id != null ? (item.user_name || '用户') + ' #' + item.user_id : '共享组织 / 未记录用户'}
            <div className="text-xs text-gray-600 mt-1">{FUND_ACCOUNTS[item.account_type]} #{item.account_id}</div>
            {item.account_type !== 'user' && <div className="text-xs text-gray-600">{item.account_name || '未命名'}</div>}</td>
          <td className="p-3">{kindLabel(item)}
            <div className="text-xs text-gray-600 mt-1 break-all" title={item.operation || ''}>{item.operation ? operationLabels[item.operation] || '其他操作（悬停查看来源）' : '操作来源未记录'}</div>
            {item.actor_id && <div className="text-xs text-gray-600">{item.actor_name || '管理员'} #{item.actor_id}</div>}</td>
          <td className="p-3 font-semibold whitespace-nowrap">{item.delta === null ? '额度模式变更' : (item.delta > 0 ? '+' : '') + money(item.delta)}</td>
          <td className="p-3 whitespace-nowrap">{counter(item, item.balance_before)} → {counter(item, item.balance_after)}</td>
        </tr>)}</tbody>
      </table>
      {busy ? <p role="status" className="p-8 text-center">正在读取流水…</p> : !error && !visible.length ? <p className="p-8 text-center">暂无符合条件的流水</p> : null}
    </div>
    <div className="flex flex-wrap gap-4 items-center justify-end text-sm">
      <span>共 {data?.total ?? 0} 条 · 第 {page} 页</span>
      <button className="border rounded-lg px-3 py-2" disabled={busy || page === 1} onClick={() => setPage(p => p - 1)}>上一页</button>
      <button className="border rounded-lg px-3 py-2" disabled={busy || page * 30 >= (data?.total ?? 0)} onClick={() => setPage(p => p + 1)}>下一页</button>
    </div>
  </div>;
}
