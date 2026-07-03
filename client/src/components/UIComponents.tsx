import React from 'react';
import { Copy, Check } from 'lucide-react';

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={handleCopy} className={`p-1.5 rounded-lg hover:bg-white/10 transition-colors ${className}`} title="复制">
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-500" />}
    </button>
  );
}

export function PromptDisplay({ title, english, chinese }: { title: string; english: string; chinese: string }) {
  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-white">{title}</h4>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-white/5">
        <div className="p-5">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">English</span>
            <CopyButton text={english} />
          </div>
          <p className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">{english}</p>
        </div>
        <div className="p-5">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[10px] font-bold text-purple-400 uppercase tracking-wider">中文</span>
            <CopyButton text={chinese} />
          </div>
          <p className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">{chinese}</p>
        </div>
      </div>
    </div>
  );
}

export function ResultSection({ icon, title, children, className = '' }: { icon: React.ReactNode; title: string; children: React.ReactNode; className?: string; key?: any }) {
  return (
    <div className={`bg-white/[0.02] border border-white/5 rounded-2xl p-5 ${className}`}>
      <div className="flex items-center gap-2.5 mb-4">
        {icon}
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      {children}
    </div>
  );
}

export function TagList({ items, color = 'zinc' }: { items: string[]; color?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item, i) => (
        <span key={i} className={`px-3 py-1 bg-${color}-500/10 border border-${color}-500/20 text-${color}-300 rounded-full text-xs`}>
          {item}
        </span>
      ))}
    </div>
  );
}

export function LoadingOverlay({ message = 'AI 正在深度分析中...' }: { message?: string }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center">
        <div className="w-12 h-12 border-2 border-white/10 border-t-blue-500 rounded-full animate-spin mx-auto mb-6" />
        <p className="text-zinc-400 text-sm animate-pulse">{message}</p>
      </div>
    </div>
  );
}
