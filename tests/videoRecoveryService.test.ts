import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db, sqlite } from '../server/db/index.js';
import { contents, users } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import { BalanceService } from '../server/services/balanceService.js';
import { VideoRecoveryService } from '../server/services/videoRecoveryService.js';

const TEST_EMAIL = 'video-recovery@test.local';
const TEST_CHANNEL_NAME = 'video-recovery-haidiyue';
let userId = 0;
let channelId = 0;
let contentId = 0;
const localizedVideoPath = path.join(process.cwd(), 'data', 'uploads', 'videos', 'video_sd2_5-haidiyue-face_upstream-task-1.mp4');

beforeEach(() => {
  sqlite.prepare('DELETE FROM contents WHERE title = ?').run('video-recovery-test');
  sqlite.prepare('DELETE FROM channels WHERE name = ?').run(TEST_CHANNEL_NAME);
  sqlite.prepare('DELETE FROM users WHERE email = ?').run(TEST_EMAIL);
  if (fs.existsSync(localizedVideoPath)) fs.unlinkSync(localizedVideoPath);

  userId = Number(sqlite.prepare(`
    INSERT INTO users (email, username, password_hash, role, tier_id, balance)
    VALUES (?, 'recovery-user', 'test', 'user', 1, 10)
  `).run(TEST_EMAIL).lastInsertRowid);
  channelId = Number(sqlite.prepare(`
    INSERT INTO channels (name, type, base_url, api_key, supported_models, model_mapping, status)
    VALUES (?, 'wx-haidiyue', 'https://recovery-upstream.test/v1', 'test-key', '["sd2.5-haidiyue-face"]', '{"sd2.5-haidiyue-face":"sd2.5"}', 1)
  `).run(TEST_CHANNEL_NAME).lastInsertRowid);
  contentId = Number(sqlite.prepare(`
    INSERT INTO contents (user_id, type, title, model_id, cost, status, metadata)
    VALUES (?, 'video', 'video-recovery-test', 'sd2.5-haidiyue-face', 0, 'failed', ?)
  `).run(userId, JSON.stringify({
    videoId: 'upstream-task-1',
    channelId,
    actualChannel: 'wx-haidiyue',
    resolution: '720p',
    seconds: 30,
    queueRefunded: true,
    billingStatus: 'refunded',
    refundAmount: 2,
    refundTarget: 'user_balance',
    error: 'temporary 502',
  })).lastInsertRowid);

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('upstream-task-1')) {
      return new Response(JSON.stringify({
        status: 'completed',
        video_url: 'https://recovery-upstream.test/media/recovered.mp4',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]), {
      status: 200,
      headers: { 'Content-Type': 'video/mp4' },
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.prepare('DELETE FROM contents WHERE title = ?').run('video-recovery-test');
  sqlite.prepare('DELETE FROM channels WHERE name = ?').run(TEST_CHANNEL_NAME);
  sqlite.prepare('DELETE FROM users WHERE email = ?').run(TEST_EMAIL);
  if (fs.existsSync(localizedVideoPath)) fs.unlinkSync(localizedVideoPath);
});

describe('VideoRecoveryService', () => {
  it('restores a successful task and charges the refunded amount only once', async () => {
    const recovered = await VideoRecoveryService.recover(contentId);
    expect(recovered.status).toBe('completed');
    expect(BalanceService.getBalance(userId)).toBe(8);

    const record = db.select().from(contents).where(eq(contents.id, contentId)).get();
    const metadata = JSON.parse(record!.metadata);
    expect(record).toMatchObject({ status: 'completed', cost: 2 });
    expect(record!.resultUrl).toBe('/uploads/videos/video_sd2_5-haidiyue-face_upstream-task-1.mp4');
    expect(metadata.recoveryCharged).toBe(true);
    expect(metadata.queueRefunded).toBe(false);

    const repeated = await VideoRecoveryService.recover(contentId);
    expect(repeated.alreadyRecovered).toBe(true);
    expect(BalanceService.getBalance(userId)).toBe(8);
  });

  it('uses the generic saved-channel polling protocol for other video providers', async () => {
    sqlite.prepare("UPDATE channels SET type = 'openai' WHERE id = ?").run(channelId);
    sqlite.prepare("UPDATE contents SET model_id = 'generic-video-model', metadata = ? WHERE id = ?").run(JSON.stringify({
      videoId: 'upstream-task-1',
      channelId,
      actualChannel: 'openai',
      queueRefunded: true,
      refundAmount: 2,
      refundTarget: 'user_balance',
    }), contentId);

    const recovered = await VideoRecoveryService.recover(contentId);
    expect(recovered.status).toBe('completed');
    expect(BalanceService.getBalance(userId)).toBe(8);
    expect(db.select().from(contents).where(eq(contents.id, contentId)).get()).toMatchObject({
      status: 'completed',
      cost: 2,
    });
  });

  it('previews and bulk-recovers eligible failed videos from the last three days', async () => {
    const oldContentId = Number(sqlite.prepare(`
      INSERT INTO contents (user_id, type, title, model_id, cost, status, metadata, created_at)
      VALUES (?, 'video', 'video-recovery-test', 'sd2.5-haidiyue-face', 0, 'failed', ?, datetime('now', '-4 days'))
    `).run(userId, JSON.stringify({
      videoId: 'old-upstream-task',
      channelId,
      refundAmount: 2,
      refundTarget: 'user_balance',
    })).lastInsertRowid);
    sqlite.prepare(`
      INSERT INTO contents (user_id, type, title, model_id, cost, status, metadata)
      VALUES (?, 'video', 'video-recovery-test', 'sd2.5-haidiyue-face', 0, 'failed', '{}')
    `).run(userId);

    const preview = VideoRecoveryService.previewRecentFailed(3);
    expect(preview.candidateIds).toContain(contentId);
    expect(preview.candidateIds).not.toContain(oldContentId);
    expect(preview.missingTaskIdCount).toBeGreaterThanOrEqual(1);

    const result = await VideoRecoveryService.recoverRecentFailed(3);
    expect(result.results).toContainEqual(expect.objectContaining({ id: contentId, status: 'recovered' }));
    expect(result.recoveredCount).toBeGreaterThanOrEqual(1);
    expect(result.chargedAmount).toBeGreaterThanOrEqual(2);
    expect(BalanceService.getBalance(userId)).toBe(8);
  });
});
