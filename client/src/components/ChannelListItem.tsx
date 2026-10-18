import { useEffect, useRef } from 'react';
import { KeyRound, Loader2, MoreHorizontal, Pencil, Radio, RefreshCw, Trash2, Zap } from 'lucide-react';

export default function ChannelListItem({ channel: ch, syncing, testing, pending, onOpen, onSync, onEdit, onToggle, onTest, onAddKey, onDelete }: {
  channel: any; syncing: number | null; testing: number | null; pending: boolean;
  onOpen: () => void; onSync: () => void; onEdit: () => void; onToggle: () => void;
  onTest: () => void; onAddKey: () => void; onDelete: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => { if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false; };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  return <article className={`channel-list-row${ch.status ? '' : ' is-disabled'}`}>
    <div className="channel-list-identity">
      <span className="channel-list-icon" aria-hidden="true"><Radio /></span>
      <div><button type="button" className="channel-list-name" aria-label={`查看${ch.name}详情`} onClick={onOpen}>{ch.name}</button>
        <div className="channel-list-meta"><span>{ch.type === 'mj' ? 'MJ' : ch.type === 'async-video' ? 'Vx-乐2.0fast' : ch.type === 'hmstudio' ? 'HM Studio' : ch.type === 'openai' ? 'OpenAI' : ch.type === 'blobdraw' ? 'BlobDraw' : ch.type}</span><span>#{ch.id}</span></div>
      </div>
    </div>
    <button type="button" role="switch" aria-label={`${ch.name}渠道状态`} aria-checked={Boolean(ch.status)} disabled={pending} onClick={onToggle} className="channel-list-status">
      <span className="channel-list-switch" aria-hidden="true"><i /></span><span>{ch.status ? '已启用' : '已停用'}</span>
    </button>
    <button type="button" className="channel-list-models" aria-label={`查看${ch.name}的关联模型`} onClick={onOpen}><strong>{ch.supportedModels?.length || 0}</strong><span>个模型</span></button>
    <div className="channel-list-runtime"><span><i className={Number(ch.concurrencyRunning) > 0 ? 'is-busy' : ''} /><strong>{ch.concurrencyRunning || 0}</strong> 运行</span><span><strong>{ch.concurrencyQueued || 0}</strong> 排队</span></div>
    <div className="channel-list-actions">
      <button type="button" className="channel-list-sync" disabled={syncing !== null || testing !== null} onClick={onSync}><RefreshCw className={syncing === ch.id ? 'animate-spin' : ''} aria-hidden="true" />{syncing === ch.id ? '同步中…' : '同步模型'}</button>
      <button type="button" className="channel-list-action" aria-label={`编辑${ch.name}`} title="编辑渠道" onClick={onEdit}><Pencil aria-hidden="true" /></button>
      <details ref={menu} className="channel-list-more" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
        <summary aria-label={`${ch.name}更多操作`} title="更多操作"><MoreHorizontal aria-hidden="true" /></summary>
        <div className="channel-list-menu" onClick={() => { if (menu.current) menu.current.open = false; }}>
          <button type="button" disabled={testing !== null || syncing !== null} onClick={onTest}>{testing === ch.id ? <Loader2 className="animate-spin" /> : <Zap />}测试连接</button>
          {ch.type === 'hmstudio' && <button type="button" onClick={onAddKey}><KeyRound />添加 Key</button>}
          <button type="button" className="is-danger" disabled={pending || syncing !== null || testing !== null} onClick={onDelete}><Trash2 />删除渠道</button>
        </div>
      </details>
    </div>
  </article>;
}
