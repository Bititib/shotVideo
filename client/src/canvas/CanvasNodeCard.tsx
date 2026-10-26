import { memo, type MutableRefObject, type PointerEvent, type MouseEvent } from 'react';
import { CheckCircle2, Download, Image as ImageIcon, Loader2, Music2, Type, Video } from 'lucide-react';
import { publicCanvasJobMessage } from '../../../shared/generationMessages';
import type { CanvasNode } from './model';
export type CanvasNodeActions = {
  begin: (event: PointerEvent, ids?: string[], resize?: boolean) => void;
  beginLink: (event: PointerEvent, node: CanvasNode, side: 'in' | 'out') => void;
  select: (id: string, open: boolean) => void;
  context: (event: MouseEvent, node: CanvasNode) => void;
  connectClick: (event: MouseEvent, id: string) => void;
  startEdit: () => void;
  finishEdit: () => void;
  textPointerDown: (event: PointerEvent, id: string) => void;
  editNode: (id: string, patch: Partial<CanvasNode>) => void;
  pick: (id: string) => void;
  downloadNode: (node: CanvasNode) => Promise<void>;
};
type Props = { node: CanvasNode; isSelected: boolean; incomingReady: boolean; outgoingReady: boolean; linkState: '' | 'valid' | 'invalid'; actions: MutableRefObject<CanvasNodeActions> };
const playable = (src: string) => src.startsWith('data:') || src.startsWith('blob:') ? src : '/api/video/play?url=' + encodeURIComponent(src);
// Events read the current controller; viewport/draft updates do not repaint unchanged media cards.
export default memo(function CanvasNodeCard({ node, isSelected, incomingReady, outgoingReady, linkState, actions }: Props) {
  const Icon = node.kind === 'image' ? ImageIcon : node.kind === 'video' ? Video : node.kind === 'audio' ? Music2 : Type;
  return <article className={`studio-node kind-${node.kind} ${isSelected ? 'is-selected' : ''}`}
    style={{ left: node.x, top: node.y, width: node.width, height: node.height }} aria-label={node.title}
    onPointerDown={event => actions.current.begin(event, [node.id])}
    onDoubleClick={event => {
      const target = event.target as HTMLElement;
      if (node.kind === 'text' || target.closest('input,textarea,select,video,audio,button:not(.studio-node-empty)')) return;
      event.preventDefault(); event.stopPropagation();
      actions.current.select(node.id, true);
    }}
    onContextMenu={event => actions.current.context(event, node)}>
    <button className={`studio-port port-in ${incomingReady ? 'ready' : ''} ${linkState ? 'link-' + linkState : ''}`} aria-label={`连接到 ${node.title}`} title="按住拖拽连接参考素材，也可点击连线" onPointerDown={e => actions.current.beginLink(e, node, 'in')} onClick={e => actions.current.connectClick(e, node.id)} />
    <header><span className="studio-node-icon"><Icon size={14} /></span><input aria-label="素材名称" value={node.title} maxLength={120} onPointerDown={e => e.stopPropagation()} onFocus={() => { actions.current.startEdit(); actions.current.select(node.id, false); }} onChange={e => actions.current.editNode(node.id, { title: e.target.value })} onBlur={() => actions.current.finishEdit()} /><span className="studio-node-grip">⠿</span></header>
    {node.kind === 'text' ? <textarea aria-label="卡片文字" placeholder="写下想法、提示词或分镜…" value={node.text} maxLength={50000} onPointerDown={e => actions.current.textPointerDown(e, node.id)} onFocus={() => actions.current.startEdit()} onChange={e => actions.current.editNode(node.id, { text: e.target.value })} onBlur={() => actions.current.finishEdit()} />
      : node.src ? <div className="studio-media">{node.kind === 'image' ? <img src={node.src} alt={node.title} draggable={false} loading="lazy" /> : node.kind === 'audio' ? <audio src={node.src} controls onPointerDown={e => e.stopPropagation()} /> : <video src={playable(node.src)} controls preload="metadata" onPointerDown={e => e.stopPropagation()} />}</div>
        : <button className="studio-node-empty" onPointerDown={e => actions.current.begin(e, [node.id])} onClick={e => { if (e.detail === 0) { actions.current.select(node.id, false); } }}>{node.job?.status === 'running' ? node.job.message === '视频已生成，正在等待结果交付' ? <CheckCircle2 size={28} /> : <Loader2 size={28} className="studio-spin" /> : <Icon size={30} />}<strong>{node.job ? node.job.status === 'running' ? (node.job.message === '视频已生成，正在等待结果交付' ? '已生成，等待交付' : node.job.message === '视频已生成，正在保存到本站存储' ? '正在保存结果' : '正在创作中') : node.job.status === 'error' ? '生成未完成' : '请核实任务结果' : node.kind === 'image' ? '下一张好作品，从这里开始' : node.kind === 'audio' ? '让文字拥有声音' : '让画面动起来'}</strong><span>{publicCanvasJobMessage(node.job) || '连接参考素材，双击节点开始创作'}</span></button>}
    {node.job && <div className="studio-node-job" role="status" title={publicCanvasJobMessage(node.job)}><span>{publicCanvasJobMessage(node.job)}</span>{node.job.status === 'running' && <progress aria-label="生成进度" max={100} value={node.job.progress == null ? undefined : Math.min(100, Math.max(0,node.job.progress))}/>}</div>}
    {node.kind !== 'text' && <button className="studio-node-pick" disabled={node.job?.status === 'running'} onPointerDown={e=>e.stopPropagation()} onClick={()=>actions.current.pick(node.id)}>从素材库选择{node.src ? ' / 替换' : ' / 上传'}</button>}
    <footer className={node.src && node.kind !== 'text' ? 'has-download' : undefined}><span>{node.kind === 'text' ? `${node.text.length} 字` : node.src ? '素材已就绪' : node.job?.progress != null ? `${Math.round(node.job.progress)}%` : '等待创作'}</span>{node.src && node.kind !== 'text'
      ? <button className="studio-node-download" aria-label={`下载${node.kind === 'video' ? '视频' : node.kind === 'image' ? '图片' : '音频'} ${node.title}`} title="下载当前素材" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void actions.current.downloadNode(node); }}><Download size={14}/><span>下载{node.kind === 'video' ? '视频' : node.kind === 'image' ? '图片' : '音频'}</span></button>
      : node.job?.status === 'done' ? <CheckCircle2 size={12} /> : <span>{node.ratio || (node.kind === 'text' ? 'NOTE' : 'CREATIVE')}</span>}</footer>
    <button className={`studio-port port-out ${outgoingReady ? 'ready' : ''} ${linkState ? 'link-' + linkState : ''}`} aria-label={`从 ${node.title} 连接`} title="按住拖拽连接到下一步，也可点击连线" onPointerDown={e => actions.current.beginLink(e, node, 'out')} onClick={e => actions.current.connectClick(e, node.id)} />
    {isSelected && <button className="studio-resize" aria-label="调整素材大小" title="拖动调整大小" onPointerDown={e => actions.current.begin(e, [node.id], true)} />}
  </article>;
});
