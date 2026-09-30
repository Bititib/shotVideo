import type Database from 'better-sqlite3';
import { parseDocument, type Workspace } from '../../shared/canvasModel.js';

export function createCanvasWorkspaceStore(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS canvas_workspaces (
    user_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  const get = (owner: number): { revision: number; workspace: Workspace } => {
    const row = database.prepare('SELECT revision, document FROM canvas_workspaces WHERE user_id = ?').get(owner) as { revision: number; document: string } | undefined;
    return row ? { revision: row.revision, workspace: JSON.parse(row.document) } : { revision: 0, workspace: { version: 2, activeId: '', projects: [] } };
  };
  const put = database.transaction((owner: number, revision: number, raw: Workspace) => {
    if (!Number.isSafeInteger(revision) || revision < 0 || !raw || !Array.isArray(raw.projects) || !raw.projects.length || raw.projects.length > 100) throw new Error('画布目录无效，最多保存 100 个项目');
    if (Buffer.byteLength(JSON.stringify(raw)) > 80 * 1024 * 1024) throw new Error('云端空间超过 80 MB，请导出备份并精简素材后重试');
    const ids = new Set<string>();
    const projects = raw.projects.map(p => {
      if (!p || typeof p.id !== 'string' || p.id.length > 160 || ids.has(p.id) || !Array.isArray(p.nodes) || p.nodes.length > 1000 || !Array.isArray(p.edges) || p.edges.length > 5000) throw new Error('项目格式无效或素材过多');
      ids.add(p.id); return parseDocument(p);
    });
    const current = get(owner);
    if (current.revision !== revision) return { conflict: true as const, revision: current.revision };
    const workspace: Workspace = { version: 2, activeId: ids.has(raw.activeId) ? raw.activeId : projects[0].id, projects };
    database.prepare(`INSERT INTO canvas_workspaces (user_id, revision, document, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision, document=excluded.document, updated_at=excluded.updated_at`).run(owner, revision + 1, JSON.stringify(workspace), Date.now());
    return { conflict: false as const, revision: revision + 1 };
  });
  return { get, put };
}
