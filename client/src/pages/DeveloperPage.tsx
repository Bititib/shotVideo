import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Copy, FileText, KeyRound, Layers3 } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import './DeveloperPage.css';

const DocsPage = lazy(() => import('./DocsPage'));
const ApiModelsPage = lazy(() => import('./ApiModelsPage'));
const tabs = [{ id: 'docs', label: '接口文档', icon: FileText }, { id: 'models', label: 'API 模型', icon: Layers3 }] as const;

export default function DeveloperPage() {
  const [params, setParams] = useSearchParams();
  const activeTab = params.get('tab') === 'models' ? 'models' : 'docs';
  const { isAuthenticated, openLoginModal } = useAuthStore();
  const [modelsVisited, setModelsVisited] = useState(activeTab === 'models');
  const [copyStatus, setCopyStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (activeTab === 'models') setModelsVisited(true); }, [activeTab]);
  const baseUrl = `${window.location.origin}/v1`;
  function selectTab(id: string) {
    const next = new URLSearchParams(params);
    next.set('tab', id);
    setParams(next);
  }
  function navigateTabs(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex(tab => tab.id === activeTab);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(tabs[next].id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  async function copyBaseUrl() {
    try { await navigator.clipboard.writeText(baseUrl); setCopyStatus('已复制接口地址'); }
    catch { setCopyStatus('复制失败，请手动复制接口地址'); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyStatus(''), 2500);
  }
  return <div className="developer-page">
    <header className="developer-heading"><div><p className="developer-eyebrow">DEVELOPER CENTER</p><h1>开发者中心</h1><p>浏览接口文档与可用模型，快速接入 API。</p></div>
      <div className="developer-base"><span>BASE URL</span><div><code>{baseUrl}</code><button aria-label="复制接口地址" onClick={copyBaseUrl}>{copyStatus === '已复制接口地址' ? <Check size={16} /> : <Copy size={16} />}</button></div><small role="status" aria-live="polite">{copyStatus}</small></div>
    </header>
    <div className="developer-tabs" role="tablist" aria-label="开发者中心内容" onKeyDown={navigateTabs}>{tabs.map(tab => <button key={tab.id} role="tab" id={`developer-tab-${tab.id}`}
      aria-selected={activeTab === tab.id} aria-controls={`developer-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => selectTab(tab.id)}><tab.icon size={17} />{tab.label}</button>)}</div>
    <section id="developer-panel-docs" role="tabpanel" aria-labelledby="developer-tab-docs" hidden={activeTab !== 'docs'} tabIndex={0}>
      <Suspense fallback={<p className="developer-loading" role="status">正在加载接口文档…</p>}><DocsPage embedded /></Suspense>
    </section>
    <section id="developer-panel-models" role="tabpanel" aria-labelledby="developer-tab-models" hidden={activeTab !== 'models'} tabIndex={0}>
      {!isAuthenticated ? <div className="developer-login"><KeyRound size={28} /><h2>登录后查看 API 模型</h2><p>选择自己的 API Key，查看对应模型、价格和调用示例。</p><button onClick={openLoginModal}>登录 / 注册</button></div>
        : (modelsVisited || activeTab === 'models') && <Suspense fallback={<p className="developer-loading" role="status">正在加载模型列表…</p>}><ApiModelsPage embedded /></Suspense>}
    </section>
  </div>;
}
