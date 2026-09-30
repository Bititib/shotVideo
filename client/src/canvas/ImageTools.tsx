import { useEffect, useRef, useState } from 'react';
import { referenceDataUrl } from './generation';
import type { CanvasNode } from './model';

export function cropBounds(width: number, height: number, ratio: number) {
  const w = ratio > 0 ? Math.min(width, height * ratio) : width;
  const h = ratio > 0 ? w / ratio : height;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}
export default function ImageTools({ node, onClose, onApply }: { node: CanvasNode; onClose: () => void; onApply: (src: string) => void }) {
  const [ratio, setRatio] = useState(0), [turn, setTurn] = useState(0), [flip, setFlip] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const apply = async () => {
    setBusy(true); setError('');
    try {
      const image = new Image(); image.src = await referenceDataUrl(node.src!); await image.decode();
      if (!mounted.current) return;
      const rotated = document.createElement('canvas'); const odd = turn % 2 !== 0;
      const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.round(image.naturalWidth * scale), height = Math.round(image.naturalHeight * scale);
      rotated.width = odd ? height : width; rotated.height = odd ? width : height;
      const ctx = rotated.getContext('2d'); if (!ctx) throw new Error('当前浏览器不支持图像处理');
      ctx.translate(rotated.width / 2, rotated.height / 2); ctx.rotate(turn * Math.PI / 2); ctx.scale(flip ? -1 : 1, 1); ctx.drawImage(image, -width / 2, -height / 2, width, height);
      const crop = cropBounds(rotated.width, rotated.height, ratio), output = document.createElement('canvas');
      output.width = Math.max(1, Math.round(crop.width)); output.height = Math.max(1, Math.round(crop.height));
      const out = output.getContext('2d'); if (!out) throw new Error('当前浏览器不支持图像处理');
      out.drawImage(rotated, crop.x, crop.y, crop.width, crop.height, 0, 0, output.width, output.height);
      onApply(output.toDataURL('image/png'));
    } catch (e: any) { if (mounted.current) setError(e.message || '处理失败'); } finally { if (mounted.current) setBusy(false); }
  };
  return <section className="studio-image-tools" role="dialog" aria-modal="true" aria-label="图片裁剪与旋转"><header><h2>图片裁剪与旋转</h2><button disabled={busy} onClick={onClose} aria-label="关闭图片工具">✕</button></header><div className="studio-crop-preview"><img src={node.src} alt="原图预览" style={{ transform: `rotate(${turn * 90}deg) scaleX(${flip ? -1 : 1})` }}/></div><p>预览旋转方向；裁剪按所选比例居中截取，生成新节点保留原图。</p><div className="studio-image-tool-controls"><label>裁剪比例<select value={ratio} onChange={e => setRatio(Number(e.target.value))}><option value={0}>保留原比例</option><option value={1}>1:1</option><option value={16 / 9}>16:9</option><option value={9 / 16}>9:16</option><option value={4 / 3}>4:3</option></select></label><button onClick={() => setTurn(t => (t + 1) % 4)}>旋转 90°</button><button aria-pressed={flip} onClick={() => setFlip(f => !f)}>水平翻转</button></div>{error && <p role="alert">{error}</p>}<button className="studio-primary-action" disabled={busy} onClick={() => void apply()}>{busy ? '正在处理…' : '生成处理后的图片'}</button></section>;
}
