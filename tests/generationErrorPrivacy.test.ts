import { describe, expect, it } from 'vitest';
import { publicGenerationError, publicGenerationEvent } from '../shared/generationMessages';
import { generationErrorResponse } from '../server/middleware/generationErrorResponse';

const moderation = 'task failed, code: DataInspectionFailed , message: Green net check rejected image (input)';

describe('display-only upstream error privacy', () => {
  it.each([
    moderation,
    'AudioCopyrightRejected: reference audio is restricted',
    'model foo supports duration_seconds values 5, 10, 15',
    'No available channel for model grok-imagine-video-1.5 under group default',
    'UnknownNewProviderError: please replace image 3',
    '输入图片包含不支持的人物，请更换图片',
    'Too many requests; retry after 30 seconds',
    'Insufficient balance. Required: ¥0.60, Current: ¥0.20',
  ])('retains useful original cause: %s', text => {
    expect(publicGenerationError(text)).toBe(text);
    expect(publicGenerationError(publicGenerationError(text))).toBe(text);
  });
  it('extracts structured, nested, and prefixed JSON without serializing private fields', () => {
    const payload = {error:{code:'DataInspectionFailed', message:'Green net check rejected image (input)'},
      provider:'private-provider', request:{prompt:'PRIVATE_PROMPT'}, api_key:'SECRET', stack:'PRIVATE_STACK'};
    for (const value of [payload, JSON.stringify(payload), '上游提交失败 (400)：' + JSON.stringify(payload), {data:payload}]) {
      expect(publicGenerationError(value)).toBe('DataInspectionFailed: Green net check rejected image (input)');
    }
    expect(payload.request.prompt).toBe('PRIVATE_PROMPT');
  });
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'], ['Basic YWJjOnNlY3JldA==', 'YWJjOnNlY3JldA=='],
    ['sk-super-secret', 'sk-super-secret'], ['api_key="TOP_SECRET"', 'TOP_SECRET'],
    ['password: TOP_SECRET', 'TOP_SECRET'], ['Cookie: sid=TOP_SECRET; session=OTHER_SECRET', 'OTHER_SECRET'],
    ['signature=TOP_SECRET', 'TOP_SECRET'], ['密钥: TOP_SECRET', 'TOP_SECRET'],
    ['https://private.invalid/media.mp4?Signature=TOP_SECRET', 'private.invalid'],
    ['http://user:pass@10.0.0.1:3000/api', '10.0.0.1'], ['10.2.3.4:3000', '10.2.3.4'],
    ['C:\\Users\\admin\\server.ts:12', 'admin'], ['/app/server/private.ts:12', 'private.ts'],
    ['/uploads/private-reference.png', 'private-reference.png'],
    ['provider=PRIVATE_VENDOR', 'PRIVATE_VENDOR'], ['a.person@example.com', 'example.com'],
    ['input: PRIVATE_PROMPT', 'PRIVATE_PROMPT'], ['payload: {"secret":"TOP_SECRET"}', 'TOP_SECRET'],
  ])('removes sensitive data without discarding the failure: %s', (secret, hidden) => {
    const result = publicGenerationError('DataInspectionFailed: image rejected\n' + secret);
    expect(result).toContain('DataInspectionFailed: image rejected');
    expect(result).not.toContain(hidden);
    expect(publicGenerationError(result)).toBe(result);
  });
  it('drops stack frames, html, malformed JSON, cycles and oversized payloads safely', () => {
    expect(publicGenerationError('image rejected\n    at SecretAdapter.run (internal.js:12:2)')).toBe('image rejected');
    for (const value of ['<!DOCTYPE html><html>PRIVATE</html>', '{"secret":"PRIVATE"', 'x'.repeat(70000)]) {
      expect(publicGenerationError(value)).not.toContain('PRIVATE');
      expect(publicGenerationError(value)).not.toContain('联系管理员');
    }
    const cycle: any = {}; cycle.error = cycle;
    expect(() => publicGenerationError(cycle)).not.toThrow();
    expect(publicGenerationError('failure '.repeat(1000)).length).toBeLessThanOrEqual(2001);
  });
  it('uses contextual channel names while preserving the useful cause', () => {
    expect(publicGenerationError('秘密渠道甲: image rejected', ['秘密渠道甲'])).toBe('[服务]: image rejected');
  });
  it('preserves review guidance, identifiers, financial fields and original diagnostics', () => {
    const event = {type:'error', message:moderation, contentId:14105, billingStatus:'refunded', refundAmount:0.6};
    expect(publicGenerationEvent(event)).toEqual(event);
    expect(publicGenerationError('提交结果待核实：socket hang up')).toContain('请勿重复提交');
    expect(publicGenerationError('查询异常：HTTP 503')).toContain('尚未确认生成失败');
    expect(publicGenerationError('退款处理待核实')).toContain('退款处理待核实');
  });
  it('sanitizes API JSON only, preserving status and billing fields without mutating source', () => {
    const body = {id:'task_123', status:'failed', error:{message:moderation, type:'upstream_error', request:{api_key:'PRIVATE'}},
      billing_status:'refunded', refunded:true, refund_amount:0.6};
    let sent: any;
    const res: any = {statusCode:502, json(value: any) {sent=value;return this;}};
    let nextCalled=false;
    generationErrorResponse({} as any, res, () => {nextCalled=true;});
    res.json(body);
    expect(nextCalled).toBe(true);
    expect(sent).toEqual({...body,error:{message:moderation,type:'upstream_error'}});
    expect(body.error.request.api_key).toBe('PRIVATE');
    expect(res.statusCode).toBe(502);
  });
});
