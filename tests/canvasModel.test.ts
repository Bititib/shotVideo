import { describe, expect, it } from 'vitest';
import { arrange, bounds, canConnect, checkpoint, duplicateSelection, fitView, intersects, newDocument, newNode, parseDocument, screenToWorld, stepHistory, templateNodes, zoomAround } from '../client/src/canvas/model';

describe('canvas editing invariants', () => {
  it('keeps the world point under the cursor stable even at zoom limits', () => {
    const view = { x: -400, y: 180, zoom: .6 }, cursor = { x: 413, y: 208 };
    for (const factor of [.0001, .8, 1.2, 100]) {
      const before = screenToWorld(cursor, view), after = screenToWorld(cursor, zoomAround(view, cursor, factor));
      expect(after.x).toBeCloseTo(before.x); expect(after.y).toBeCloseTo(before.y);
    }
  });
  it('fits negative-coordinate assets and preserves their complete bounds', () => {
    const nodes = [newNode('image', { x: -600, y: -230 }), newNode('text', { x: 380, y: 550 })];
    const view = fitView(nodes, 1200, 800), b = bounds(nodes);
    expect(b.x * view.zoom + view.x).toBeGreaterThanOrEqual(79);
    expect((b.x + b.width) * view.zoom + view.x).toBeLessThanOrEqual(1121);
    expect((b.y + b.height) * view.zoom + view.y).toBeLessThanOrEqual(721);
  });
  it('supports backwards box selection', () => {
    const node = newNode('text', { x: 10, y: 20 });
    expect(intersects(node, { x: 320, y: 260 }, { x: 0, y: 0 })).toBe(true);
    expect(intersects(node, { x: -100, y: -100 }, { x: -10, y: -10 })).toBe(false);
  });
  it('rejects cyclic, duplicate and self references without rejecting valid branches', () => {
    const edges = [{ id: '1', from: 'a', to: 'b' }, { id: '2', from: 'b', to: 'c' }];
    expect(canConnect(edges, 'c', 'a')).toBe(false);
    expect(canConnect(edges, 'a', 'b')).toBe(false);
    expect(canConnect(edges, 'b', 'b')).toBe(false);
    expect(canConnect(edges, 'a', 'c')).toBe(true);
  });
  it('duplicates internal references and groups without linking copies to originals', () => {
    const a = { ...newNode('text', { x: 0, y: 0 }), group: 'original' }, b = { ...newNode('image', { x: 400, y: 0 }), group: 'original' }, c = newNode('image', { x: 900, y: 0 });
    const result = duplicateSelection({ nodes: [a, b, c], edges: [{ id: '1', from: a.id, to: b.id }, { id: '2', from: b.id, to: c.id }] }, [a.id, b.id]);
    const copies = result.snapshot.nodes.slice(3);
    expect(result.snapshot.edges).toHaveLength(3);
    expect(result.snapshot.edges[2]).toMatchObject({ from: copies[0].id, to: copies[1].id });
    expect(copies[0].group).toBe(copies[1].group); expect(copies[0].group).not.toBe('original');
    expect(a.x).toBe(0);
  });
  it('arranges selected cards without overlap or moving unselected content', () => {
    const nodes = [newNode('text', { x: 0, y: 0 }), { ...newNode('image', { x: 10, y: 10 }), width: 550 }, newNode('text', { x: -800, y: 40 })];
    const arranged = arrange(nodes, nodes.slice(0, 2).map(n => n.id));
    expect(arranged[1].x).toBeGreaterThan(arranged[0].x + arranged[0].width);
    expect(arranged[2]).toBe(nodes[2]);
  });
  it('undoes and redoes a whole edit and clears redo after branching', () => {
    const empty = { nodes: [], edges: [] }, content = { nodes: [newNode('text', { x: 0, y: 0 })], edges: [] };
    const history = checkpoint({ past: [], future: [] }, empty);
    const undone = stepHistory(history, content, 'undo'); expect(undone.snapshot).toEqual(empty);
    expect(stepHistory(undone.history, empty, 'redo').snapshot).toEqual(content);
    expect(checkpoint(undone.history, empty).future).toHaveLength(0);
  });
});

describe('canvas backup compatibility', () => {
  it('migrates the original canvas without losing text, images or positions', () => {
    const doc = parseDocument({ items: [{ id: 'old', x: -120, y: 37, text: '旧照片', image: 'data:image/png;base64,iVBORw==' }], view: { x: 80, y: -30, zoom: .8 } });
    expect(doc.nodes[0]).toMatchObject({ id: 'old', kind: 'image', x: -120, y: 37, text: '旧照片', src: 'data:image/png;base64,iVBORw==' });
    expect(doc.view).toEqual({ x: 80, y: -30, zoom: .8 });
  });
  it('rejects malformed coordinates, duplicate IDs and executable media URLs', () => {
    const node = newNode('image', { x: 0, y: 0 });
    expect(() => parseDocument({ nodes: [{ ...node, x: NaN }] })).toThrow();
    expect(() => parseDocument({ nodes: [node, node] })).toThrow();
    expect(() => parseDocument({ nodes: [{ ...node, src: 'javascript:alert(1)' }] })).toThrow();
  });
  it('recovers tracked jobs but marks untracked submissions for manual verification', () => {
    const a = { ...newNode('image', { x: 0, y: 0 }), job: { status: 'running', message: '', contentId: 32 } };
    const b = { ...a, id: 'untracked', job: { status: 'running', message: '' } };
    const restored = parseDocument({ nodes: [a, b] });
    expect(restored.nodes[0].job?.status).toBe('running'); expect(restored.nodes[1].job?.status).toBe('interrupted');
  });
  it('roundtrips templates and prunes dangling references', () => {
    const template = templateNodes('story', { x: 30, y: 40 });
    const doc = parseDocument(JSON.parse(JSON.stringify({ ...newDocument(), ...template })));
    expect(doc.nodes).toHaveLength(4); expect(doc.edges).toHaveLength(1);
    expect(parseDocument({ ...doc, nodes: doc.nodes.slice(0, 1) }).edges).toHaveLength(0);
  });
});


it('preserves asset folders across serialization without losing existing nodes', () => {
  const node={...newNode('image',{x:0,y:0}),assetFolder:'角色',src:'/hero.png'};
  const project={...newDocument(),assetFolders:['自定义素材','自定义素材'],nodes:[node]};
  const restored=parseDocument(JSON.parse(JSON.stringify(project)));
  expect(restored.assetFolders).toEqual(['自定义素材']);
  expect(restored.nodes[0]).toMatchObject({id:node.id,assetFolder:'角色',src:'/hero.png'});
  expect(parseDocument(newDocument()).assetFolders).toBeUndefined();
});
