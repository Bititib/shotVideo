import { describe, expect, it } from 'vitest';
import { formatModelPrice, modelExample } from '../client/src/utils/apiModelExamples';
import type { DeveloperModel } from '../shared/developerModels';
import { defaultRoutingLimits } from '../shared/modelRouting';

const model: DeveloperModel = { id: "自定义 '视频", canonicalId: 'test-video', name: 'Video', description: '', kinds: ['video'], endpoints: ['/v1/videos'], limits: { ...defaultRoutingLimits(), minImages: 2, maxImages: 9, duration: { mode: 'fixed', min: 30, max: 30, values: [], step: 1 } }, pricing: null, available: true, health: null };
describe('model-specific API examples', () => {
  it('uses the callable ID, exact duration and required references, with safe shell quoting', () => {
    const code = modelExample(model, '/v1/videos', 'https://test.invalid', 'curl');
    expect(code).toContain('"seconds": 30');
    expect(code).toContain('reference-2.png');
    expect(code).toContain("'\"'\"'");
    expect(code).toContain('GET /v1/videos/{task_id}');
    expect(code).toContain('Idempotency-Key: REPLACE-WITH-A-UNIQUE-TASK-KEY');
    const python = modelExample(model, '/v1/videos', 'https://test.invalid', 'python');
    expect(python).toContain('request_key = str(uuid.uuid4())');
    expect(python).toContain('"Idempotency-Key": request_key');
    expect(modelExample(model, '/v1/images/generations', 'https://test.invalid', 'curl')).not.toContain('Idempotency-Key');
  });
  it('builds multipart image edits for both languages', () => {
    expect(modelExample(model, '/v1/images/edits', 'https://test.invalid', 'curl')).toContain('-F "image=@/path/to/reference.png"');
    expect(modelExample({ ...model, id: '@model-name' }, '/v1/images/edits', 'https://test.invalid', 'curl')).toContain("--form-string 'model=@model-name'");
    expect(modelExample(model, '/v1/images/edits', 'https://test.invalid', 'python')).toContain('files={"image": image}');
  });
  it('distinguishes missing prices from zero prices and renders token units', () => {
    expect(formatModelPrice(null)).toBe('价格未配置');
    expect(formatModelPrice({ billing_type: 'per_second', unit: 'second', unit_price: 0, output_unit_price: 0, resolution_prices: {}, currency: 'CNY' })).toBe('¥0 / 秒');
    expect(formatModelPrice({ billing_type: 'per_token', unit: 'million_tokens', unit_price: 1, output_unit_price: 2, resolution_prices: {}, currency: 'CNY' })).toBe('输入 ¥1 / 输出 ¥2 · 百万 Token');
  });
});
