import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { KMAI_MJ_MODEL_ID } from '../../../shared/kmai';
import type { CanvasNode, CanvasVersion, View } from './model';

export function latestMjImages(node: CanvasNode): CanvasVersion[] {
  if (node.kind !== 'image' || node.job?.status === 'running') return [];
  const versions = node.versions || [], last = versions.at(-1);
  if (!last || (last.model || node.model) !== KMAI_MJ_MODEL_ID) return [];
  const batch = last.requestId ? versions.filter(version => version.requestId === last.requestId)
    : last.contentId ? versions.filter(version => version.contentId === last.contentId) : versions.slice(-4);
  return batch.length === 4 ? batch : [];
}

export default function MjImagePicker({ node, versions, view, viewport, onSelect }: {
  key?: string; node: CanvasNode; versions: CanvasVersion[]; view: View; viewport: { width: number; height: number };
  onSelect: (version: CanvasVersion) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const width = Math.min(352, Math.max(0, viewport.width - 24)), height = 124;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  const left = clamp(view.x + (node.x + node.width / 2) * view.zoom - width / 2, 12, viewport.width - width - 12);
  const top = clamp(view.y + node.y * view.zoom - height - 12, 12, viewport.height - height - 12);
  const side = viewport.width - left - width >= 294 ? 'right' : left >= 294 ? 'left' : undefined;
  const above = top >= 240 || top > viewport.height - top - height;
  const previewHeight = Math.min(300, Math.max(80, (side ? viewport.height : above ? top : viewport.height - top - height) - 24));
  const previewWidth = Math.min(270, previewHeight - 24, viewport.width - 24);
  const previewLeft = side ? side === 'right' ? left + width + 12 : left - previewWidth - 12
    : clamp(left + 10 + (width - 20) / 4 * ((hovered || 0) + .5) - previewWidth / 2, 12, viewport.width - previewWidth - 12);
  const previewTop = side ? clamp(top - (previewHeight - height) / 2, 12, viewport.height - previewHeight - 12)
    : above ? top - previewHeight - 12 : top + height + 12;
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % versions.length;
    else if (event.key === 'ArrowLeft') next = (index + versions.length - 1) % versions.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = versions.length - 1;
    else if (event.key === 'Escape') { setHovered(null); return; }
    else return;
    event.preventDefault();
    (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
    setHovered(next);
  };
  return <>
    <section className="studio-mj-picker" aria-label="MJ 四张候选图片" data-canvas-ui
      style={{ left, top, width }} onPointerDown={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()} onKeyDown={event => { if (['ArrowLeft','ArrowRight','Home','End','Escape'].includes(event.key)) event.stopPropagation(); }}>
      <header><strong>本次生成 · 4 张</strong><span>点击设为当前版本</span></header>
      <div className="studio-mj-options" role="group" aria-label="选择当前图片">
        {versions.map((version, index) => <button key={version.id} type="button"
          className={'studio-mj-option' + (node.src === version.src ? ' is-current' : '')}
          aria-label={`将第 ${index + 1} 张图片设为当前版本`} aria-pressed={node.src === version.src}
          onPointerEnter={() => setHovered(index)} onPointerLeave={() => setHovered(null)}
          onFocus={() => setHovered(index)} onBlur={() => setHovered(null)}
          onKeyDown={event => moveFocus(event, index)} onClick={() => onSelect(version)}>
          <img src={version.src} alt={`MJ 候选图片 ${index + 1}`} draggable={false} />
          <span className="studio-mj-number">{index + 1}</span>
          {node.src === version.src && <span className="studio-mj-current"><Check size={12} aria-hidden="true" />当前</span>}
        </button>)}
      </div>
    </section>
    {hovered !== null && versions[hovered] && <figure className="studio-mj-hover-preview" data-canvas-ui
      style={{ left: previewLeft, top: previewTop, width: previewWidth, height: previewHeight }}>
      <img src={versions[hovered].src} alt={`第 ${hovered + 1} 张图片放大预览`} draggable={false} />
      <figcaption>第 {hovered + 1} 张<span>{node.src === versions[hovered].src ? '当前版本' : '点击缩略图选用'}</span></figcaption>
    </figure>}
  </>;
}
