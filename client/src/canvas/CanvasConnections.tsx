import { memo, useMemo, useLayoutEffect, useRef, useState } from 'react';
import type { CanvasDocument, CanvasNode, View } from './model';

// Panning and editing a prompt do not change any connection geometry.
export default memo(function CanvasConnections({ nodes, edges, view, viewport, visible = true, color = '#9bab91' }: {
  nodes: CanvasNode[]; edges: CanvasDocument['edges']; view: View; viewport: {width:number;height:number}; visible?: boolean; color?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const dense = edges.length > 300 && !canvasFailed;
  const curves = useMemo(() => {
    if (!visible) return [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    return edges.flatMap(edge => {
      const a = byId.get(edge.from), b = byId.get(edge.to);
      if (!a || !b) return [];
      const x = a.x + a.width, y = a.y + a.height / 2, ex = b.x, ey = b.y + b.height / 2;
      const bend = Math.max(80, Math.abs(ex - x) * .5);
      // A Bezier stays inside its control-point bounds, including backwards links.
      return [{id:edge.id,x,y,ex,ey,bend,left:Math.min(x,ex-bend),right:Math.max(x+bend,ex),top:Math.min(y,ey),bottom:Math.max(y,ey),
        d:`M${x},${y} C${x+bend},${y} ${ex-bend},${ey} ${ex},${ey}`}];
    });
  }, [nodes, edges, visible]);
  const left=(-128-view.x)/view.zoom, top=(-128-view.y)/view.zoom;
  const right=(viewport.width+128-view.x)/view.zoom, bottom=(viewport.height+128-view.y)/view.zoom;
  const shown=curves.filter(c=>c.right>=left&&c.left<=right&&c.bottom>=top&&c.top<=bottom);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d');
    if (!ctx) {setCanvasFailed(true);return;}
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.ceil(viewport.width*ratio), height = Math.ceil(viewport.height*ratio);
    if (element.width !== width) element.width = width;
    if (element.height !== height) element.height = height;
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,width,height);
    ctx.setTransform(ratio*view.zoom,0,0,ratio*view.zoom,ratio*view.x,ratio*view.y);
    // Sub-pixel dashes in a zoomed-out dense graph cost far more than their visible detail.
    ctx.strokeStyle=color;ctx.lineWidth=2;ctx.setLineDash(view.zoom < .5 ? [] : [5,4]);
    for (const c of shown) {ctx.beginPath();ctx.moveTo(c.x,c.y);ctx.bezierCurveTo(c.x+c.bend,c.y,c.ex-c.bend,c.ey,c.ex,c.ey);ctx.stroke();}
  }, [curves, view, viewport, visible, color, dense]);
  // Rasterize dense graphs in a viewport-sized layer, never a giant world-sized surface.
  // Small graphs retain SVG and the live connection preview stays SVG in either mode.
  if (dense) return <canvas ref={canvas} aria-label="素材关联线" style={{position:'absolute',pointerEvents:'none',
    left:-view.x/view.zoom,top:-view.y/view.zoom,width:viewport.width/view.zoom,height:viewport.height/view.zoom}}/>;
  return <svg className="studio-connections" aria-label="素材关联线">{shown.map(c=><path key={c.id} d={c.d}/>)}</svg>;
});
