import React, { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin';
import { Plus, Cpu, Power, PowerOff, Sparkles, Layers, DollarSign, Clock, FileText, Image } from 'lucide-react';

const PRESET_GROUPS = [
  'Seedance 系列',
  'Grok (Luma) 系列',
  'Omni 系列',
  'Veo (Google) 系列',
  'Sora 系列',
  '其他模型'
];

export default function ModelsPage() {
  const [models, setModels] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [useJsonMode, setUseJsonMode] = useState(false);

  const load = async () => {
    setLoading(true);
    setModels(await adminApi.getModels());
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const parseVideoConfigToFields = (m: any) => {
    let cfg: any = {};
    if (m?.videoConfig) {
      try {
        cfg = typeof m.videoConfig === 'object' ? m.videoConfig : JSON.parse(m.videoConfig);
      } catch {}
    }
    return {
      vGroup: cfg.group || 'Seedance 系列',
      vBillingType: cfg.billingType || 'flat',
      vDefaultRate: cfg.defaultRate !== undefined ? cfg.defaultRate : 2.5,
      vRateSettingKey: cfg.rateSettingKey || '',
      vMaxSeconds: cfg.maxSeconds || 15,
      vAllowedSeconds: Array.isArray(cfg.allowedSeconds) ? cfg.allowedSeconds.join(', ') : '5, 6, 7, 8, 9, 10, 15',
      vRequireRef: cfg.requireRef || false,
      vDescription: cfg.description || '',
      vIcon: cfg.icon || '⚡',
      videoConfigRaw: m?.videoConfig ? (typeof m.videoConfig === 'object' ? JSON.stringify(m.videoConfig, null, 2) : m.videoConfig) : '',
    };
  };

  const openNew = () => {
    setUseJsonMode(false);
    setEdit({
      provider: 'sudashui',
      modelId: '',
      displayName: '',
      apiKey: '',
      capabilities: ['video'],
      isActive: 1,
      isNew: true,
      vGroup: 'Seedance 系列',
      vBillingType: 'flat',
      vDefaultRate: 2.5,
      vRateSettingKey: '',
      vMaxSeconds: 15,
      vAllowedSeconds: '5, 6, 7, 8, 9, 10, 15',
      vRequireRef: false,
      vDescription: 'Seedance 2.0 基础生成模型',
      vIcon: '⚡',
      videoConfigRaw: '',
    });
  };

  const openEdit = (m: any) => {
    setUseJsonMode(false);
    setEdit({
      ...m,
      apiKey: '',
      ...parseVideoConfigToFields(m),
      isNew: false
    });
  };

  const handleSave = async () => {
    if (!edit) return;
    try {
      const data: any = {
        provider: edit.provider,
        modelId: edit.modelId,
        displayName: edit.displayName,
        capabilities: edit.capabilities,
        isActive: edit.isActive
      };
      if (edit.apiKey) data.apiKey = edit.apiKey;

      if (edit.capabilities.includes('video')) {
        if (useJsonMode) {
          if (edit.videoConfigRaw) {
            try {
              JSON.parse(edit.videoConfigRaw);
              data.videoConfig = edit.videoConfigRaw;
            } catch {
              alert('高级 JSON 格式无效，请检查校验');
              return;
            }
          }
        } else {
          const allowedSecs = edit.vAllowedSeconds
            ? edit.vAllowedSeconds.split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n))
            : null;
          
          const vConfigObj = {
            series: edit.provider || 'custom',
            allowedSeconds: allowedSecs && allowedSecs.length > 0 ? allowedSecs : null,
            requireRef: Boolean(edit.vRequireRef),
            maxSeconds: Number(edit.vMaxSeconds) || 15,
            billingType: edit.vBillingType || 'flat',
            rateSettingKey: edit.vRateSettingKey || '',
            defaultRate: Number(edit.vDefaultRate) || 0,
            description: edit.vDescription || '',
            icon: edit.vIcon || '⚡',
            group: edit.vGroup || '其他模型',
          };
          data.videoConfig = JSON.stringify(vConfigObj);
        }
      }

      if (edit.isNew) {
        await adminApi.createModel(data);
      } else {
        await adminApi.updateModel(edit.id, data);
      }
      setEdit(null);
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定删除此模型？')) return;
    try {
      await adminApi.deleteModel(id);
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const toggleActive = async (m: any) => {
    try {
      await adminApi.updateModel(m.id, { isActive: m.isActive ? 0 : 1 });
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin" /></div>;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">🤖 大模型配置管理</h1>
          <p className="text-xs text-zinc-400 mt-1">管理所有大语言模型、图片模型及视频模型的计费与能力划分</p>
        </div>
        <button onClick={openNew} className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors shadow-lg shadow-blue-500/20">
          <Plus className="w-4 h-4" /> 添加模型
        </button>
      </div>

      <div className="space-y-4">
        {models.map(m => (
          <div key={m.id} className={`bg-white/[0.02] border rounded-2xl p-5 transition-all ${m.isActive ? 'border-white/5 hover:border-white/10' : 'border-red-500/20 opacity-60'}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center border border-white/5 text-lg">
                  {m.capabilities?.includes('video') ? '🎥' : m.capabilities?.includes('image') ? '🖼️' : '🤖'}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    {m.displayName}
                    {m.capabilities?.includes('video') && (
                      <span className="text-[10px] bg-purple-500/10 text-purple-300 border border-purple-500/20 px-2 py-0.5 rounded-full font-medium">视频模型</span>
                    )}
                  </h3>
                  <p className="text-[11px] text-zinc-500 font-mono mt-0.5">{m.provider} · {m.modelId}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => toggleActive(m)} className={`p-2 rounded-xl transition-colors ${m.isActive ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'}`}>
                  {m.isActive ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                </button>
                <button onClick={() => openEdit(m)} className="text-xs px-3.5 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-zinc-200 transition-colors">编辑配置</button>
                <button onClick={() => handleDelete(m.id)} className="text-xs px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-xl text-red-400 transition-colors">删除</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-zinc-400 border-t border-white/5 pt-3 mt-3">
              <span>能力: <span className="text-zinc-200 font-medium">{Array.isArray(m.capabilities) ? m.capabilities.join(', ') : '-'}</span></span>
              <span>API Key: <span className="text-zinc-300 font-mono">{m.apiKey || '全局默认Key'}</span></span>
              <span>累计调用: <span className="text-zinc-300">{m.totalCalls?.toLocaleString() || 0} 次</span></span>
            </div>
          </div>
        ))}
      </div>

      {/* Edit Modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4" onClick={() => setEdit(null)}>
          <div className="bg-[#18181b] border border-white/10 rounded-2xl p-6 w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6 pb-4 border-b border-white/10">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-blue-400" />
                {edit.isNew ? '添加新大模型' : `编辑模型配置: ${edit.displayName}`}
              </h3>
              <button onClick={() => setEdit(null)} className="text-zinc-400 hover:text-white text-sm px-2">✕</button>
            </div>

            <div className="space-y-4">
              {/* 基础模型属性 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">渠道供应商</label>
                  <select value={edit.provider} onChange={e => setEdit({ ...edit, provider: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500/50">
                    <option value="sudashui">速大水 (sudashui)</option>
                    <option value="seedance">Seedance</option>
                    <option value="grok">Grok (xAI)</option>
                    <option value="omni">Omni</option>
                    <option value="pidoi">Pidoi (Veo)</option>
                    <option value="google">Google Gemini</option>
                    <option value="openai">OpenAI</option>
                    <option value="other">其他供应商</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">模型 ID (标识串)</label>
                  <input type="text" value={edit.modelId} onChange={e => setEdit({ ...edit, modelId: e.target.value })} placeholder="如 sdas-pd-sd2.0-fast-933-720p" disabled={!edit.isNew} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none disabled:opacity-50 font-mono" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">前台显示名称</label>
                <input type="text" value={edit.displayName} onChange={e => setEdit({ ...edit, displayName: e.target.value })} placeholder="如 Seedance 2.0 Fast 720p" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500/50" />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">专用 API Key (留空 = 自动继承全局渠道 Key)</label>
                <input type="password" value={edit.apiKey} onChange={e => setEdit({ ...edit, apiKey: e.target.value })} placeholder={edit.isNew ? '可选' : '留空 = 不修改'} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none placeholder:text-zinc-600 font-mono" />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-2">模型支持能力</label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: 'text', label: '💬 文本分析' },
                    { id: 'image', label: '🖼️ 图片分析' },
                    { id: 'image_gen', label: '🎨 图像生成' },
                    { id: 'video', label: '🎥 视频生成' }
                  ].map(cap => (
                    <button key={cap.id} onClick={() => setEdit({ ...edit, capabilities: edit.capabilities.includes(cap.id) ? edit.capabilities.filter((c: string) => c !== cap.id) : [...edit.capabilities, cap.id] })}
                      className={`px-3.5 py-2 rounded-xl text-xs font-medium transition-all ${edit.capabilities.includes(cap.id) ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40 shadow-sm' : 'bg-white/5 text-zinc-400 border border-white/5 hover:border-white/10'}`}>{cap.label}</button>
                  ))}
                </div>
              </div>

              {/* 🎥 视频模型可视表单配置 */}
              {edit.capabilities.includes('video') && (
                <div className="mt-6 pt-5 border-t border-white/10 space-y-4 bg-white/[0.01] p-4 rounded-2xl border border-purple-500/20">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-purple-300 uppercase tracking-wider flex items-center gap-2">
                      <Layers className="w-4 h-4 text-purple-400" />
                      视频生成功能与计费配置
                    </h4>
                    <button type="button" onClick={() => setUseJsonMode(!useJsonMode)} className="text-[11px] text-zinc-400 hover:text-white underline">
                      {useJsonMode ? '切换为：可视化极简表单模式' : '切换为：高级代码 JSON 模式'}
                    </button>
                  </div>

                  {useJsonMode ? (
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1.5">高级 JSON 代码配置</label>
                      <textarea
                        rows={6}
                        value={edit.videoConfigRaw || ''}
                        onChange={e => setEdit({ ...edit, videoConfigRaw: e.target.value })}
                        className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs font-mono text-zinc-200 focus:outline-none"
                      />
                    </div>
                  ) : (
                    <div className="space-y-4 text-xs">
                      {/* 分组与计费方式 */}
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-zinc-400 mb-1.5 flex items-center gap-1">
                            <Layers className="w-3.5 h-3.5 text-zinc-400" /> 侧边栏所属分组
                          </label>
                          <select value={edit.vGroup} onChange={e => setEdit({ ...edit, vGroup: e.target.value })} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none">
                            {PRESET_GROUPS.map(g => (
                              <option key={g} value={g}>{g}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-zinc-400 mb-1.5 flex items-center gap-1">
                            <DollarSign className="w-3.5 h-3.5 text-zinc-400" /> 扣费计费模式
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            <button type="button" onClick={() => setEdit({ ...edit, vBillingType: 'flat' })} className={`py-2 rounded-xl text-xs font-medium border transition-all ${edit.vBillingType === 'flat' ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' : 'bg-white/5 text-zinc-400 border-white/5'}`}>
                              📌 按次计费
                            </button>
                            <button type="button" onClick={() => setEdit({ ...edit, vBillingType: 'per_second' })} className={`py-2 rounded-xl text-xs font-medium border transition-all ${edit.vBillingType === 'per_second' ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' : 'bg-white/5 text-zinc-400 border-white/5'}`}>
                              ⏱️ 按秒计费
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* 价格与 Setting Key */}
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-zinc-400 mb-1.5">
                            {edit.vBillingType === 'flat' ? '每次收费基础价格 (元/次)' : '每秒单价 (元/秒)'}
                          </label>
                          <input type="number" step="0.01" value={edit.vDefaultRate} onChange={e => setEdit({ ...edit, vDefaultRate: e.target.value })} placeholder="例如 2.50" className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none" />
                        </div>
                        <div>
                          <label className="block text-zinc-400 mb-1.5">
                            关联系统设置 Key (选填，留空使用基础价格)
                          </label>
                          <input type="text" value={edit.vRateSettingKey} onChange={e => setEdit({ ...edit, vRateSettingKey: e.target.value })} placeholder="如 sdas_pd_fast_rate" className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white font-mono focus:outline-none" />
                        </div>
                      </div>

                      {/* 时长限制 */}
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-zinc-400 mb-1.5 flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-zinc-400" /> 可选时长范围 (逗号隔开)
                          </label>
                          <input type="text" value={edit.vAllowedSeconds} onChange={e => setEdit({ ...edit, vAllowedSeconds: e.target.value })} placeholder="例如 5, 6, 10, 15" className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white font-mono focus:outline-none" />
                        </div>
                        <div>
                          <label className="block text-zinc-400 mb-1.5">最大时长 (秒)</label>
                          <input type="number" value={edit.vMaxSeconds} onChange={e => setEdit({ ...edit, vMaxSeconds: e.target.value })} placeholder="15" className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none" />
                        </div>
                      </div>

                      {/* 图标与描述 */}
                      <div className="grid grid-cols-4 gap-4">
                        <div>
                          <label className="block text-zinc-400 mb-1.5">图标 Emoji</label>
                          <input type="text" value={edit.vIcon} onChange={e => setEdit({ ...edit, vIcon: e.target.value })} placeholder="🚀" className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-center focus:outline-none" />
                        </div>
                        <div className="col-span-3">
                          <label className="block text-zinc-400 mb-1.5 flex items-center gap-1">
                            <FileText className="w-3.5 h-3.5 text-zinc-400" /> 模型卡片功能简介
                          </label>
                          <input type="text" value={edit.vDescription} onChange={e => setEdit({ ...edit, vDescription: e.target.value })} placeholder="简要描述模型特性" className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none" />
                        </div>
                      </div>

                      {/* 强制参考图选项 */}
                      <div className="pt-2">
                        <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
                          <input type="checkbox" checked={edit.vRequireRef} onChange={e => setEdit({ ...edit, vRequireRef: e.target.checked })} className="rounded bg-white/10 border-white/20 text-blue-500 focus:ring-0" />
                          <span>强制要求用户必须上传参考图片 (例如 Luma 1.5 Preview 图生视频)</span>
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-8 pt-4 border-t border-white/10">
              <button onClick={() => setEdit(null)} className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-sm transition-colors text-zinc-300">取消</button>
              <button onClick={handleSave} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm font-medium transition-colors shadow-lg shadow-blue-500/20 text-white">确认保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
