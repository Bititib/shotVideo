import { memo } from 'react';
import type { CanvasNode, Point } from './model';

// The viewport indicator moves independently; panning need not repaint every node.
export default memo(function CanvasMinimapNodes({nodes, selected, origin, scale}: {
  nodes: CanvasNode[]; selected: string[]; origin: Point; scale: number;
}) {
  const ids = new Set(selected);
  const shapes = new Map<string, string[]>();
  for (const n of nodes) {
    const kind=ids.has(n.id)?'selected':n.kind;
    const group=shapes.get(kind)||[];
    group.push(`M${10+(n.x-origin.x)*scale},${10+(n.y-origin.y)*scale}h${n.width*scale}v${n.height*scale}h${-n.width*scale}Z`);
    shapes.set(kind,group);
  }
  return <g>{[...shapes].map(([kind,paths])=><path key={kind} className={kind} d={paths.join(' ')}/>)}</g>;
});
