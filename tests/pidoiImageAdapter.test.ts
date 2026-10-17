import { afterEach, describe, it, expect, vi } from 'vitest';
import { isPidoiImageChannel, parsePidoiImageTask, submitPidoiImage, pollPidoiImage } from '../server/services/pidoiImageAdapter';
const channel = { baseUrl: 'https://pidoi.com/v1/', apiKey: 'test-key' };
const response = (data: any) => new Response(JSON.stringify({ code: 'success', data }));
afterEach(() => vi.restoreAllMocks());
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
  it('单数路由明确不存在时使用与 API 相同的复数入口，解析 URL 且不伪造任务 ID', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response('404 page not found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: [{ url: 'https://storage/result.png?sig=test' }] }));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const task = await submitPidoiImage({ ...channel, timeout: 120_000 }, { model: 'gpt-image-2', prompt: 'cat', n: 1, quality: 'high' }, f);
    expect(f.mock.calls.map(call => call[0])).toEqual(['https://pidoi.com/v1/image/generations', 'https://pidoi.com/v1/images/generations']);
    expect(task).toMatchObject({ taskId: '', status: 'completed', protocol: 'openai-compatible', imageUrl: 'https://storage/result.png?sig=test' });
    expect(timeout).toHaveBeenCalledWith(900_000);
  });
  it('兼容图生图使用原始参考图 FormData，保持多图和重复位置', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    const sources = ['data:image/png;base64,aA==', 'data:image/png;base64,aA=='];
    const task = await submitPidoiImage(channel, { model: 'gpt-image-2', images: ['https://local/ref1', 'https://local/ref1'], n: 1, quality: 'high' }, f, { referenceImages: sources });
    const init = f.mock.calls[1][1];
    expect(f.mock.calls[1][0]).toBe('https://pidoi.com/v1/images/edits');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.getAll('image[]')).toHaveLength(2);
    expect(init.headers).toEqual({ Authorization: 'Bearer test-key' });
    expect(task.imageUrl).toBe('data:image/png;base64,aW1hZ2U=');
    expect(f).toHaveBeenCalledTimes(2);
  });
  it.each([400, 401, 403, 429, 451])('明确拒绝 %s 可以退款，但不切换入口重提', async status => {
    const f = vi.fn().mockResolvedValue(new Response('rejected', { status }));
    await expect(submitPidoiImage(channel, {}, f)).rejects.toMatchObject({ confirmedFailure: true, status });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it.each([408, 500, 502, 504])('不确定错误 %s 不退款、不切换入口', async status => {
    const f = vi.fn().mockResolvedValue(new Response('gateway failure', { status }));
    await expect(submitPidoiImage(channel, {}, f)).rejects.toMatchObject({ confirmedFailure: false });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('带已受理任务 ID 的 451 和查询 451 仍不能认定生成失败', async () => {
    const submit = vi.fn().mockResolvedValue(Response.json({ task_id: 'task_accepted', error: { code: 'content_policy_violation' } }, { status: 451 }));
    await expect(submitPidoiImage(channel, {}, submit)).resolves.toMatchObject({ status: 'processing', taskId: 'task_accepted' });
    expect(submit).toHaveBeenCalledTimes(1);
    const poll = vi.fn().mockResolvedValue(new Response('Unavailable', { status: 451 }));
    await expect(pollPidoiImage(channel, 'task_existing', poll)).rejects.toMatchObject({ confirmedFailure: false });
    expect(poll).toHaveBeenCalledTimes(1);
  });
  it('model-not-found、带任务 ID 的 404 和查询 404 都不能触发重新提交', async () => {
    for (const raw of [{ error: { message: 'Model not found' } }, { task_id: 'task_accepted', message: 'Not Found' }]) {
      const f = vi.fn().mockResolvedValue(Response.json(raw, { status: 404 }));
      if ('task_id' in raw) await expect(submitPidoiImage(channel, {}, f)).resolves.toMatchObject({ taskId: 'task_accepted', status: 'processing' });
      else await expect(submitPidoiImage(channel, {}, f)).rejects.toThrow();
      expect(f).toHaveBeenCalledTimes(1);
    }
    const f = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 }));
    await expect(pollPidoiImage(channel, 'task_existing', f)).rejects.toMatchObject({ confirmedFailure: false });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('兼容入口超时后也不重提，并保留原网络错误原因', async () => {
    const cause = { code: 'ETIMEDOUT' };
    const f = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause }));
    await expect(submitPidoiImage(channel, {}, f)).rejects.toMatchObject({ cause, imageRequestStage: 'submit' });
    expect(f).toHaveBeenCalledTimes(2);
  });
});
