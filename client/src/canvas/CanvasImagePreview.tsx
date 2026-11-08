import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';

type View = { scale: number; x: number; y: number };
type Point = { x: number; y: number };

/** Original bytes are loaded only when opened; zoom never changes the canvas document. */
export default function CanvasImagePreview({ src, title, onClose }: { key?: string; src: string; title: string; onClose: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const natural = useRef({ width: 0, height: 0 });
  const fitted = useRef(1);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const current = useRef(view);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const update = (next: View) => {
    const box = stage.current?.getBoundingClientRect();
    const maxX = Math.max(0, (natural.current.width * next.scale - (box?.width || 0)) / 2);
    const maxY = Math.max(0, (natural.current.height * next.scale - (box?.height || 0)) / 2);
    current.current = { ...next, x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
    setView(current.current);
  };
  const fit = () => {
    const box = stage.current?.getBoundingClientRect(), size = natural.current;
    if (!box?.width || !box.height || !size.width || !size.height) return;
    fitted.current = Math.min(1, box.width / size.width, box.height / size.height);
    update({ scale: fitted.current, x: 0, y: 0 });
  };
  const zoom = (scale: number, anchor: Point = { x: 0, y: 0 }) => {
    const old = current.current;
    const next = Math.max(Math.min(fitted.current, 0.1), Math.min(8, scale));
    update({ scale: next, x: anchor.x - (anchor.x - old.x) * next / old.scale, y: anchor.y - (anchor.y - old.y) * next / old.scale });
  };
  useEffect(() => {
    const element = stage.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (!natural.current.width) return;
      const box = element.getBoundingClientRect();
      zoom(current.current.scale * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003),
        { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    const observer = new ResizeObserver(fit); observer.observe(element);
    return () => { element.removeEventListener('wheel', wheel); observer.disconnect(); };
  }, []);

  return <div className="studio-overlay studio-image-viewer" role="dialog" aria-modal="true" aria-label="图片放大预览" onPointerDown={e => e.stopPropagation()}>
    <header><span title={title}>{title}</span><button onClick={onClose} aria-label="关闭预览"><X size={22}/></button></header>
    <div ref={stage} className="studio-image-viewport" aria-label="图片查看区域"
      onDoubleClick={() => { if (loaded) current.current.scale === fitted.current ? zoom(Math.max(1, fitted.current * 2)) : fit(); }}
      onPointerDown={event => {
        if (event.button !== 0 || !loaded) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }}
      onPointerMove={event => {
        const previous = pointers.current.get(event.pointerId); if (!previous) return;
        const point = { x: event.clientX, y: event.clientY };
        const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
        if (other) {
          const before = Math.hypot(previous.x - other.x, previous.y - other.y);
          const after = Math.hypot(point.x - other.x, point.y - other.y);
          if (before > 0) zoom(current.current.scale * after / before);
        } else update({ ...current.current, x: current.current.x + point.x - previous.x, y: current.current.y + point.y - previous.y });
        pointers.current.set(event.pointerId, point);
      }}
      onPointerUp={e => pointers.current.delete(e.pointerId)} onPointerCancel={e => pointers.current.delete(e.pointerId)} onLostPointerCapture={e => pointers.current.delete(e.pointerId)}>
      {!loaded && !failed && <span role="status">正在加载原图…</span>}
      {failed && <span role="alert">原图加载失败，请关闭后重试。</span>}
      <img src={src} alt={title} draggable={false} style={{ visibility: loaded ? 'visible' : 'hidden', width: natural.current.width * view.scale || undefined, height: natural.current.height * view.scale || undefined, transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px)` }}
        onLoad={event => { natural.current = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; setLoaded(true); setFailed(false); fit(); }}
        onError={() => { setFailed(true); setLoaded(false); }}/>
    </div>
    <footer><div role="toolbar" aria-label="图片缩放"><button aria-label="缩小图片" disabled={!loaded || view.scale <= Math.min(fitted.current, 0.1)} onClick={() => zoom(view.scale / 1.25)}><Minus size={18}/></button><output aria-label="图片缩放比例">{loaded ? `${Math.round(view.scale * 100)}%` : '—'}</output><button aria-label="放大图片" disabled={!loaded || view.scale >= 8} onClick={() => zoom(view.scale * 1.25)}><Plus size={18}/></button><button disabled={!loaded} onClick={fit}>适应屏幕</button><button disabled={!loaded} onClick={() => zoom(1)}>原始尺寸</button></div><span>滚轮或双指缩放 · 拖动查看 · Esc 关闭</span></footer>
  </div>;
}
