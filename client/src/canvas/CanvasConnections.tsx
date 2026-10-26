import { memo } from 'react';
import type { CanvasDocument, CanvasNode } from './model';

// Panning and editing a prompt do not change any connection geometry.
export default memo(function CanvasConnections({ nodes, edges }: { nodes: CanvasNode[]; edges: CanvasDocument['edges'] }) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return <>{edges.map(edge => {
    const a = byId.get(edge.from), b = byId.get(edge.to);
    if (!a || !b) return null;
    const x = a.x + a.width, y = a.y + a.height / 2, ex = b.x, ey = b.y + b.height / 2;
    const bend = Math.max(80, Math.abs(ex - x) * .5);
    return <path key={edge.id} d={`M${x},${y} C${x + bend},${y} ${ex - bend},${ey} ${ex},${ey}`} />;
  })}</>;
});
