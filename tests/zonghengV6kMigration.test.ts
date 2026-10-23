import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateZonghengToV6k } from '../server/services/zonghengV6kMigration';
import { zonghengTaskUrl, zonghengBaseUrl, ZONGHENG_BASE_URL } from '../server/services/zonghengAdapter';

describe('retire the old Zongheng API', () => {
  it('converts channel configuration, holds old pending records and preserves money and completed files', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE channels(id INTEGER PRIMARY KEY,type TEXT,base_url TEXT,status INTEGER,max_retries INTEGER,api_key TEXT);
        CREATE TABLE contents(id INTEGER PRIMARY KEY,type TEXT,status TEXT,cost REAL,metadata TEXT,result_url TEXT);
        CREATE TABLE users(id INTEGER PRIMARY KEY,balance REAL);
        INSERT INTO users VALUES(1,93.5);
        INSERT INTO channels VALUES(21,'zongheng','https://cnd-coo-new.pages.dev',1,3,'old-key'),
          (22,'zongheng-v6k','https://www.v6k.top',1,0,'new-key'),(23,'openai','https://other.example',1,3,'other-key');`);
      const add = db.prepare('INSERT INTO contents VALUES(?,?,?,?,?,?)');
      add.run(1, 'video', 'processing', 6.5, JSON.stringify({ channelId: 21, videoId: 'vid_old' }), null);
      add.run(2, 'video', 'completed', 6.5, JSON.stringify({ channelId: 21 }), '/uploads/completed.mp4');
      add.run(3, 'video', 'failed', 0, JSON.stringify({ channelId: 21, queueRefunded: true }), null);
      add.run(4, 'video', 'processing', 2, JSON.stringify({ channelId: 22, videoId: 'new_id', zonghengProtocol: 'v6k' }), null);
      add.run(5, 'video', 'processing', 1, JSON.stringify({ channelId: 23, videoId: 'other' }), null);
      expect(migrateZonghengToV6k(db)).toEqual({ retiredTasks: 1 });
      expect(db.prepare('SELECT type,base_url,status,api_key FROM channels WHERE id=21').get()).toEqual({ type: 'zongheng-v6k', base_url: 'https://www.v6k.top', status: 0, api_key: 'old-key' });
      const old: any = db.prepare('SELECT * FROM contents WHERE id=1').get();
      expect(old).toMatchObject({ status: 'review', cost: 6.5 });
      expect(JSON.parse(old.metadata)).toMatchObject({ videoId: 'vid_old', zonghengLegacyTask: true, requiresReview: true });
      expect(db.prepare('SELECT status,result_url FROM contents WHERE id=2').get()).toEqual({ status: 'completed', result_url: '/uploads/completed.mp4' });
      expect(db.prepare('SELECT status,cost FROM contents WHERE id=3').get()).toEqual({ status: 'failed', cost: 0 });
      expect(db.prepare('SELECT status FROM contents WHERE id=4').get()).toEqual({ status: 'processing' });
      expect(db.prepare('SELECT status FROM contents WHERE id=5').get()).toEqual({ status: 'processing' });
      expect(db.prepare('SELECT balance FROM users WHERE id=1').get()).toEqual({ balance: 93.5 });
      expect(migrateZonghengToV6k(db)).toEqual({ retiredTasks: 0 });
    } finally { db.close(); }
  });
  it('exposes only the new query endpoint and refuses the retired host before sending a request', () => {
    expect(ZONGHENG_BASE_URL).toBe('https://www.v6k.top');
    expect(zonghengTaskUrl(ZONGHENG_BASE_URL, 'id')).toBe('https://www.v6k.top/v1/videos/id');
    expect(() => zonghengBaseUrl('https://cnd-coo-new.pages.dev')).toThrow('已停用');
  });
});
