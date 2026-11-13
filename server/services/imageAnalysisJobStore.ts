import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ImageAnalysisJob, ImageAnalysisResult } from '../../shared/imageAnalysis.js';
import { beijingDateKey, beijingDayBounds } from '../../shared/time.js';

export type ImageJobInput = { id: string; owner: number; orgId?: number | null; modelId: number; requiresText: boolean;
  files: { path: string; mime: string; hash: string }[]; quota: number };
export class ImageAnalysisJobStore {
  constructor(public database: Database.Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS image_analysis_jobs (
      id TEXT NOT NULL, owner INTEGER NOT NULL, signature TEXT NOT NULL, model_id INTEGER NOT NULL,
      requires_text INTEGER NOT NULL, org_id INTEGER, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS image_analysis_items (
      owner INTEGER NOT NULL, job_id TEXT NOT NULL, position INTEGER NOT NULL, file_path TEXT NOT NULL, mime TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', result TEXT, error TEXT, usage_id INTEGER,
      PRIMARY KEY(owner,job_id,position));`);
  }
  get(owner: number, id: string): ImageAnalysisJob | null {
    if (!this.database.prepare('SELECT 1 FROM image_analysis_jobs WHERE owner=? AND id=?').get(owner, id)) return null;
    const rows = this.database.prepare('SELECT position,status,result,error FROM image_analysis_items WHERE owner=? AND job_id=? ORDER BY position').all(owner, id) as any[];
    return { id, items: rows.map(row => ({ index: row.position, status: row.status, result: row.result ? JSON.parse(row.result) : null, error: row.error })) };
  }
  create(input: ImageJobInput) {
    const signature = createHash('sha256').update(JSON.stringify([input.modelId, input.requiresText, input.files.map(file => file.hash)])).digest('hex');
    return this.database.transaction(() => {
      const existing = this.database.prepare('SELECT signature FROM image_analysis_jobs WHERE owner=? AND id=?').get(input.owner, input.id) as any;
      if (existing) {
        if (existing.signature !== signature) throw Object.assign(new Error('请求编号已用于另一组图片'), { status: 409 });
        return false;
      }
      const day = beijingDayBounds(beijingDateKey())!;
      const used = (this.database.prepare('SELECT count(*) AS n FROM usage_logs WHERE user_id=? AND created_at>=? AND created_at<?').get(input.owner, day.start, day.end) as any).n;
      if (input.quota !== -1 && used + input.files.length > input.quota) throw Object.assign(new Error(`本次需分析 ${input.files.length} 张图片，今日剩余 ${Math.max(0, input.quota - used)} 次`), { status: 429 });
      this.database.prepare('INSERT INTO image_analysis_jobs(id,owner,signature,model_id,requires_text,org_id) VALUES(?,?,?,?,?,?)')
        .run(input.id, input.owner, signature, input.modelId, Number(input.requiresText), input.orgId || null);
      input.files.forEach((file, index) => {
        // Reserve one existing analysis-quota unit per image, atomically with the job.
        const usage = this.database.prepare("INSERT INTO usage_logs(user_id,analysis_type,model_id,status) VALUES(?,'image',?,'reserved')").run(input.owner, input.modelId);
        this.database.prepare('INSERT INTO image_analysis_items(owner,job_id,position,file_path,mime,usage_id) VALUES(?,?,?,?,?,?)')
          .run(input.owner, input.id, index, file.path, file.mime, Number(usage.lastInsertRowid));
      });
      return true;
    })();
  }
  recover() {
    // No upstream receipt exists for this synchronous API. Never replay a sent request.
    this.database.prepare("UPDATE image_analysis_items SET status='interrupted',error='服务重启时此图片正在分析，未能确认返回结果；不会自动重复提交。' WHERE status='running'").run();
  }
  uncertain(item: any, error: string) {
    this.database.prepare("UPDATE image_analysis_items SET status='interrupted',error=? WHERE owner=? AND job_id=? AND position=? AND status='running'")
      .run(error, item.owner, item.job_id, item.position);
  }
  claim(): any {
    return this.database.transaction(() => {
      const item = this.database.prepare(`SELECT i.*, j.model_id,j.requires_text,j.org_id FROM image_analysis_items i
        JOIN image_analysis_jobs j ON j.owner=i.owner AND j.id=i.job_id WHERE i.status='queued' ORDER BY j.created_at,i.position LIMIT 1`).get() as any;
      if (!item) return null;
      this.database.prepare("UPDATE image_analysis_items SET status='running' WHERE owner=? AND job_id=? AND position=? AND status='queued'").run(item.owner, item.job_id, item.position);
      return item;
    })();
  }
  finish(item: any, result: ImageAnalysisResult | null, error: string | null, persist?: () => void) {
    this.database.transaction(() => {
      const current = this.database.prepare('SELECT status FROM image_analysis_items WHERE owner=? AND job_id=? AND position=?').get(item.owner, item.job_id, item.position) as any;
      if (current?.status !== 'running') return;
      this.database.prepare('UPDATE image_analysis_items SET status=?,result=?,error=? WHERE owner=? AND job_id=? AND position=?')
        .run(result ? 'completed' : 'error', result ? JSON.stringify(result) : null, error, item.owner, item.job_id, item.position);
      if (result) {
        this.database.prepare("UPDATE usage_logs SET status='success' WHERE id=?").run(item.usage_id);
        persist?.();
      } else {
        // A failed analysis has no successful quota usage, matching the existing single-image route.
        this.database.prepare("DELETE FROM usage_logs WHERE id=? AND status='reserved'").run(item.usage_id);
      }
    })();
  }
}
