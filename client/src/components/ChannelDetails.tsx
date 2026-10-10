import type { ReactNode } from 'react';
import { Activity, ArrowRight, CircleCheck, CircleX, Layers3, Loader2, Pencil, Radio, RefreshCw, Zap } from 'lucide-react';

export type ChannelFeedback = { channelId: number; kind: 'success' | 'error'; message: string };

export default function ChannelDetails({ channel, tab, onTabChange, busy, testing, syncing, feedback, onEdit, onTest, onSync, children }: {
  channel: any; tab: string; onTabChange: (tab: string) => void;
  busy: boolean; testing: boolean; syncing: boolean; feedback: ChannelFeedback | null;
  onEdit: () => void; onTest: () => void; onSync: () => void; children: ReactNode;
}) {
  const modelCount = channel.supportedModels?.length || 0;
  const provider = channel.type === 'zongheng' ? '纵横科技' : channel.type === 'hmstudio' ? 'HM Studio' : channel.type;
  const currentFeedback = feedback?.channelId === channel.id ? feedback : null;
  return (
    <div className="channel-details">
      <section className="channel-details-overview" aria-label="渠道概览">
        <div className="channel-details-heading">
          <div className="channel-details-icon"><Radio aria-hidden="true" /></div>
          <div><p className="channel-details-eyebrow">渠道概览 · {provider}</p><h3>{channel.name}</h3></div>
          <span className={'channel-details-status ' + (channel.status ? 'is-active' : '')}><i />{channel.status ? '已启用' : '已停用'}</span>
        </div>
        <p className="channel-details-address">{channel.baseUrl}</p>
        <div className="channel-details-metrics">
          <div><span><Layers3 aria-hidden="true" />关联模型</span><strong>{modelCount}<small>个</small></strong></div>
          <div><span><Activity aria-hidden="true" />运行中</span><strong>{channel.concurrencyRunning || 0}<small>个任务</small></strong></div>
          <div><span>排队中</span><strong>{channel.concurrencyQueued || 0}<small>个任务</small></strong></div>
        </div>
        <div className="channel-details-actions">
          <button type="button" className="channel-details-primary" disabled={busy} onClick={onSync}>
            {syncing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}{syncing ? '正在同步…' : '同步模型'}
          </button>
          <button type="button" disabled={busy} onClick={onTest}>{testing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Zap aria-hidden="true" />}{testing ? '正在测试…' : '测试连接'}</button>
          <button type="button" disabled={busy} onClick={onEdit}><Pencil aria-hidden="true" />编辑配置</button>
        </div>
      </section>
      {currentFeedback && <div className={'channel-details-feedback ' + (currentFeedback.kind === 'error' ? 'is-error' : '')} role={currentFeedback.kind === 'error' ? 'alert' : 'status'}>
        {currentFeedback.kind === 'error' ? <CircleX aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}<span>{currentFeedback.message}</span>
      </div>}
      {modelCount === 0 && <div className="channel-details-empty">
        <div><strong>还没有关联模型</strong><p>先同步渠道模型，再配置价格和启用状态。</p></div>
        <button type="button" disabled={busy} onClick={onSync}>立即同步<ArrowRight aria-hidden="true" /></button>
      </div>}
      <nav className="channel-details-tabs" aria-label="渠道详情内容">
        <button type="button" aria-pressed={tab === 'models'} disabled={busy} onClick={() => onTabChange('models')}>关联模型与价格<span>{modelCount}</span></button>
        <button type="button" aria-pressed={tab === 'config'} disabled={busy} onClick={() => onTabChange('config')}>配置与运行状态</button>
      </nav>
      {tab === 'models' ? <div className="channel-details-models">{children}</div> : <div className="channel-details-config">
        <section><h3>连接配置</h3><dl>
          <div><dt>渠道类型</dt><dd>{provider}</dd></div>
          <div><dt>接口地址</dt><dd className="channel-details-url">{channel.baseUrl}</dd></div>
          <div><dt>API Key</dt><dd>{channel.apiKey || channel.apiKeyCount ? '已配置' : '未配置'}</dd></div>
        </dl></section>
        <section><h3>调度与运行</h3><dl>
          <div><dt>优先级</dt><dd>{channel.priority ?? 0}</dd></div>
          <div><dt>权重</dt><dd>{channel.weight ?? 1}</dd></div>
          <div><dt>超时时间</dt><dd>{Math.round((channel.timeout || 120000) / 1000)} 秒</dd></div>
          <div><dt>重试次数</dt><dd>{channel.maxRetries ?? 0}</dd></div>
        </dl></section>
        <section className="channel-details-last-test"><h3>最近连接测试</h3><p>{channel.lastTestResult || '尚未测试，点击上方“测试连接”检查渠道。'}</p></section>
      </div>}
    </div>
  );
}
