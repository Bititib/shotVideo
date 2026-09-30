import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createCanvasWorkspaceStore } from '../server/services/canvasWorkspaceService';
import { createCanvasRequestStore } from '../server/services/canvasRequestStore';
import { newDocument, newNode, parseDocument, type Workspace } from '../client/src/canvas/model';
import { reconcileWorkspace } from '../client/src/canvas/sync';

const workspace = (): Workspace => {
  const doc = newDocument('作品'); doc.nodes.push(newNode('text', { x: 0, y: 0 }, '原文'));
  return { version: 2, activeId: doc.id, projects: [doc], cloudRevision: 0, cloudPending: true };
};
describe('canvas cloud persistence and recovery', () => {
  it('isolates owners and rejects a stale write without replacing cloud content', () => {
    const db = new Database(':memory:');
    try {
      const store = createCanvasWorkspaceStore(db), original = workspace();
      expect(store.put(1, 0, original)).toEqual({ conflict: false, revision: 1 });
      expect(store.get(2).workspace.projects).toHaveLength(0);
      expect(store.put(1, 0, workspace())).toEqual({ conflict: true, revision: 1 });
      expect(store.get(1).workspace.projects[0].id).toBe(original.activeId);
      expect(store.put(2, 0, workspace()).conflict).toBe(false);
    } finally { db.close(); }
  });
  it('keeps offline changes as a separate project when another device has edited', () => {
    const local = workspace(); local.cloudRevision = 1;
    const remote = structuredClone(local); remote.projects[0].nodes[0].text = '另一设备';
    const merged = reconcileWorkspace(local, { revision: 2, workspace: remote });
    expect(merged.projects).toHaveLength(2);
    expect(merged.projects.map(p => p.nodes[0].text)).toEqual(['另一设备', '原文']);
    expect(merged.activeId).toBe(merged.projects[1].id);
    expect(merged.cloudRevision).toBe(2); expect(merged.cloudPending).toBe(true);
  });
  it('refreshes clean local copies and does not fork unchanged documents after parsing', () => {
    const local = workspace(); local.cloudPending = false; local.cloudRevision = 1;
    const remote = structuredClone(local); remote.projects[0].nodes[0].text = '已更新';
    expect(reconcileWorkspace(local, { revision: 2, workspace: remote }).projects[0].nodes[0].text).toBe('已更新');
    const pending = { ...local, cloudPending: true };
    const parsed = { ...local, projects: local.projects.map(parseDocument) };
    expect(reconcileWorkspace(pending, { revision: 2, workspace: parsed }).projects).toHaveLength(1);
  });
  it('rejects unsafe data and duplicate project IDs before writing', () => {
    const db = new Database(':memory:');
    try {
      const store = createCanvasWorkspaceStore(db), original = workspace();
      original.projects[0].nodes[0].src = 'javascript:alert(1)';
      expect(() => store.put(1, 0, original)).toThrow();
      expect(store.get(1).revision).toBe(0);
      const duplicate = workspace(); duplicate.projects.push(duplicate.projects[0]);
      expect(() => store.put(1, 0, duplicate)).toThrow();
    } finally { db.close(); }
  });
  it('claims each request once, rejects changed payloads and records a durable content link', () => {
    const db = new Database(':memory:');
    try {
      const store = createCanvasRequestStore(db);
      expect(store.claim(1, 'request-one', 'hash').fresh).toBe(true);
      expect(store.claim(1, 'request-one', 'hash').fresh).toBe(false);
      expect(store.claim(1, 'request-one', 'other').mismatch).toBe(true);
      expect(store.get(2, 'request-one')).toBeUndefined();
      store.record(1, 'request-one', { contentId: 42 });
      const reopened = createCanvasRequestStore(db);
      expect(reopened.get(1, 'request-one')?.contentId).toBe(42);
      expect(reopened.claim(2, 'request-one', 'hash').fresh).toBe(true);
    } finally { db.close(); }
  });
  it('preserves recoverable request IDs and generation settings through reload', () => {
    const doc = newDocument();
    doc.nodes = [{ ...newNode('image', { x: 0, y: 0 }), settings: { seconds: 5, resolution: '4K' }, job: { status: 'running', requestId: 'canvas-request-123456', message: '' } }];
    expect(parseDocument(doc).nodes[0].job?.status).toBe('running');
    expect(parseDocument(doc).nodes[0].settings?.resolution).toBe('4K');
  });
});
