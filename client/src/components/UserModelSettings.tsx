import { Fragment, useEffect, useRef, useState } from 'react';
import { adminApi } from '../api/admin';
import AdminDrawer from './AdminDrawer';
import type { UserModelSetting, UserModelPrice } from '../../../shared/userModelSettings';
import './UserModelSettings.css';

type Draft = { accessMode: UserModelSetting['accessMode']; input: string; output: string; resolutions: Record<string, string> };
type Kind = NonNullable<UserModelSetting['kind']>;
const kindLabels: Record<Kind, string> = { text: '文本', image: '图片', video: '视频', tts: '语音', other: '其他' };
const PAGE_SIZE = 10;
const number = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
function kindOf(item: UserModelSetting): Kind {
  return item.kind || (item.defaultPrice?.billingType === 'per_second' ? 'video' : item.defaultPrice?.billingType === 'per_character' ? 'tts' : item.defaultPrice?.billingType === 'per_token' ? 'text' : 'image');
}
function unitOf(item: UserModelSetting) {
  const type = (item.defaultPrice || item.customPrice)?.billingType;
  return type === 'per_second' ? '秒' : type === 'per_character' ? '字' : type === 'per_token' ? '百万 Token' : kindOf(item) === 'video' ? '条' : kindOf(item) === 'image' ? '张' : '次';
}
function initialDraft(item: UserModelSetting): Draft {
  return { accessMode: item.accessMode, input: item.customPrice ? String(item.customPrice.inputPrice) : '',
    output: item.customPrice?.billingType === 'per_token' ? String(item.customPrice.outputPrice) : '',
    resolutions: Object.fromEntries(Object.entries<number>(item.customPrice?.extraParams || {}).map(([key, value]) => [key, String(value)])) };
}
function hasPrice(draft: Draft) {
  return Boolean(draft.input.trim() || draft.output.trim() || Object.values<string>(draft.resolutions).some(value => value.trim()));
}
function defaultSummary(price: UserModelPrice | null) {
  if (!price) return '未配置';
  if (price.billingType === 'per_token') return `输入 ${number(price.inputPrice)} / 输出 ${number(price.outputPrice)}`;
  const extras = Object.entries<number>(price.extraParams);
  return extras.length ? extras.map(([key, value]) => `${key}：${number(value)}`).join(' / ') : number(price.inputPrice);
}
function parsePrice(raw: string, fallback = 0): number {
  if (!raw.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1e9) throw new Error('价格必须是有效的非负数字，免费请填写 0');
  return value;
}

