import { describe, expect, it } from 'vitest';
import { publicApiDiagnostics, publicApiErrorReason } from '../server/services/publicApiDiagnostics';
import { publicApiErrorResponse } from '../server/middleware/publicApiErrorResponse';

describe('public API diagnostic projection', () => {
  it.each(['funai', 'HM Studio', 'Megaby', 'V6K', 'unknown-private-provider'])('removes %s diagnostic envelopes in every response field', provider => {
    const raw = `所有候选线路均未完成提交：[上游诊断 ${provider} 提交] HTTP 403 code=insufficient_user_quota request_id=provider-123：insufficient_user_quota: 用户额度不足`;
    const body = { id: 'task_req_public', status: 'failed', error: raw, error_message: raw, progress_text: raw,
      message: raw, billing_status: 'refunded', refund_amount: 0.6 };
    const safe = publicApiDiagnostics(body);
    for (const field of ['error', 'error_message', 'progress_text', 'message']) {
      expect(safe[field]).not.toContain(provider);
      expect(safe[field]).not.toMatch(/上游诊断|provider-123|候选线路/);
      expect(safe[field]).toContain('insufficient_user_quota');
      expect(safe[field]).toContain('用户额度不足');
      expect(safe[field]).toContain('HTTP 403');
    }
    expect(safe).toMatchObject({ id: body.id, status: 'failed', billing_status: 'refunded', refund_amount: 0.6 });
    expect(body.error).toBe(raw);
    expect(publicApiDiagnostics(safe)).toEqual(safe);
  });

  it('hides configured private names, URLs and nested wrappers without losing the rejection cause', () => {
    const raw = '[上游诊断 FooBank 查询] HTTP 503：[上游诊断 [服务] 下载] HTTP 403 code=ImageRejected：FOOBANK: image 3 rejected https://private.invalid/path?token=secret sk-private-key';
    const result = publicApiErrorReason(raw, ['FooBank']);
    expect(result).not.toMatch(/FooBank|上游诊断|private\.invalid|secret|sk-private-key/i);
    expect(result).toContain('ImageRejected'); expect(result).toContain('image 3 rejected');
    expect(publicApiErrorReason('[上游诊断 private-truncated')).not.toContain('private-truncated');
    expect(publicApiErrorReason('Private Orion [渠道配置已隐藏] image 2 invalid', ['Private Orion Channel'])).not.toContain('Private Orion');
  });

  it('keeps the standard error schema and public identifiers while omitting arbitrary provider payloads', () => {
    const body = { request_id: 'public-request', error: { code: 'invalid_image', type: 'invalid_request_error', param: 'images',
      message: 'privateName: image 2 is unsupported', provider: 'privateName', request: { api_key: 'PRIVATE' } },
      channel_name: 'privateName', upstream_task_id: 'private-job', upstream_model: 'private-execution', channelId: 7 };
    const safe = publicApiDiagnostics(body);
    expect(safe).toEqual({ request_id: 'public-request', error: { code: 'invalid_image', type: 'invalid_request_error', param: 'images', message: '[服务]: image 2 is unsupported' } });
    expect(body.error.request.api_key).toBe('PRIVATE');
    const nested = publicApiDiagnostics({ error: { code: 'PoolBusy', provider: 'SecretPool', message: 'SecretPool cannot accept this request' } });
    expect(nested.error).toEqual({ code: 'PoolBusy', message: '[服务] cannot accept this request' });
    expect(publicApiDiagnostics(nested)).toEqual(nested);
  });

  it('covers historical usage rows and nested task diagnostics, leaving generated content and result URLs alone', () => {
    const body = { items: [{ error_message: '[上游诊断 funai 提交] HTTP 403：余额不足', upstream_model: 'private-model' }],
      data: [{ url: 'https://site.example/result.png' }], choices: [{ message: { content: 'funai is part of this generated text' } }],
      model: 'public-model', progress: 45, status_url: 'https://site.example/v1/videos/task_1' };
    const safe = publicApiDiagnostics(body);
    expect(JSON.stringify(safe.items)).not.toContain('funai');
    expect(safe.items[0].error_message).toContain('余额不足');
    expect(safe.data).toEqual(body.data); expect(safe.choices).toEqual(body.choices);
    expect(safe.status_url).toBe(body.status_url); expect(safe.progress).toBe(45);
  });

  it('handles unknown errors and review messages without inventing failure, retry or refund conclusions', () => {
    for (const text of ['ECONNRESET：提交结果待核实，请勿重复提交', 'Busy: 查询暂时不可用，费用保留', 'unknown-new-code: image 4 cannot be decoded']) {
      const safe = publicApiErrorReason(text);
      expect(safe).toContain(text.split('：')[0].split(':')[0]);
      expect(safe).not.toContain('已退款');
    }
    expect(publicApiErrorReason('invalid seconds: choose 5 or 10')).toBe('invalid seconds: choose 5 or 10');
  });

  it('projects outgoing JSON without mutating admin diagnostics, HTTP status or successful responses', () => {
    const body = { status: 'failed', error: '[上游诊断 funai 提交] HTTP 403：余额不足' };
    let sent: any;
    const res: any = { statusCode: 502, json(value: any) { sent = value; return this; } };
    publicApiErrorResponse(() => ['funai'])({} as any, res, () => {});
    res.json(body);
    expect(sent.error).not.toContain('funai'); expect(res.statusCode).toBe(502);
    expect(body.error).toContain('funai');
    const success = { status: 'completed', url: 'https://site.example/result.mp4', cost: 0.6 };
    res.json(success); expect(sent).toEqual(success);
  });
});
