import { beforeEach, describe, expect, it } from 'vitest';
import { sqlite } from '../server/db/index';
import { findVideoSubmissionReceipt, persistVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService';

describe('durable video submission receipts', () => {
  beforeEach(() => {
    findVideoSubmissionReceipt(987654);
    sqlite.exec('DELETE FROM video_submission_receipts');
  });

  it('keeps the accepted upstream task ID independently from content metadata', () => {
    persistVideoSubmissionReceipt({
      contentId: 987654,
      upstreamTaskId: 'task_snumom_123',
      channelId: 9,
      channelApiKeyId: 3,
      provider: 'snumom',
    });
    expect(findVideoSubmissionReceipt(987654)).toEqual({
      contentId: 987654,
      upstreamTaskId: 'task_snumom_123',
      channelId: 9,
      channelApiKeyId: 3,
      provider: 'snumom',
    });
  });

  it('rejects request IDs and other non-polling identifiers', () => {
    expect(() => persistVideoSubmissionReceipt({
      contentId: 987654,
      upstreamTaskId: 'request-123',
      channelId: 9,
      channelApiKeyId: null,
      provider: 'snumom',
    })).toThrow('任务 ID 无效');
  });
  it('can initialize again after a transaction that created the table rolled back', () => {
    sqlite.exec('DROP TABLE video_submission_receipts');
    expect(() => sqlite.transaction(() => {
      persistVideoSubmissionReceipt({ contentId: 1, upstreamTaskId: 'task_rollback', channelId: 1, channelApiKeyId: null, provider: 'snumom' });
      throw new Error('rollback');
    })()).toThrow('rollback');
    expect(findVideoSubmissionReceipt(1)).toBeNull();
  });
});