export default function UserModelSettings({ user, onClose }: { user: { id: number; username?: string; email: string }; onClose: () => void }) {
  const [items, setItems] = useState<UserModelSetting[]>([]);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [onlyCustom, setOnlyCustom] = useState(false);
  const [tab, setTab] = useState<'prices' | 'access'>('prices');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setMessage(''); setItems([]); setDrafts({}); setPage(1);
    adminApi.getUserModels(user.id).then(data => {
      if (cancelled) return;
      setItems(data); setDrafts(Object.fromEntries(data.map(item => [item.id, initialDraft(item)])));
    }).catch(e => { if (!cancelled) setError(e.message || '模型配置加载失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user.id]);
  useEffect(() => { setPage(1); }, [search, kind, onlyCustom, tab]);
  useEffect(() => { scroll.current?.scrollTo?.({ top: 0 }); }, [page, search, kind, onlyCustom, tab]);

  const changed = items.filter(item => JSON.stringify(drafts[item.id]) !== JSON.stringify(initialDraft(item)));
  const filtered = items.filter(item => `${item.modelId} ${item.displayName}`.toLowerCase().includes(search.trim().toLowerCase())
    && (kind === 'all' || kindOf(item) === kind) && (tab !== 'prices' || !onlyCustom || hasPrice(drafts[item.id])));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const start = Math.max(1, Math.min(currentPage - 2, pages - 4));
  const pageNumbers = Array.from({ length: Math.min(5, pages) }, (_, index) => start + index);
  const change = (item: UserModelSetting, update: (draft: Draft) => Draft) => {
    setDrafts(current => ({ ...current, [item.id]: update(current[item.id]) }));
    setMessage(''); setError('');
  };
  const resetPrice = (item: UserModelSetting) => change(item, draft => ({ ...draft, input: '', output: '', resolutions: {} }));
  const setResolution = (item: UserModelSetting, key: string, value: string) => change(item, draft => {
    if (!hasPrice(draft) && !value.trim()) return draft;
    const base = hasPrice(draft) ? draft : { ...draft, input: String(item.defaultPrice!.inputPrice),
      resolutions: Object.fromEntries(Object.entries<number>(item.defaultPrice!.extraParams).map(([name, rate]) => [name, String(rate)])) };
    return { ...base, resolutions: { ...base.resolutions, [key]: value } };
  });
  const save = async () => {
    if (saving || !changed.length) return;
    try {
      const changes = changed.map(item => {
        const draft = drafts[item.id], custom = hasPrice(draft), base = item.defaultPrice;
        if (custom && !base) throw new Error(`${item.displayName} 尚未配置默认价格`);
        return { modelId: item.id, accessMode: draft.accessMode, pricingMode: custom ? 'custom' : 'inherit',
          expectedRevision: item.customPrice?.revision ?? null,
          customPrice: custom ? { billingType: base!.billingType, inputPrice: parsePrice(draft.input, base!.inputPrice),
            outputPrice: parsePrice(draft.output, item.customPrice?.outputPrice ?? base!.outputPrice),
            extraParams: Object.fromEntries(Object.entries<string>(draft.resolutions).filter(([, value]) => value.trim()).map(([key, value]) => [key, parsePrice(value)])) } : undefined };
      });
      setSaving(true); setError('');
      const updated = await adminApi.updateUserModels(user.id, changes);
      const byId = new Map(updated.map(item => [item.id, item]));
      setItems(current => current.map(item => byId.get(item.id) || item));
      setDrafts(current => ({ ...current, ...Object.fromEntries(updated.map(item => [item.id, initialDraft(item)])) }));
      setMessage(`已保存 ${updated.length} 个模型的设置`);
    } catch (e: any) { setError(e.message || '保存失败，请重试'); } finally { setSaving(false); }
  };

  return <AdminDrawer title={tab === 'prices' ? '模型独立价格' : '用户模型权限'} blocked={saving} onClose={onClose} modal panelClassName="user-model-dialog">
    <form className="user-model-workspace" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="user-model-intro">
        <p className="user-model-owner"><strong>{user.username || user.email}</strong>{user.username && <span>{user.email}</span>}<span>用户 #{user.id}</span></p>
        <p>{tab === 'prices' ? '填写后优先使用独立价格，留空按正常价格计费；0 表示免费。金额单位：元。' : '单独开通仍需满足功能权限和配额，平台停用的模型无法调用。'}</p>
        {tab === 'prices' && <p>统一单价适用于全部分辨率，也可展开分辨率价格单独设置。保存后仅影响新任务。</p>}
      </div>
      <div className="user-model-tabs" role="tablist" aria-label="配置类型" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); const next = tab === 'prices' ? 'access' : 'prices'; setTab(next);
        (event.currentTarget.querySelectorAll('button')[next === 'prices' ? 0 : 1] as HTMLButtonElement)?.focus();
      }}>
        <button type="button" id="user-model-prices-tab" role="tab" aria-selected={tab === 'prices'} aria-controls="user-model-panel" tabIndex={tab === 'prices' ? 0 : -1} disabled={saving} onClick={() => setTab('prices')}>独立价格</button>
        <button type="button" id="user-model-access-tab" role="tab" aria-selected={tab === 'access'} aria-controls="user-model-panel" tabIndex={tab === 'access' ? 0 : -1} disabled={saving} onClick={() => setTab('access')}>模型权限</button>
      </div>
      <div className="user-model-filters">
        <input type="search" aria-label="搜索模型" placeholder="搜索模型名称或编号" value={search} disabled={saving} onChange={event => setSearch(event.target.value)}/>
        <select aria-label="模型类型" value={kind} disabled={saving} onChange={event => setKind(event.target.value)}><option value="all">全部模型</option>{Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}模型</option>)}</select>
        {tab === 'prices' && <label><input type="checkbox" checked={onlyCustom} disabled={saving} onChange={event => setOnlyCustom(event.target.checked)}/>仅看独立价格</label>}
      </div>
      {error && <p role="alert" className="user-model-feedback is-error">{error}</p>}
      {message && <p role="status" className="user-model-feedback">{message}</p>}
      <div id="user-model-panel" role="tabpanel" aria-labelledby={tab === 'prices' ? 'user-model-prices-tab' : 'user-model-access-tab'} className="user-model-table-scroll" ref={scroll}>
        <table className={`user-model-table ${tab === 'access' ? 'is-access' : ''}`}>
          <thead><tr><th scope="col">模型</th>{tab === 'prices' ? <><th scope="col">正常价格（元）</th><th scope="col">独立单价（元）</th><th scope="col">设置</th></> : <><th scope="col">当前权限</th><th scope="col">用户权限</th></>}</tr></thead>
          <tbody>{loading ? <tr><td colSpan={tab === 'prices' ? 4 : 3} className="user-model-empty" role="status">正在加载模型…</td></tr> : !visible.length ? <tr><td colSpan={tab === 'prices' ? 4 : 3} className="user-model-empty">没有符合条件的模型</td></tr> : visible.map(item => {
            const draft = drafts[item.id], custom = hasPrice(draft), token = item.defaultPrice?.billingType === 'per_token';
            const resolutionKeys = [...new Map<string, string>(item.resolutions.map(key => [key.toLowerCase(), key])).values()];
            return <Fragment key={item.id}><tr className={changed.some(row => row.id === item.id) ? 'is-changed' : ''}>
              <td><strong className="user-model-name" title={item.displayName}>{item.modelId}</strong><small>{kindLabels[kindOf(item)]} · 每{unitOf(item)}{!item.active && ' · 已停用'}</small></td>
              {tab === 'prices' ? <><td className="user-model-default">{defaultSummary(item.defaultPrice)}</td><td>
                <div className="user-model-price-field"><input aria-label={`${item.displayName} 独立价格`} type="number" min="0" max="1000000000" step="any" disabled={saving || !item.defaultPrice} placeholder={item.defaultPrice ? '正常价格' : '未配置'} value={draft.input} onChange={event => change(item, value => ({ ...value, input: event.target.value, resolutions: {} }))}/><span>{token ? '输入' : `/ ${unitOf(item)}`}</span></div>
                {token && <div className="user-model-price-field"><input aria-label={`${item.displayName} 输出独立价格`} type="number" min="0" max="1000000000" step="any" disabled={saving || !item.defaultPrice} placeholder="正常价格" value={draft.output} onChange={event => change(item, value => ({ ...value, output: event.target.value }))}/><span>输出</span></div>}
                {resolutionKeys.length > 0 && item.defaultPrice && <button type="button" className="user-model-expand" aria-expanded={expanded.has(item.id)} aria-label={`${item.displayName} 分辨率价格`} disabled={saving} onClick={() => setExpanded(current => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; })}>{Object.values<string>(draft.resolutions).some(value => value.trim()) ? '分辨率独立价' : '按分辨率设置'} {expanded.has(item.id) ? '⌃' : '⌄'}</button>}
              </td><td className="user-model-setting"><button type="button" className="user-model-reset" disabled={saving || !custom} aria-label={`${item.displayName} 恢复默认价格`} onClick={() => resetPrice(item)}>{custom ? '恢复默认' : '按默认价格'}</button></td></> : <><td className="user-model-default">{item.accessMode === 'allow' ? '单独开通' : item.accessMode === 'deny' ? '禁止使用' : '继承现有权限'}</td><td><select aria-label={`${item.displayName} 模型权限`} disabled={saving} value={draft.accessMode} onChange={event => change(item, value => ({ ...value, accessMode: event.target.value as Draft['accessMode'] }))}><option value="inherit">继承现有权限</option><option value="allow">单独开通</option><option value="deny">禁止使用</option></select></td></>}
            </tr>{tab === 'prices' && expanded.has(item.id) && <tr className="user-model-resolution-row"><td colSpan={4}><div className="user-model-resolution-fields"><span>分辨率价格</span>{resolutionKeys.map(key => <label key={key}>{key}<input aria-label={`${item.displayName} ${key} 独立价格`} type="number" min="0" max="1000000000" step="any" disabled={saving} placeholder="统一单价" value={draft.resolutions[key] || ''} onChange={event => setResolution(item, key, event.target.value)}/></label>)}</div><p>留空使用本行统一单价；单独修改分辨率时会保留其他分辨率的正常价格。</p></td></tr>}</Fragment>;
          })}</tbody>
        </table>
      </div>
      <div className="user-model-pagination"><span>共 {filtered.length} 个模型</span><nav aria-label="模型分页"><button type="button" aria-label="上一页" disabled={saving || currentPage === 1} onClick={() => setPage(currentPage - 1)}>‹</button>{pageNumbers.map(value => <button key={value} type="button" aria-label={`第 ${value} 页`} aria-current={value === currentPage ? 'page' : undefined} disabled={saving} onClick={() => setPage(value)}>{value}</button>)}<button type="button" aria-label="下一页" disabled={saving || currentPage === pages} onClick={() => setPage(currentPage + 1)}>›</button></nav></div>
      <footer className="user-model-footer"><span>{changed.length ? `已修改 ${changed.length} 个模型` : '可同时设置多个模型'}</span><div><button type="button" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="user-model-save" disabled={loading || saving || !changed.length}>{saving ? '保存中…' : tab === 'prices' ? '保存价格' : '保存权限'}</button></div></footer>
    </form>
  </AdminDrawer>;
}
