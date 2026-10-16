import { describe, it, expect, vi } from 'vitest';
import { isPidoiImageChannel, parsePidoiImageTask, submitPidoiImage, pollPidoiImage } from '../server/services/pidoiImageAdapter';
const channel = { baseUrl: 'https://pidoi.com/v1/', apiKey: 'test-key' };
const response = (data: any) => new Response(JSON.stringify({ code: 'success', data }));
describe('Pidoi 异步图片协议', () => {
  it('只匹配 Pidoi 域名，不影响四月天', () => {
    expect(isPidoiImageChannel(channel)).toBe(true);
    expect(isPidoiImageChannel({ baseUrl: 'https://llm.chre3.com' })).toBe(false);
    expect(isPidoiImageChannel({ baseUrl: 'https://pidoi.com.evil.test' })).toBe(false);
  });
  it('文生图和参考图使用单数 JSON 端点并保留顺序', async () => {
    const f = vi.fn().mockResolvedValue(response({ task_id: 'task_abc', status: 'IN_PROGRESS', progress: '50%' }));
    const body = { model: 'gpt-image-2', prompt: '测试', images: ['https://cdn/a', 'https://cdn/a'], resolution: '4K', aspect_ratio: '16:9', n: 1 };
    expect(await submitPidoiImage(channel, body, f)).toMatchObject({ taskId: 'task_abc', status: 'processing', progress: 50 });
    expect(f).toHaveBeenCalledWith('https://pidoi.com/v1/image/generations', expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }));
  });
  it('恢复只 GET 原任务并解析签名结果地址', async () => {
    const f = vi.fn().mockResolvedValue(response({ task_id: 'task_abc', status: 'SUCCESS', progress: '100%', result_url: 'https://cdn/result.png?sig=a' }));
    expect(await pollPidoiImage(channel, 'task_abc', f)).toMatchObject({ status: 'completed', imageUrl: 'https://cdn/result.png?sig=a' });
    expect(f).toHaveBeenCalledWith('https://pidoi.com/v1/image/generations/task_abc', expect.objectContaining({ method: 'GET' }));
  });
  it('外层 success 不等于任务成功', () => {
    expect(parsePidoiImageTask({ code: 'success', data: { status: 'FAILURE', fail_reason: '审核失败' } })).toMatchObject({ status: 'failed', error: '审核失败' });
    expect(() => parsePidoiImageTask({ code: 'task_not_exist', message: '任务不存在', data: null })).toThrow('任务不存在');
  });
  it('提交超时不重试，缺失 ID 不伪造任务', async () => {
    const f = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(submitPidoiImage(channel, {}, f)).rejects.toThrow('timeout');
    expect(f).toHaveBeenCalledTimes(1);
    await expect(submitPidoiImage(channel, {}, vi.fn().mockResolvedValue(response({ status: 'IN_PROGRESS' })))).rejects.toThrow('未返回任务 ID');
  });
});
