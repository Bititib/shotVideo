import { describe, expect, it, vi } from 'vitest';
import { imageRequestDiagnostic, logImageRequestFailure } from '../server/services/imageRequestDiagnostics';
describe('图片分阶段安全日志', () => {
  it('记录任务关联、HTTP 状态及嵌套网络错误，不输出原始错误内容', () => {
    const error = Object.assign(new TypeError('fetch failed https://cdn.test/a?X-Amz-Signature=secret sk-secret-key'), {
      status: 502, cause: { code: 'UND_ERR_SOCKET', cause: { code: 'ECONNRESET', authorization: 'Bearer secret' } },
    });
    const result = imageRequestDiagnostic({ stage: 'download', contentId: 12673, channelId: 5, taskId: 'task_abc', index: 0 }, error);
    expect(result).toMatchObject({ stage: 'download', contentId: 12673, taskId: 'task_abc', httpStatus: 502, networkCodes: ['UND_ERR_SOCKET', 'ECONNRESET'] });
    expect(JSON.stringify(result)).not.toMatch(/secret|cdn\.test|Bearer|Signature/);
  });
  it('提取 AggregateError 中 DNS 和连接超时原因，允许循环 cause', () => {
    const cause: any = { errors: [{ code: 'ENOTFOUND' }, { code: 'ETIMEDOUT' }] }; cause.cause = cause;
    expect(imageRequestDiagnostic({ stage: 'submit' }, { cause }).networkCodes).toEqual(['ENOTFOUND', 'ETIMEDOUT']);
  });
  it('过滤意外落入 ID 和 code 的密钥及 URL', () => {
    const result = imageRequestDiagnostic({ stage: 'poll', taskId: 'https://cdn/a?sig=secret' }, { code: 'sk-secret' });
    expect(result.taskId).toBeUndefined(); expect(result.networkCodes).toEqual([]);
  });
  it.each([['submit', '提交失败'], ['poll', '查询失败'], ['download', '下载失败']] as const)('%s 使用独立日志标签', (stage, label) => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { logImageRequestFailure({ stage, contentId: 12 }, new Error('private payload')); expect(spy).toHaveBeenCalledWith(`[image-request] ${label}`, expect.stringContaining('"contentId":12')); }
    finally { spy.mockRestore(); }
  });
});
