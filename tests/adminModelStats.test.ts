import { afterAll, describe, expect, it, vi } from 'vitest';

// An isolated in-memory database: never initialize or migrate the workspace database.
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY, provider TEXT, model_id TEXT, display_name TEXT,
      description TEXT, api_key TEXT, capabilities TEXT, is_active INTEGER, created_at TEXT);
    CREATE TABLE contents (model_id TEXT, status TEXT, result_url TEXT, metadata TEXT, created_at TEXT);
    CREATE TABLE api_logs (model TEXT, status TEXT, duration_ms INTEGER);
    CREATE TABLE usage_logs (model_id INTEGER, status TEXT, duration_ms INTEGER);
    CREATE TABLE model_pricing (id INTEGER PRIMARY KEY, model_pattern TEXT, billing_type TEXT, input_price REAL, output_price REAL, extra_params TEXT, created_at TEXT);
    INSERT INTO models VALUES (1,'test','video-a','Video A',NULL,'secret-1234','["video"]',1,'2026-01-01');
    INSERT INTO models VALUES (2,'test','empty','Empty',NULL,NULL,'["text"]',1,'2026-01-01');
    INSERT INTO contents VALUES ('video-a','completed','/video','{"durationMs":120000}','2026-01-01');
    INSERT INTO contents VALUES ('video-a','completed',' ','{}','2026-01-01');
    INSERT INTO contents VALUES ('video-a','failed',NULL,'{}','2026-01-01');
    INSERT INTO contents VALUES ('video-a','processing',NULL,'{}','2026-01-01');
    INSERT INTO api_logs VALUES ('video-a','success',60000),('video-a','success',NULL),('video-a','error',9000);
    INSERT INTO usage_logs VALUES (1,'success',180000),(1,'failed',9000),(1,'error',9000);
  `);
  return { db: drizzle(sqlite), sqlite };
});
import { db, sqlite } from '../server/db/index.js';
import { AdminService } from '../server/services/adminService.js';
import { PricingService } from '../server/services/pricingService.js';
afterAll(() => sqlite.close());

describe('batched admin model statistics', () => {
  it('returns configuration without querying historical records', () => {
    const select = vi.spyOn(db, 'select');
    const config = AdminService.getModels(false);
    expect(config[0]).toMatchObject({ modelId: 'video-a', apiKey: '****1234' });
    expect(config[0].totalCalls).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);
    select.mockRestore();
  });
  it('reuses a short-lived statistics snapshot and excludes configuration secrets', () => {
    AdminService.invalidateModelStatistics();
    const select = vi.spyOn(db, 'select');
    const first = AdminService.getModelStatistics();
    expect(first[0].apiKey).toBeUndefined();
    expect(AdminService.getModelStatistics()).toEqual(first);
    expect(select).toHaveBeenCalledTimes(4);
    select.mockRestore();
  });
  it('preserves totals, duration denominator, pending statuses and key masking', () => {
    const rows = AdminService.getModels();
    expect(rows[0]).toMatchObject({ totalCalls: 10, successCalls: 4, failCalls: 4, successRate: 40, failureRate: 40, avgDurationMinutes: 1.5, apiKey: '****1234', capabilities: ['video'] });
    expect(rows[1]).toMatchObject({ totalCalls: 0, successRate: 100, failureRate: 0, avgDurationMinutes: 0 });
  });
  it('uses four queries even with many models', () => {
    for (let id = 3; id < 103; id++) sqlite.prepare('INSERT INTO models VALUES (?, ?, ?, ?, NULL, NULL, ?, 1, ?)').run(id, 'test', `model-${id}`, `Model ${id}`, '["text"]', '2026-01-01');
    const select = vi.spyOn(db, 'select');
    expect(AdminService.getModels()).toHaveLength(102);
    expect(select).toHaveBeenCalledTimes(4);
    select.mockRestore();
  });
  it('allows exact price management for a disabled model without adding it to the active pricing list', () => {
    sqlite.exec("UPDATE models SET is_active = 0 WHERE id = 1");
    expect(PricingService.getPricingRules({ scope: 'active' }).some(row => row.modelPattern === 'video-a')).toBe(false);
    expect(PricingService.getPricingRules({ scope: 'active', modelId: 'video-a' })).toEqual([
      expect.objectContaining({ modelPattern: 'video-a', modelActive: false, configured: false }),
    ]);
    sqlite.exec("INSERT INTO model_pricing VALUES (1, 'video-a', 'per_call', 2.5, 0, '{}', '2026-01-01')");
    expect(PricingService.getPricingRules({ scope: 'active', modelId: 'video-a' })).toEqual([
      expect.objectContaining({ id: 1, modelPattern: 'video-a', modelActive: false, configured: true, inputPrice: 2.5 }),
    ]);
  });
  it('builds all model price sources with only two queries', () => {
    const select = vi.spyOn(db, 'select');
    const rows = PricingService.getPricingRules({ scope: 'models' });
    expect(rows.some(row => row.modelPattern === 'video-a')).toBe(true);
    expect(select).toHaveBeenCalledTimes(2);
    select.mockRestore();
  });
});
