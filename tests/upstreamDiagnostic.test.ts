import { describe, it, expect } from 'vitest';
import { responseDiagnostic, diagnosticJson, transportDiagnostic } from '../server/services/upstreamDiagnostic.js';
import { publicGenerationError } from '../shared/generationMessages.js';
import { normalizeLongxiaVideoTask } from '../server/services/longxiaVideoAdapter.js';
import { normalizeHmStudioTask } from '../server/services/hmStudioAdapter.js';
import { normalizeWxHaidiYueTask } from '../server/services/wxHaidiYueAdapter.js';
import { normalizeMiaowuVideoTask } from '../server/services/miaowuVideoAdapter.js';
import { normalizeSnumomWanTask } from '../server/services/snumomWanAdapter.js';
import { normalizeHayaTask } from '../server/services/hayaVideoAdapter.js';
import { videoReviewMessage } from '../shared/videoReview.js';
describe('upstream diagnostics', () => {
  it('keeps the specific cause when a task is held for review, including repeated projection', () => {
    const metadata = { requiresReview: true, reviewKind: 'query', upstreamQueryError: '[上游诊断 MJ 查询] HTTP 503 code=OVERLOAD：capacity exhausted' };
    const message = videoReviewMessage(metadata);
    expect(message).toContain('OVERLOAD');
    expect(message).toContain('capacity exhausted');
    expect(message).toContain('请勿重复提交');
    expect(videoReviewMessage({ ...metadata, error: message })).toBe(message);
  });
  it.each([
    ['HM Studio', (p: any) => normalizeHmStudioTask(p, 'https://example.test')],
    ['wx-海底月', (p: any) => normalizeWxHaidiYueTask(p, 'https://example.test')],
    ['喵呜', (p: any) => normalizeMiaowuVideoTask(p, 'https://example.test', 'task_1')],
    ['snumom', (p: any) => normalizeSnumomWanTask(p)],
    ['Haya', (p: any) => normalizeHayaTask(p, 'https://example.test', 'task_1')],
    ['LongXia', (p: any) => normalizeLongxiaVideoTask(p)],
  ])('%s retains independent error code and reason through the public display', (_name, normalize) => {
    const task = normalize({ status: 'failed', error: { code: 'BAD_MEDIA_17', message: '第 3 个素材格式不支持 Bearer private-token' } });
    const shown = publicGenerationError(task.error);
    expect(shown).toContain('BAD_MEDIA_17');
    expect(shown).toContain('第 3 个素材格式不支持');
    expect(shown).not.toContain('private-token');
  });
  it('preserves response status and receipt for malformed successful bodies without echoing HTML', async () => {
    const response = new Response('<html>secret prompt</html>', { status: 200, headers: { 'x-request-id': 'req-bad-json' } });
    await expect(diagnosticJson('MJ', '提交', response)).rejects.toThrow(/HTTP 200.*req-bad-json/);
  });
  it('preserves nested network cause without leaking the API key', () => {
    const message = transportDiagnostic('FunAI', '查询', { message: 'fetch failed secret123', cause: { code: 'ECONNRESET', message: 'socket closed' } }, 'secret123');
    expect(message).toContain('ECONNRESET');
    expect(message).toContain('socket closed');
    expect(message).not.toContain('secret123');
  });
  it('retains details through display and removes credentials', async () => {
    const response = Response.json({ error: { code: 'QUOTA', message: '额度不足 secret-value' } }, { status: 403, headers: { 'x-request-id': 'r123' } });
    const detail = publicGenerationError(await responseDiagnostic('FunAI', '查询异常', response, 'secret-value'));
    for (const value of ['403', 'QUOTA', '额度不足', 'r123']) expect(detail).toContain(value);
    expect(detail).not.toContain('secret-value');
  });
  it('keeps both LongXia error code and message', () => {
    const task = normalizeLongxiaVideoTask({ status: 'failed', error: { code: 'BAD_MEDIA', message: '音频格式错误' } });
    expect(task.error).toContain('BAD_MEDIA'); expect(task.error).toContain('音频格式错误');
  });
});
