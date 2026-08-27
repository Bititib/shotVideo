import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../server/db/index.js';
import { modelFeedbacks, users } from '../server/db/schema.js';
import { FeedbackService } from '../server/services/feedbackService.js';

const TEST_MODEL = '__feedback_test_model__';
let userId = 0;

describe('model failure feedback', () => {
  beforeAll(() => {
    const user = db.select().from(users).get();
    if (!user) throw new Error('test user is missing');
    userId = user.id;
    db.delete(modelFeedbacks).where(eq(modelFeedbacks.modelId, TEST_MODEL)).run();
  });

  afterAll(() => {
    db.delete(modelFeedbacks).where(eq(modelFeedbacks.modelId, TEST_MODEL)).run();
  });

  it('creates feedback and prevents duplicate pending reports', () => {
    const first = FeedbackService.create(userId, {
      modelId: TEST_MODEL,
      errorMessage: 'upstream timeout',
      description: 'failed twice',
    });
    const duplicate = FeedbackService.create(userId, {
      modelId: TEST_MODEL,
      errorMessage: 'upstream timeout',
      description: 'failed again',
    });

    expect(first.duplicate).toBe(false);
    expect(duplicate).toEqual({ id: first.id, duplicate: true });
  });

  it('lists and resolves feedback for administrators', () => {
    const list = FeedbackService.getAdminList({ page: 1, pageSize: 10, modelId: TEST_MODEL });
    expect(list.total).toBe(1);
    expect(list.items[0].errorMessage).toBe('upstream timeout');

    FeedbackService.update(list.items[0].id, { status: 'resolved', adminNote: 'channel restored' });
    const resolved = FeedbackService.getAdminList({ page: 1, pageSize: 10, status: 'resolved', modelId: TEST_MODEL });
    expect(resolved.items[0].adminNote).toBe('channel restored');
    expect(resolved.items[0].resolvedAt).toBeTruthy();
  });
});
