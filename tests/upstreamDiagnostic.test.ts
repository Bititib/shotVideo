import { describe, it, expect } from 'vitest';
import { responseDiagnostic } from '../server/services/upstreamDiagnostic.js';
import { publicGenerationError } from '../shared/generationMessages.js';
import { normalizeLongxiaVideoTask } from '../server/services/longxiaVideoAdapter.js';
describe('upstream diagnostics', () => {
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
