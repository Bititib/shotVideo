import React, { useEffect, useState } from 'react';
import { analysisApi, getCachedAnalysisModels } from '../api/analysis';
import { Cpu } from 'lucide-react';

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string) => void;
}

/** 模型选择器 - 在各分析页面中复用 */
export default function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const [models, setModels] = useState(getCachedAnalysisModels);
  const [loading, setLoading] = useState(() => models.length === 0);

  useEffect(() => {
    analysisApi.getAvailableModels()
      .then(list => {
        setModels(list);
        // 自动选第一个（如果没有预选）
        if (!value && list.length > 0) onChange(list[0].modelId);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading || models.length === 0) return null;

  // 只有一个模型时不显示选择器
  if (models.length === 1) return null;

  return (
    <div className="mb-4">
      <label className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">
        <Cpu className="w-3.5 h-3.5" />
        AI 模型
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-blue-500/50 transition-all appearance-none cursor-pointer"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' viewBox='0 0 24 24' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 12px center',
        }}
      >
        {models.map(m => (
          <option key={m.modelId} value={m.modelId} className="bg-zinc-900 text-white">
            {m.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}
