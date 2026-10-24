import { describe, it, expect } from 'vitest';
import { classifyHmSubmission, readHmSubmission, hmSubmissionTransportError } from '../server/services/hmStudioSubmission.js';
import { submissionFailure } from '../server/services/specificationAdapters.js';

describe('HM independent submission outcomes', () => {
  it('uses HM documented 202 receipt, 429 GENERATING_LIMIT and 503 busy envelopes', () => {
    expect(classifyHmSubmission(202, { task_id: 'cgt-123' }, new Headers())).toMatchObject({ outcome: 'accepted', taskId: 'cgt-123' });
    expect(classifyHmSubmission(429, { code: 'GENERATING_LIMIT', error: '当前有 3 个任务正在生成中，请等待完成后再提交' }, new Headers()).outcome).toBe('rejected');
    expect(classifyHmSubmission(503, { error: '繁忙，稍后重试' }, new Headers()).outcome).toBe('rejected');
    expect(classifyHmSubmission(500, { error: '内部错误' }, new Headers()).outcome).toBe('unknown');
  });
  it.each([200, 400, 500, 503])('recognizes the reported maintenance refusal at HTTP %s without a receipt', async status => {
    for (const body of [{ error: '临时修复，有问题请稍后重试' }, { detail: '临时修复' }, '临时修复']) {
      expect(classifyHmSubmission(status, body, new Headers()).outcome).toBe('rejected');
      const result = submissionFailure(status, JSON.stringify(body), { type: 'hmstudio' }, true);
      expect(result).toMatchObject({ confirmedFailure: true, uncertain: false, retrySafe: false });
    }
  });
  it.each([400, 401, 402, 403, 422, 429])('rejects HTTP %s with diagnostic request ID, not a generation receipt', status => {
    expect(classifyHmSubmission(status, { detail: 'invalid parameters', request_id: 'trace_1' }, new Headers()).outcome).toBe('rejected');
  });
  it.each([
    [503, { error: '临时修复', task_id: 'task_1' }, {}],
    [503, { error: '临时修复', status: 'processing' }, {}],
    [503, { error: '临时修复' }, { 'x-task-id': 'task_1' }],
    [504, { error: '临时修复' }, {}],
    [503, { message: 'service unavailable' }, {}],
    [500, { prompt: '临时修复' }, {}],
    [200, {}, {}],
  ])('preserves ambiguous or conflicting response %j', (status, body, headers) => {
    expect(classifyHmSubmission(status as number, body, new Headers(headers as any)).outcome).toBe('unknown');
  });
  it('reads nested task ID and preserves received errors', async () => {
    expect(await readHmSubmission(Response.json({ data: { task_id: 'task_1' } }), 'secret')).toMatchObject({ taskId: 'task_1' });
    await expect(readHmSubmission(Response.json({ detail: 'bad image secret' }, { status: 422 }), 'secret'))
      .rejects.toMatchObject({ outcome: 'rejected', message: expect.stringContaining('bad image') });
  });
  it('separates a connection never established from a lost reply', () => {
    expect(hmSubmissionTransportError({ message: 'connection refused', cause: { code: 'ECONNREFUSED' } }, '').outcome).toBe('rejected');
    expect(hmSubmissionTransportError({ message: 'socket reset', cause: { code: 'ECONNRESET' } }, '').outcome).toBe('unknown');
  });
  it('does not apply HM maintenance wording to another channel', () => {
    expect(submissionFailure(503, JSON.stringify({ error: '临时修复' }), { type: 'haya' }, true))
      .toMatchObject({ uncertain: true, confirmedFailure: false });
  });
});
