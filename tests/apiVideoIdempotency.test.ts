import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApiVideoRequestStore } from '../server/services/apiVideoRequestStore';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { apiVideoFingerprint } from '../server/services/apiVideoIdempotency';
import { TokenService } from '../server/services/tokenService';

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) if (db.open) db.close(); vi.restoreAllMocks(); });
function database(filename = ':memory:') {
  const db = new Database(filename); open.push(db);
  db.exec('CREATE TABLE IF NOT EXISTS contents(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,metadata TEXT)');
  return db;
}
describe('durable API video request identities', () => {
  it('claims only once across database connections and a fresh process/store, without expiring the original key', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'api-video-request-')), filename = path.join(directory, 'test.db');
    try {
      const a = database(filename), first = createApiVideoRequestStore(a).claim(1, 2, 'key-hash', 'fingerprint');
      expect(first.fresh).toBe(true); expect(first.record.id).toMatch(/^task_req_[a-f0-9]{32}$/);
      const b = database(filename), concurrent = createApiVideoRequestStore(b).claim(1, 2, 'key-hash', 'fingerprint');
      expect(concurrent).toMatchObject({ fresh: false, mismatch: false, record: { id: first.record.id } });
      a.close(); b.close();
      const restarted = database(filename); restarted.exec("UPDATE api_video_requests SET created_at='2000-01-01'");
      expect(createApiVideoRequestStore(restarted).claim(1, 2, 'key-hash', 'fingerprint').record.id).toBe(first.record.id);
      restarted.close();
    } finally { for (const suffix of ['', '-wal', '-shm', '-journal']) { try { unlinkSync(filename + suffix); } catch {} } rmdirSync(directory); }
  });
  it('rejects changed parameters and isolates API keys and owners', () => {
    const db = database(), store = createApiVideoRequestStore(db), first = store.claim(1, 10, 'key', 'original');
    expect(store.claim(1, 10, 'key', 'different')).toMatchObject({ fresh: false, mismatch: true });
    expect(store.claim(2, 10, 'key', 'original').record.id).not.toBe(first.record.id);
    expect(store.claim(1, 20, 'key', 'original').record.id).not.toBe(first.record.id);
  });
  it('atomically links the original owned content and prevents a second content or cross-token task', () => {
    const db = database(), store = createApiVideoRequestStore(db), request = store.claim(1, 10, 'key', 'fp').record;
    db.prepare('INSERT INTO contents VALUES(?,?,?,?)').run(1, 10, 'video', '{"tokenId":1}');
    store.link(request.id, 1); store.link(request.id, 1);
    expect(store.get(request.id)?.contentId).toBe(1);
    expect(() => store.link(request.id, 2)).toThrow('关联其他任务');
    const foreign = store.claim(2, 10, 'other-key', 'fp').record;
    expect(() => store.link(foreign.id, 1)).toThrow('归属不一致');
  });
  it('does not leave a linked content when a later deduction fails in the enclosing transaction', () => {
    const db = database(), store = createApiVideoRequestStore(db), request = store.claim(1, 10, 'key', 'fp').record;
    expect(() => db.transaction(() => {
      db.prepare('INSERT INTO contents VALUES(?,?,?,?)').run(1, 10, 'video', '{"tokenId":1}'); store.link(request.id, 1); throw Error('deduction failed');
    })()).toThrow('deduction failed');
    expect(db.prepare('SELECT * FROM contents').all()).toEqual([]);
    expect(store.get(request.id)?.contentId).toBeNull();
    expect(store.claim(1, 10, 'key', 'fp').fresh).toBe(false);
  });
  it('retains the original validation failure and never reopens its identity', () => {
    const db = database(), store = createApiVideoRequestStore(db), request = store.claim(1, 10, 'key', 'fp').record;
    store.finishWithoutContent(request.id, 400, '{"error":"invalid"}');
    store.finishWithoutContent(request.id, 500, '{"error":"late"}');
    expect(store.claim(1, 10, 'key', 'fp')).toMatchObject({ fresh: false, record: { responseStatus: 400, responseBody: '{"error":"invalid"}' } });
    expect(() => store.link(request.id, 1)).toThrow('已处理');
  });
  it('hashes JSON key order and file contents consistently, ignoring random upload names and paths', async () => {
    const first = { body: { model: 'video', seconds: 5, nested: { b: 2, a: 1 } }, files: [{ fieldname: 'image', mimetype: 'image/png', buffer: Buffer.from('reference'), path: 'random-one', originalname: 'one.png' }] } as any;
    const second = { body: { nested: { a: 1, b: 2 }, seconds: 5, model: 'video' }, files: [{ ...first.files[0], path: 'random-two', originalname: 'two.png' }] } as any;
    expect(await apiVideoFingerprint(first)).toBe(await apiVideoFingerprint(second));
    second.files[0].buffer = Buffer.from('different reference');
    expect(await apiVideoFingerprint(first)).not.toBe(await apiVideoFingerprint(second));
  });
  it('permits exhausted identities only when explicitly requested, while disabled and expired keys remain invalid', () => {
    const token = { id: 1, balance: 0, status: 1, expiresAt: null } as any;
    vi.spyOn(TokenService, 'findByKey').mockImplementation(() => token);
    expect(TokenService.validateToken('test').valid).toBe(false);
    expect(TokenService.validateToken('test', { allowExhausted: true }).valid).toBe(true);
    token.status = 0; expect(TokenService.validateToken('test', { allowExhausted: true }).valid).toBe(false);
    token.status = 1; token.expiresAt = '2000-01-01'; expect(TokenService.validateToken('test', { allowExhausted: true }).valid).toBe(false);
  });
});
