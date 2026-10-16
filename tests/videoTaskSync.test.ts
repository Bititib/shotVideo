import { describe, it, expect } from 'vitest';
import { shouldPollVideoTask, videoTaskDatabaseId, videoTaskNeedsReview } from '../client/src/utils/videoTaskSync';

describe('video completion reconciliation', () => {
  it('polls a live SSE task as soon as content_id arrives, without waiting for close', () => {
    const task = { id: 'task_100', status: 'generating' };
    expect(shouldPollVideoTask(task)).toBe(false);
    expect(shouldPollVideoTask({ ...task, dbId: 11949 })).toBe(true);
    expect(videoTaskDatabaseId({ ...task, dbId: 11949 })).toBe(11949);
  });
  it('keeps reviewed tasks available for read-only reconciliation while recognizing confirmed terminal states', () => {
    expect(shouldPollVideoTask({id:'db_12965',status:'review'})).toBe(true);
    expect(shouldPollVideoTask({id:'no-database-id',status:'review'})).toBe(false);
    expect(videoTaskNeedsReview({status:'review'})).toBe(true);
    expect(videoTaskNeedsReview({status:'processing',metadata:'{"requiresReview":true}'})).toBe(true);
    expect(videoTaskNeedsReview({status:'processing',metadata:{hayaNeedsReview:true}})).toBe(true);
    for(const status of ['failed','error','completed','success'])expect(videoTaskNeedsReview({status,metadata:{requiresReview:true}})).toBe(false);
    expect(videoTaskNeedsReview({status:'processing',metadata:'invalid-json'})).toBe(false);
  });
  it('also reconciles restored tasks but stops polling terminal or invalid tasks', () => {
    expect(shouldPollVideoTask({ id: 'db_11950', status: 'generating' })).toBe(true);
    expect(videoTaskDatabaseId({ id: 'db_11950', status: 'generating' })).toBe(11950);
    for (const status of ['complete', 'error']) expect(shouldPollVideoTask({ id: 'task_100', dbId: 11949, status })).toBe(false);
    expect(shouldPollVideoTask({ id: 'db_invalid', status: 'generating' })).toBe(false);
  });
});
