import React, { useEffect, useMemo, useState } from 'react';
import { adminApi } from '../../api/admin';
import {
  Asterisk,
  AudioLines,
  CircleDollarSign,
  Coins,
  Image as ImageIcon,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Trash2,
  Video,
  X,
} from 'lucide-react';

type Category = 'all' | 'text' | 'image' | 'video' | 'tts' | 'default' | 'other';
type BillingType = 'all' | 'per_call' | 'per_token' | 'per_second' | 'per_character';

interface PricingRule {
  id: number | null;
  modelPattern: string;
  displayName: string;
  category: Exclude<Category, 'all'>;
  billingType: Exclude<BillingType, 'all'>;
  inputPrice: number;
  outputPrice: number;
  extraParams: Record<string, any>;
  modelActive: boolean | null;
  configured: boolean;
  inherited: boolean;
}

const categories: { value: Category; label: string; icon: React.ElementType }[] = [
  { value: 'all', label: '全部', icon: Coins },
  { value: 'video', label: '视频', icon: Video },
  { value: 'image', label: '图片', icon: ImageIcon },
  { value: 'tts', label: '语音', icon: AudioLines },
  { value: 'text', label: '文本', icon: MessageSquareText },
  { value: 'default', label: '默认', icon: Asterisk },
];

const billingLabels: Record<string, string> = {
  per_call: '按次计费',
  per_token: '按 Token 计费',
  per_second: '按秒计费',
  per_character: '按字计费',
};

const unitLabels: Record<string, string> = {
  per_call: '/次',
  per_token: '/百万 Token',
  per_second: '/秒',
  per_character: '/字',
};

const categoryLabels: Record<string, string> = {
  text: '文本', image: '图片', video: '视频', tts: '语音', default: '默认', other: '其他',
};

const categoryIcons: Record<string, React.ElementType> = {
  text: MessageSquareText,
  image: ImageIcon,
  video: Video,
  tts: AudioLines,
  default: Asterisk,
  other: Coins,
};

