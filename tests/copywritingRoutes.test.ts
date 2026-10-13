import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig, SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema');
  const sqlite = new Database(':memory:'), dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table as any);
    const columns = config.columns.map(c => {
      const value = c.default === undefined ? '' : typeof c.default === 'object' ? dialect.sqlToQuery(c.default as any).sql
        : typeof c.default === 'string' ? "'" + c.default.replace(/'/g, "''") + "'" : String(c.default);
      return '"' + c.name + '" ' + c.getSQLType() + (c.primary ? ' PRIMARY KEY' : '') + (value ? ' DEFAULT ' + value : '');
    });
    sqlite.exec('CREATE TABLE "' + config.name + '" (' + columns.join(',') + ')');
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
vi.mock('../server/services/aiService.js', () => ({ AIService: { analyzeCopywriting: vi.fn() } }));
vi.mock('../server/middleware/quota.js', () => ({ quotaMiddleware: vi.fn(), logUsage: vi.fn() }));
vi.mock('../server/routes/video.js', () => ({ activePolls: new Map(), enqueueHmStudioVideoContent: vi.fn(), resumePollForTask: vi.fn() }));
import { sqlite } from '../server/db/index';
import { AIService } from '../server/services/aiService';
import { logUsage } from '../server/middleware/quota';
import analysisRouter from '../server/routes/analysis';
import contentRouter from '../server/routes/content';
import { defaultCopywritingOptions } from '../shared/copywriting';

const temporaryDirectories: string[] = [];
const detail = () => ({ title: '随行杯', subtitle: '首屏文案', sections: Array.from({ length: 3 }, (_, i) => ({ heading: '分屏' + i, body: '经确认的文案', bullets: [] })), specifications: [], faqs: [], factsToConfirm: ['容量待确认'] });
function file() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copywriting-route-')); temporaryDirectories.push(dir);
  const target = path.join(dir, 'product.png'); fs.writeFileSync(target, 'fixture');
  return { path: target, mimetype: 'image/png', originalname: 'product.png' };
}
async function invoke(router: any, route: string, method: string, req: any) {
  const layer = router.stack.find((layer: any) => layer.route?.path === route && layer.route.methods[method]);
  const res: any = { code: 200, status(value: number) { this.code = value; return this; }, json(body: any) { this.body = body; return this; } };
  await layer.route.stack.at(-1).handle(req, res, () => {}); return res;
}
function request(body: any, files = [file()]) { return { body, files, userId: 1, availableModels: [{ id: 1, modelId: 'gemini-default', apiKey: null }, { id: 2, modelId: 'gemini-selected', apiKey: null }] }; }
function row(id: number) { return sqlite.prepare('SELECT * FROM contents WHERE id=?').get(id) as any; }

beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {});
  sqlite.exec('DELETE FROM contents; DELETE FROM users; INSERT INTO users(id,balance) VALUES(1,10),(2,20)');
  vi.mocked(AIService.analyzeCopywriting).mockResolvedValue({ detailPage: detail() });
});
afterEach(() => { vi.restoreAllMocks(); for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
afterAll(() => sqlite.close());

describe('copywriting detail mode on existing routes', () => {
  it('stores the complete document, original options and selected model in the existing content library', async () => {
    const value = detail(); value.sections[0].body = '文案'.repeat(3000);
    vi.mocked(AIService.analyzeCopywriting).mockResolvedValue({ detailPage: value });
    const options = { ...defaultCopywritingOptions, mode: 'detail', productName: '通勤杯', productFacts: '颜色绿色', factsConfirmed: true };
    const req = request({ modelId: 'gemini-selected', copywritingOptions: JSON.stringify(options) });
    const res = await invoke(analysisRouter, '/copywriting', 'post', req);
    expect(res.code).toBe(200); expect(res.body.contentId).toBeGreaterThan(0);
    const saved = row(res.body.contentId);
    expect(saved).toMatchObject({ type: 'copywriting', title: '通勤杯', model_id: 'gemini-selected', cost: 0, user_id: 1 });
    expect(saved.result_text.length).toBeGreaterThan(5000); expect(JSON.parse(saved.result_text).detailPage).toEqual(value);
    expect(JSON.parse(saved.metadata).copywritingOptions).toEqual(options);
    expect(AIService.analyzeCopywriting).toHaveBeenCalledWith(req.files, expect.objectContaining({ modelId: 'gemini-selected' }), options);
    expect(logUsage).toHaveBeenCalledWith(1, 'copywriting', 2, expect.any(Number));
    expect(fs.existsSync(req.files[0].path)).toBe(false);
    expect((sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance).toBe(10);
  });

  it.each(['{invalid', JSON.stringify({ mode: 'detail', productFacts: '材质棉', factsConfirmed: false })])('rejects invalid or unconfirmed inputs before analysis and history writes', async copywritingOptions => {
    const req = request({ copywritingOptions });
    expect((await invoke(analysisRouter, '/copywriting', 'post', req)).code).toBe(400);
    expect(AIService.analyzeCopywriting).not.toHaveBeenCalled(); expect(logUsage).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT id FROM contents').all()).toHaveLength(0);
    expect(fs.existsSync(req.files[0].path)).toBe(false);
  });

  it('keeps requests without new settings in legacy marketing mode', async () => {
    vi.mocked(AIService.analyzeCopywriting).mockResolvedValue({ tiktok: { hook: 'Hook' }, amazon: { title: 'Listing' }, detailPageImages: [] });
    const res = await invoke(analysisRouter, '/copywriting', 'post', request({}));
    expect(res.code).toBe(200); expect(res.body.amazon.title).toBe('Listing');
    expect(vi.mocked(AIService.analyzeCopywriting).mock.calls[0][2].mode).toBe('marketing');
  });

  it('lets the owner save manual edits without changing accounting or creating another generation', async () => {
    const res = await invoke(analysisRouter, '/copywriting', 'post', request({ copywritingOptions: JSON.stringify({ mode: 'detail' }) }));
    const id = res.body.contentId, updated = detail(); updated.title = '人工编辑标题';
    sqlite.prepare('UPDATE contents SET cost=0.12,metadata=? WHERE id=?').run(JSON.stringify({ billingStatus: 'settled', billingReservationId: 'original', copywritingOptions: { mode: 'detail' } }), id);
    expect((await invoke(contentRouter, '/:id', 'put', { params: { id: String(id) }, userId: 1, body: { detailPage: updated, cost: 999, metadata: { billingStatus: 'refunded' } } })).code).toBe(200);
    const saved = row(id);
    expect(JSON.parse(saved.result_text).detailPage.title).toBe('人工编辑标题'); expect(saved.cost).toBe(0.12);
    expect(JSON.parse(saved.metadata)).toMatchObject({ billingStatus: 'settled', billingReservationId: 'original' });
    expect(AIService.analyzeCopywriting).toHaveBeenCalledTimes(1);
    expect((await invoke(contentRouter, '/:id', 'put', { params: { id: String(id) }, userId: 2, body: { detailPage: updated } })).code).toBe(403);
    expect((await invoke(contentRouter, '/:id', 'put', { params: { id: String(id) }, userId: 1, body: { detailPage: { title: '不完整' } } })).code).toBe(400);
    expect(JSON.parse(row(id).result_text).detailPage.title).toBe('人工编辑标题');
  });
});
