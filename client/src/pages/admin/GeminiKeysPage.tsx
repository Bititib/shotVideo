import React, { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin';
import {
  Sparkles, Plus, Trash2, Activity, RefreshCw, Power, PowerOff,
  CheckCircle2, AlertTriangle, Clock3, XCircle, Info, Pencil,
} from 'lucide-react';

type GeminiPoolKey = {
  id: number;
  channelId: number;
  maskedKey: string;
  status: number;
  label: string;
  inCooldown: boolean;
  cooldownSecondsLeft: number;
  lastCheckedAt: string | null;
  lastStatus: 'ok' | 'rate_limited' | 'invalid' | 'error' | null;
  lastMessage: string;
  lastLatencyMs: number | null;
  modelCount: number | null;
  createdAt: string;
};

type GeminiPoolData = {
  channel: {
    id: number;
    name: string;
    baseUrl: string;
    status: number;
    supportedModels: string[];
  } | null;
  keys: GeminiPoolKey[];
  stats: {
    total: number;
    active: number;
    coolingDown: number;
    invalid: number;
  };
};

export default function GeminiKeysPage() {
  const [pool, setPool] = useState<GeminiPoolData | null>(null);
  const [loading, setLoading] = useState(true);
  const [rawText, setRawText] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://generativelanguage.googleapis.com');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [editingLabelId, setEditingLabelId] = useState<number | null>(null);
  const [editingLabelValue, setEditingLabelValue] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await adminApi.getGeminiKeys();
      setPool(res);
      if (res?.channel?.baseUrl) setBaseUrl(res.channel.baseUrl);
    } catch (e: any) {
      setNotice({ type: 'err', text: e?.message || '加载 Gemini Key 池失败' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rawText.trim()) return;
    setBusy('add');
    setNotice(null);
    try {
      const res = await adminApi.addGeminiKeys({ rawText, baseUrl });
      setPool(res.pool);
      setRawText('');
      const parts = [`新增 ${res.added} 个 Key`];
      if (res.skipped) parts.push(`跳过重复 ${res.skipped} 个`);
      if (res.invalid?.length) parts.push(`格式无效 ${res.invalid.length} 个`);
      setNotice({ type: res.added > 0 ? 'ok' : 'err', text: parts.join('，') });
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || '添加失败' });
    } finally {
      setBusy(null);
    }
  };

  const handleToggle = async (k: GeminiPoolKey) => {
    setBusy(`toggle-${k.id}`);
    try {
      const next = await adminApi.updateGeminiKey(k.id, { status: k.status === 1 ? 0 : 1 });
      setPool(next);
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || '更新状态失败' });
    } finally {
      setBusy(null);
    }
  };

  const handleSaveLabel = async (id: number) => {
    setBusy(`label-${id}`);
    try {
      const next = await adminApi.updateGeminiKey(id, { label: editingLabelValue });
      setPool(next);
      setEditingLabelId(null);
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || '保存备注失败' });
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (k: GeminiPoolKey) => {
    if (!confirm(`确定删除 Key ${k.maskedKey}？`)) return;
    setBusy(`del-${k.id}`);
    try {
      const next = await adminApi.deleteGeminiKey(k.id);
      setPool(next);
      setNotice({ type: 'ok', text: `已删除 ${k.maskedKey}` });
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || '删除失败' });
    } finally {
      setBusy(null);
    }
  };

  const handleTestOne = async (k: GeminiPoolKey) => {
    setBusy(`test-${k.id}`);
    setNotice(null);
    try {
      const res = await adminApi.testGeminiKey(k.id);
      setPool(res.pool);
      setNotice({ type: res.result.ok ? 'ok' : 'err', text: `${k.maskedKey}: ${res.result.message}` });
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || '检测失败' });
    } finally {
      setBusy(null);
    }
  };

  const handleTestAll = async () => {
    setBusy('test-all');
    setNotice(null);
    try {
      const next = await adminApi.testAllGeminiKeys();
      setPool(next);
      setNotice({ type: 'ok', text: `已完成全部启用 Key 检测：可用 ${next.stats.active} / 共 ${next.stats.total} 个` });
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || '批量检测失败' });
    } finally {
      setBusy(null);
    }
  };

  const handleSyncModels = async () => {
    setBusy('sync-models');
    setNotice(null);
    try {
      const res = await adminApi.syncGeminiPoolModels();
      setPool(res.pool);
      setNotice({ type: 'ok', text: `已同步 ${res.synced.count} 个 Gemini 模型（新增 ${res.synced.added} 个）` });
    } catch (err: any) {
      setNotice({ type: 'err', text: err?.message || '同步模型失败' });
    } finally {
      setBusy(null);
    }
  };

  const statusBadge = (k: GeminiPoolKey) => {
    if (k.status !== 1) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-zinc-500/15 text-zinc-400"><PowerOff className="w-3 h-3" /> 已停用</span>;
    if (k.inCooldown) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-amber-500/15 text-amber-300"><Clock3 className="w-3 h-3" /> 429 冷却 ({k.cooldownSecondsLeft}s)</span>;
    if (k.lastStatus === 'invalid') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-red-500/15 text-red-400"><XCircle className="w-3 h-3" /> Key 无效</span>;
    if (k.lastStatus === 'ok') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-emerald-500/15 text-emerald-400"><CheckCircle2 className="w-3 h-3" /> 正常</span>;
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-sky-500/15 text-sky-300">待检测</span>;
  };

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-emerald-400" /> Gemini 免费层 API Key 池
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            统一管理多个免费 Gemini API Key，自动轮询分发请求；单个 Key 遇到 429 限流时自动冷却 60 秒并切换下一个可用 Key。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={handleTestAll}
            disabled={Boolean(busy) || !pool?.keys.length}
            className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 text-xs font-medium text-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
            {busy === 'test-all' ? '检测中…' : '一键检测全部'}
          </button>
          <button
            onClick={handleSyncModels}
            disabled={Boolean(busy) || !pool?.stats.active}
            className="px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-xs font-medium text-emerald-400 flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy === 'sync-models' ? 'animate-spin' : ''}`} />
            {busy === 'sync-models' ? '同步中…' : '同步 Gemini 模型'}
          </button>
        </div>
      </div>

      {/* Quota Rule Explanation */}
      <div className="glass-card rounded-2xl border border-amber-500/30 p-4 text-xs leading-6 text-zinc-200 flex gap-3">
        <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div className="font-semibold text-amber-400">关于 Google 账号下多个免费 API Key 的额度规则说明</div>
          <p className="text-zinc-300">
            Google Gemini API 的免费额度（RPM / TPM / RPD）<strong>按 Google Cloud 项目（Project）计算，而不是按 Key 计算</strong>：
            同一个账号在<strong>同一个项目</strong>内创建多个 Key，<strong>共享同一份免费额度</strong>（轮换无法扩容）；
            只有来自<strong>不同 Google Cloud 项目</strong>或<strong>不同 Google 账号</strong>的 Key，免费额度才<strong>相互独立</strong>、可真正叠加轮换。建议在下方备注栏标明「账号/项目名」便于区分。
          </p>
        </div>
      </div>

      {notice && (
        <div className={`glass-card rounded-xl px-4 py-3 text-xs border flex items-center gap-2 ${
          notice.type === 'ok'
            ? 'border-emerald-500/30 text-emerald-400'
            : 'border-red-500/30 text-red-400'
        }`}>
          {notice.type === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass-card rounded-2xl p-4 border border-white/10">
          <div className="text-xs text-zinc-400">总 Key 数</div>
          <div className="text-2xl font-bold text-white mt-1">{pool?.stats.total ?? 0}</div>
        </div>
        <div className="glass-card rounded-2xl p-4 border border-white/10">
          <div className="text-xs text-zinc-400">可用中</div>
          <div className="text-2xl font-bold text-emerald-400 mt-1">{pool?.stats.active ?? 0}</div>
        </div>
        <div className="glass-card rounded-2xl p-4 border border-white/10">
          <div className="text-xs text-zinc-400">429 冷却中</div>
          <div className="text-2xl font-bold text-amber-400 mt-1">{pool?.stats.coolingDown ?? 0}</div>
        </div>
        <div className="glass-card rounded-2xl p-4 border border-white/10">
          <div className="text-xs text-zinc-400">绑定模型数</div>
          <div className="text-2xl font-bold text-blue-400 mt-1">{pool?.channel?.supportedModels?.length ?? 0}</div>
        </div>
      </div>

      {/* Add Form */}
      <form onSubmit={handleAdd} className="glass-card rounded-2xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">批量录入 Gemini API Key</h2>
            <p className="text-xs text-zinc-400 mt-0.5">每行一个 Key，支持 <code className="text-zinc-300">Key #账号或项目备注</code> 格式（支持 <code className="text-zinc-300">AIza...</code> 与 <code className="text-zinc-300">AQ....</code>）。</p>
          </div>
          <div className="sm:w-80">
            <input
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://generativelanguage.googleapis.com"
              aria-label="Gemini 接口地址"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-white font-mono focus:outline-none"
            />
          </div>
        </div>

        <textarea
          rows={4}
          value={rawText}
          onChange={e => setRawText(e.target.value)}
          placeholder={'AQ.Ab8RN6... #账号A-项目1\nAIzaSyD... #账号B-项目1'}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-3.5 py-2.5 text-xs text-white font-mono focus:outline-none placeholder:text-zinc-600"
        />

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-zinc-500">
            {pool?.channel ? `关联渠道：#${pool.channel.id} ${pool.channel.name}` : '首次添加将自动创建「Gemini 免费层 Key 池」渠道'}
          </span>
          <button
            type="submit"
            disabled={Boolean(busy) || !rawText.trim()}
            className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            {busy === 'add' ? '保存中…' : '添加到 Key 池'}
          </button>
        </div>
      </form>

      {/* Key Table */}
      <div className="glass-card rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-white/[0.03] text-zinc-400 border-b border-white/10">
              <tr>
                <th className="px-4 py-3 font-medium">掩码 Key</th>
                <th className="px-4 py-3 font-medium">项目 / 账号备注</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">最近检测结果</th>
                <th className="px-4 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">加载中…</td></tr>
              ) : !pool?.keys.length ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500">尚未添加任何 Gemini Key，请在上方录入。</td></tr>
              ) : pool.keys.map(k => (
                <tr key={k.id} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3 font-mono text-zinc-200">{k.maskedKey}</td>
                  <td className="px-4 py-3">
                    {editingLabelId === k.id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={editingLabelValue}
                          onChange={e => setEditingLabelValue(e.target.value)}
                          placeholder="如：账号A-项目2"
                          className="bg-white/10 border border-white/20 rounded-lg px-2 py-1 text-xs text-white w-36 focus:outline-none"
                        />
                        <button type="button" onClick={() => void handleSaveLabel(k.id)} className="px-2 py-1 rounded bg-emerald-500/20 text-emerald-300">保存</button>
                        <button type="button" onClick={() => setEditingLabelId(null)} className="px-2 py-1 rounded bg-white/5 text-zinc-400">取消</button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setEditingLabelId(k.id); setEditingLabelValue(k.label || ''); }}
                        className="inline-flex items-center gap-1.5 text-zinc-300 hover:text-white"
                      >
                        <span>{k.label || <span className="text-zinc-500">点击添加备注</span>}</span>
                        <Pencil className="w-3 h-3 text-zinc-500" />
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3">{statusBadge(k)}</td>
                  <td className="px-4 py-3 text-zinc-400 max-w-xs truncate" title={k.lastMessage}>
                    {k.lastMessage || '—'}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap space-x-1.5">
                    <button
                      type="button"
                      onClick={() => void handleTestOne(k)}
                      disabled={Boolean(busy)}
                      className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-200 disabled:opacity-50"
                    >
                      {busy === `test-${k.id}` ? '检测中' : '测活'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggle(k)}
                      disabled={Boolean(busy)}
                      title={k.status === 1 ? '停用' : '启用'}
                      className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300 align-middle disabled:opacity-50"
                    >
                      {k.status === 1 ? <Power className="w-3.5 h-3.5 text-emerald-400" /> : <PowerOff className="w-3.5 h-3.5 text-zinc-500" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(k)}
                      disabled={Boolean(busy)}
                      title="删除"
                      className="p-1.5 rounded-lg bg-white/5 hover:bg-red-500/20 text-zinc-400 hover:text-red-300 align-middle disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