function formatPrice(value: number) {
  return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export default function PricingPage() {
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [billingType, setBillingType] = useState<BillingType>('all');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setRules(await adminApi.getPricing());
    } catch (err: any) {
      setError(err.message || '计费规则加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filteredRules = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return rules.filter(rule => {
      const matchesSearch = !keyword
        || rule.modelPattern.toLowerCase().includes(keyword)
        || rule.displayName.toLowerCase().includes(keyword);
      return matchesSearch
        && (category === 'all' || rule.category === category)
        && (billingType === 'all' || rule.billingType === billingType);
    });
  }, [rules, search, category, billingType]);

  const countByCategory = (value: Category) => value === 'all'
    ? rules.length
    : rules.filter(rule => rule.category === value).length;

  const openNew = () => setEdit({
    modelPattern: '',
    category: 'video',
    billingType: 'per_call',
    inputPrice: 0,
    outputPrice: 0,
    extraText: '',
    isNew: true,
  });

  const openEdit = (rule: PricingRule) => {
    const extras = Object.entries(rule.extraParams || {})
      .filter(([key]) => key !== 'category')
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    setEdit({ ...rule, extraText: extras, isNew: !rule.configured, lockedModel: rule.modelActive === true });
  };

  const handleSave = async () => {
    if (!edit || saving) return;
    setError('');
    const modelPattern = String(edit.modelPattern || '').trim();
    const inputPrice = Number(edit.inputPrice);
    const outputPrice = Number(edit.outputPrice);
    if (!modelPattern) return setError('请填写模型标识');
    if (!Number.isFinite(inputPrice) || inputPrice < 0 || !Number.isFinite(outputPrice) || outputPrice < 0) {
      return setError('价格必须是大于或等于 0 的有效数字');
    }

    const extraParams: Record<string, any> = { category: edit.category };
    for (const rawLine of String(edit.extraText || '').split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const separator = line.indexOf(':');
      if (separator <= 0) return setError(`附加价格格式错误：${line}`);
      const key = line.slice(0, separator).trim();
      const value = Number(line.slice(separator + 1).trim());
      if (!key || !Number.isFinite(value) || value < 0) return setError(`附加价格格式错误：${line}`);
      extraParams[key] = value;
    }

    setSaving(true);
    try {
      const payload = { modelPattern, billingType: edit.billingType, inputPrice, outputPrice, extraParams };
      if (edit.isNew) await adminApi.createPricing(payload);
      else await adminApi.updatePricing(edit.id, payload);
      setEdit(null);
      await load();
    } catch (err: any) {
      setError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (rule: PricingRule) => {
    if (rule.id === null) return;
    if (!confirm(`确定删除 ${rule.displayName} 的计费规则吗？删除后相关调用将无法报价。`)) return;
    try {
      await adminApi.deletePricing(rule.id);
      await load();
    } catch (err: any) {
      setError(err.message || '删除失败');
    }
  };

  return (
    <div className="pricing-page p-5 md:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-5 mb-7">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.18em] uppercase text-[#9a4f2f] mb-2">
            <CircleDollarSign className="w-4 h-4" /> Billing center
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">统一计费设置</h1>
          <p className="text-sm text-zinc-500 mt-2 max-w-2xl">卡片自动跟随模型管理中的启用状态；删除或停用模型后会自动从此页消失。</p>
        </div>
        <button onClick={openNew} className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-semibold transition-colors">
          <Plus className="w-4 h-4" /> 新增计费规则
        </button>
      </header>

      <section className="pricing-summary-grid grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5" aria-label="计费概览">
        {[
          { label: '启用模型', value: rules.filter(rule => rule.modelActive === true).length, helper: '自动同步' },
          { label: '视频模型', value: countByCategory('video'), helper: '按次或按秒' },
          { label: '图片模型', value: countByCategory('image'), helper: '通常按次' },
          { label: '文本与语音', value: countByCategory('text') + countByCategory('tts'), helper: '按量计费' },
        ].map(item => (
          <div key={item.label} className="pricing-summary-card rounded-2xl border p-4 md:p-5">
            <p className="text-xs text-zinc-500">{item.label}</p>
            <div className="flex items-end justify-between gap-2 mt-2">
              <strong className="text-2xl md:text-3xl tabular-nums text-white">{item.value}</strong>
              <span className="text-[10px] text-zinc-500">{item.helper}</span>
            </div>
          </div>
        ))}
      </section>

      <section className="pricing-filter-panel rounded-2xl border p-3 md:p-4 mb-6">
        <div className="flex flex-col xl:flex-row gap-3 xl:items-center">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" aria-hidden="true" />
            <input
              aria-label="搜索模型"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="搜索模型名称或模型 ID"
              className="w-full h-11 pl-10 pr-4 rounded-xl border text-sm focus:outline-none"
            />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 xl:pb-0" aria-label="业务分类筛选">
            {categories.map(item => {
              const Icon = item.icon;
              const active = category === item.value;
              return (
                <button
                  key={item.value}
                  onClick={() => setCategory(item.value)}
                  aria-pressed={active}
                  className={`pricing-filter-chip inline-flex items-center gap-1.5 px-3 h-11 rounded-xl border text-xs font-medium whitespace-nowrap transition-colors ${active ? 'is-active' : ''}`}
                >
                  <Icon className="w-3.5 h-3.5" /> {item.label}
                  <span className="tabular-nums opacity-60">{countByCategory(item.value)}</span>
                </button>
              );
            })}
          </div>
          <select
            aria-label="计费方式筛选"
            value={billingType}
            onChange={event => setBillingType(event.target.value as BillingType)}
            className="h-11 min-w-36 rounded-xl border px-3 text-sm focus:outline-none"
          >
            <option value="all">全部计费方式</option>
            <option value="per_call">按次计费</option>
            <option value="per_second">按秒计费</option>
            <option value="per_character">按字计费</option>
            <option value="per_token">按 Token 计费</option>
          </select>
        </div>
      </section>

      {error && (
        <div role="alert" className="mb-5 px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/10 text-sm text-red-400">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24"><div className="w-8 h-8 border-2 border-[#d8c0a3] border-t-[#9a4f2f] rounded-full animate-spin" /></div>
      ) : filteredRules.length > 0 ? (
        <div className="pricing-card-grid grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredRules.map(rule => {
            const Icon = categoryIcons[rule.category] || Coins;
            const extraPrices = Object.entries(rule.extraParams || {}).filter(([key]) => key !== 'category');
            return (
              <article key={`${rule.modelPattern}-${rule.id ?? 'virtual'}`} className="pricing-rule-card rounded-2xl border p-5 flex flex-col min-h-56">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="pricing-rule-icon w-10 h-10 rounded-xl flex items-center justify-center shrink-0">
                      <Icon className="w-5 h-5" strokeWidth={1.8} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        <span className="pricing-badge">{categoryLabels[rule.category] || '其他'}</span>
                        <span className="pricing-badge is-soft">{billingLabels[rule.billingType]}</span>
                        {rule.inherited && <span className="pricing-badge is-inherited">继承默认</span>}
                        {!rule.configured && !rule.inherited && <span className="pricing-badge is-warning">待配置</span>}
                      </div>
                      <h2 className="text-sm font-bold text-white leading-5 break-words">{rule.displayName}</h2>
                      <code className="block text-[11px] text-zinc-500 mt-1 break-all">{rule.modelPattern}</code>
                    </div>
                  </div>
                </div>

                <div className="mt-5 pt-4 border-t border-white/5 flex-1">
                  {rule.billingType === 'per_token' ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div><p className="text-[10px] text-zinc-500">输入</p><p className="text-lg font-bold tabular-nums text-white mt-1">¥{formatPrice(rule.inputPrice)}</p></div>
                      <div><p className="text-[10px] text-zinc-500">输出</p><p className="text-lg font-bold tabular-nums text-white mt-1">¥{formatPrice(rule.outputPrice)}</p></div>
                    </div>
                  ) : (
                    <div>
                      <p className="text-[10px] text-zinc-500">当前单价</p>
                      <p className="text-2xl font-bold tabular-nums text-white mt-1">¥{formatPrice(rule.inputPrice)}<span className="text-xs font-medium text-zinc-500 ml-1">{unitLabels[rule.billingType]}</span></p>
                    </div>
                  )}
                  {extraPrices.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {extraPrices.map(([key, value]) => <span key={key} className="pricing-extra-pill">{key} · ¥{formatPrice(Number(value))}</span>)}
                    </div>
                  )}
                </div>

                <div className="flex gap-2 mt-4">
                  <button onClick={() => openEdit(rule)} className="pricing-card-action flex-1 inline-flex items-center justify-center gap-1.5 h-10 rounded-xl border text-xs font-semibold">
                    <Pencil className="w-3.5 h-3.5" /> {rule.configured ? '编辑' : rule.inherited ? '设置独立价格' : '配置价格'}
                  </button>
                  {rule.configured && rule.id !== null && (
                    <button onClick={() => handleDelete(rule)} aria-label={`删除 ${rule.displayName}`} className="pricing-card-action is-danger w-10 h-10 inline-flex items-center justify-center rounded-xl border">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="pricing-empty rounded-2xl border py-16 text-center">
          <Coins className="w-8 h-8 mx-auto text-zinc-500 mb-3" />
          <p className="text-sm font-semibold text-white">没有符合条件的计费规则</p>
          <p className="text-xs text-zinc-500 mt-1">调整筛选条件或新增一条规则。</p>
        </div>
      )}

      {edit && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onMouseDown={() => setEdit(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="pricing-dialog-title" className="pricing-modal bg-[#1a1a1a] border border-white/10 rounded-2xl p-5 md:p-6 w-full max-w-xl max-h-[92vh] overflow-y-auto" onMouseDown={event => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <h2 id="pricing-dialog-title" className="text-lg font-bold text-white">{edit.isNew ? '新增计费规则' : '编辑计费规则'}</h2>
                <p className="text-xs text-zinc-500 mt-1">保存后，模型列表展示与实际扣费会同时生效。</p>
              </div>
              <button onClick={() => setEdit(null)} aria-label="关闭" className="pricing-modal-close w-10 h-10 rounded-xl inline-flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="pricing-model" className="block text-xs font-semibold text-zinc-400 mb-1.5">模型标识</label>
                <input id="pricing-model" value={edit.modelPattern} onChange={event => setEdit({ ...edit, modelPattern: event.target.value })} disabled={edit.lockedModel} placeholder="例如：seedance-2.5-c1" className="w-full h-11 rounded-xl border px-4 text-sm font-mono focus:outline-none disabled:opacity-70 disabled:cursor-not-allowed" />
                <p className="text-[10px] text-zinc-500 mt-1.5">必须与模型管理或 API 请求中的 model 完全一致；* 仅作为文本 Token 默认规则。</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="pricing-category" className="block text-xs font-semibold text-zinc-400 mb-1.5">业务分类</label>
                  <select id="pricing-category" value={edit.category} onChange={event => setEdit({ ...edit, category: event.target.value })} className="w-full h-11 rounded-xl border px-3 text-sm focus:outline-none">
                    <option value="video">视频</option><option value="image">图片</option><option value="tts">语音</option><option value="text">文本</option><option value="default">默认</option><option value="other">其他</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="pricing-type" className="block text-xs font-semibold text-zinc-400 mb-1.5">计费方式</label>
                  <select id="pricing-type" value={edit.billingType} onChange={event => setEdit({ ...edit, billingType: event.target.value })} className="w-full h-11 rounded-xl border px-3 text-sm focus:outline-none">
                    <option value="per_call">按次</option><option value="per_second">按秒</option><option value="per_character">按字</option><option value="per_token">按 Token</option>
                  </select>
                </div>
              </div>

              <div className={`grid grid-cols-1 ${edit.billingType === 'per_token' ? 'sm:grid-cols-2' : ''} gap-4`}>
                <div>
                  <label htmlFor="pricing-input" className="block text-xs font-semibold text-zinc-400 mb-1.5">{edit.billingType === 'per_token' ? '输入价格（¥/百万 Token）' : `单价（¥${unitLabels[edit.billingType] || ''}）`}</label>
                  <input id="pricing-input" type="number" min="0" step="0.001" value={edit.inputPrice} onChange={event => setEdit({ ...edit, inputPrice: event.target.value })} className="w-full h-11 rounded-xl border px-4 text-sm tabular-nums focus:outline-none" />
                </div>
                {edit.billingType === 'per_token' && (
                  <div>
                    <label htmlFor="pricing-output" className="block text-xs font-semibold text-zinc-400 mb-1.5">输出价格（¥/百万 Token）</label>
                    <input id="pricing-output" type="number" min="0" step="0.001" value={edit.outputPrice} onChange={event => setEdit({ ...edit, outputPrice: event.target.value })} className="w-full h-11 rounded-xl border px-4 text-sm tabular-nums focus:outline-none" />
                  </div>
                )}
              </div>

              <div>
                <label htmlFor="pricing-extra" className="block text-xs font-semibold text-zinc-400 mb-1.5">规格附加价格（可选）</label>
                <textarea id="pricing-extra" value={edit.extraText} onChange={event => setEdit({ ...edit, extraText: event.target.value })} rows={3} placeholder={'720p: 0.25\n1080p: 0.40'} className="w-full rounded-xl border px-4 py-3 text-sm font-mono resize-y focus:outline-none" />
                <p className="text-[10px] text-zinc-500 mt-1.5">每行填写“规格: 单价”。请求携带对应 resolution 时优先使用该单价。</p>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={() => setEdit(null)} className="pricing-secondary-button flex-1 h-11 rounded-xl border text-sm font-semibold">取消</button>
              <button onClick={handleSave} disabled={saving} className="flex-1 h-11 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-semibold disabled:opacity-50">
                {saving ? '保存中…' : '保存并立即生效'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
