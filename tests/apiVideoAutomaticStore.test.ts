import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApiVideoRequestStore, AUTOMATIC_VIDEO_RETRY_WINDOW_MS as windowMs } from '../server/services/apiVideoRequestStore';

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.open) db.close(); });
function database(filename = ':memory:') {
  const db = new Database(filename); opened.push(db);
  db.exec('CREATE TABLE IF NOT EXISTS contents(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,status TEXT,metadata TEXT)');
  return db;
}
function content(db: Database.Database, id: number, status: string, metadata: any = {}) {
  db.prepare('INSERT OR REPLACE INTO contents VALUES(?,10,?,?,?)').run(id, 'video', status, JSON.stringify({ tokenId: 1, ...metadata }));
}
describe('automatic video retry protection persists across callers and restarts', () => {
  it('reuses a preparing request across separate database connections and a restart without an expiry', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'video-auto-retry-')), filename = path.join(directory, 'requests.db');
    try {
      const a = database(filename), b = database(filename);
      const first = createApiVideoRequestStore(a).claimAutomatic(1, 10, 'same', 0);
      expect(createApiVideoRequestStore(b).claimAutomatic(1, 10, 'same', 100 * windowMs)).toMatchObject({ fresh: false, record: { id: first.record.id } });
      a.close(); b.close();
      const c = database(filename), store = createApiVideoRequestStore(c);
      content(c, 1, 'review', { requiresReview: true, billingStatus: 'review' }); store.link(first.record.id, 1);
      expect(store.claimAutomatic(1, 10, 'same', 1000 * windowMs).record.id).toBe(first.record.id);
      c.close();
    } finally {
      for (const db of opened) if (db.open) db.close();
      for (const suffix of ['', '-wal', '-shm', '-journal']) { try { unlinkSync(filename + suffix); } catch {} }
      rmdirSync(directory);
    }
  });
  it('adds retry metadata to the old schema while preserving IDs, cached responses and explicit key hashes', () => {
    const db = database();
    db.exec(`CREATE TABLE api_video_requests(id TEXT PRIMARY KEY,token_id INTEGER,user_id INTEGER,key_hash TEXT,fingerprint TEXT,content_id INTEGER,response_status INTEGER,response_body TEXT,created_at TEXT,UNIQUE(token_id,user_id,key_hash),UNIQUE(content_id));
      INSERT INTO api_video_requests VALUES('old-request',1,10,'old-hash','same',NULL,NULL,NULL,'2000-01-01');`);
    const before = db.prepare('SELECT * FROM api_video_requests').get();
    const store = createApiVideoRequestStore(db);
    expect(store.claimAutomatic(1, 10, 'same')).toMatchObject({ fresh: false, record: { id: 'old-request' } });
    expect(db.prepare('SELECT * FROM api_video_requests').get()).toMatchObject(before!);
    expect(store.claim(1, 10, 'old-hash', 'same').record.id).toBe('old-request');
  });
  it('never shares automatic requests between tokens, owners, fingerprints or new explicit keys', () => {
    const store = createApiVideoRequestStore(database()), first = store.claimAutomatic(1, 10, 'same');
    for (const [token, user, fp] of [[2, 10, 'same'], [1, 20, 'same'], [1, 10, 'different']] as const)
      expect(store.claimAutomatic(token, user, fp).record.id).not.toBe(first.record.id);
    const explicit = store.claim(1, 10, 'new-key', 'same');
    expect(explicit.record.id).not.toBe(first.record.id);
    expect(store.claimAutomatic(1, 10, 'same').record.id).toBe(first.record.id);
  });
  it('protects a success until exactly ten minutes after completion without extending the window on retries', () => {
    const db = database(), store = createApiVideoRequestStore(db), first = store.claimAutomatic(1, 10, 'same', 0);
    content(db, 1, 'completed', { completedAt: new Date(1000).toISOString(), billingStatus: 'settled' }); store.link(first.record.id, 1);
    expect(store.claimAutomatic(1, 10, 'same', 1000 + windowMs - 1).record.id).toBe(first.record.id);
    expect(store.claimAutomatic(1, 10, 'same', 1000 + windowMs)).toMatchObject({ fresh: true });
    expect(store.get(first.record.id)?.contentId).toBe(1);
  });
  it('persists a conservative success window when legacy completion metadata has no timestamp', () => {
    const db = database(), store = createApiVideoRequestStore(db), first = store.claimAutomatic(1, 10, 'same', 0);
    content(db, 1, 'completed', { billingStatus: 'charged' }); store.link(first.record.id, 1);
    expect(store.claimAutomatic(1, 10, 'same', 100).record.id).toBe(first.record.id);
    expect(createApiVideoRequestStore(db).claimAutomatic(1, 10, 'same', 100 + windowMs - 1).record.id).toBe(first.record.id);
    expect(store.claimAutomatic(1, 10, 'same', 100 + windowMs).fresh).toBe(true);
  });
  it.each(['reserved', 'review', 'settled', 'missing'])('does not release a failed order with unresolved refund evidence: %s', state => {
    const db = database(), store = createApiVideoRequestStore(db), first = store.claimAutomatic(1, 10, 'same');
    db.exec('CREATE TABLE billing_reservations(id TEXT PRIMARY KEY,state TEXT)');
    if (state !== 'missing') db.prepare('INSERT INTO billing_reservations VALUES(?,?)').run('reservation', state);
    content(db, 1, 'failed', { billingReservationId: 'reservation', billingStatus: 'refunded' }); store.link(first.record.id, 1);
    expect(store.claimAutomatic(1, 10, 'same', Date.now() + 100 * windowMs).record.id).toBe(first.record.id);
    db.prepare("INSERT OR REPLACE INTO billing_reservations VALUES('reservation','refunded')").run();
    expect(store.claimAutomatic(1, 10, 'same').fresh).toBe(true);
  });
  it('prioritizes an older unknown submission over a later successful or refunded historical duplicate', () => {
    const db = database(), store = createApiVideoRequestStore(db);
    const unknown = store.claim(1, 10, 'old-unknown', 'same'), success = store.claim(1, 10, 'old-success', 'same');
    db.exec("UPDATE api_video_requests SET request_mode='legacy'");
    content(db, 1, 'review', { requiresReview: true }); store.link(unknown.record.id, 1);
    content(db, 2, 'completed', { completedAt: new Date().toISOString() }); store.link(success.record.id, 2);
    expect(store.claimAutomatic(1, 10, 'same').record.id).toBe(unknown.record.id);
  });
  it.each(['deleted', 'invalid-metadata', 'failed-without-refund', 'completed-settlement-review'])('retains protection for missing or uncertain local state: %s', state => {
    const db = database(), store = createApiVideoRequestStore(db), first = store.claimAutomatic(1, 10, 'same');
    content(db, 1, 'processing'); store.link(first.record.id, 1);
    if (state === 'deleted') db.exec('DELETE FROM contents');
    if (state === 'invalid-metadata') db.exec("UPDATE contents SET metadata='invalid'");
    if (state === 'failed-without-refund') db.exec("UPDATE contents SET status='failed'");
    if (state === 'completed-settlement-review') content(db, 1, 'completed', { billingStatus: 'review' });
    expect(store.claimAutomatic(1, 10, 'same', Date.now() + 100 * windowMs).record.id).toBe(first.record.id);
  });
  it('permits a new validation attempt without rewriting or reopening the old validation record', () => {
    const store = createApiVideoRequestStore(database()), first = store.claimAutomatic(1, 10, 'same');
    store.finishWithoutContent(first.record.id, 400, '{"error":"invalid"}');
    expect(store.claimAutomatic(1, 10, 'same').fresh).toBe(true);
    expect(store.get(first.record.id)).toMatchObject({ responseStatus: 400, responseBody: '{"error":"invalid"}' });
  });
});
