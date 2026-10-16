import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ row: null as any, poll: vi.fn(), localize: vi.fn(), finalize: vi.fn(), run: vi.fn() }));
vi.mock('../server/db/index.js', () => ({ sqlite: { prepare: () => ({ get: () => mocks.row, run: mocks.run }) } }));
vi.mock('../server/services/channelService.js', () => ({ ChannelService: { getChannelRaw: () => ({ baseUrl: 'https://pidoi.com', apiKey: 'test' }) } }));
vi.mock('../server/services/pidoiImageAdapter.js', () => ({ pollPidoiImage: mocks.poll }));
vi.mock('../server/services/pidoiImageStorage.js', () => ({ localizeRecoveredImages: mocks.localize }));
vi.mock('../server/services/contentBillingService.js', () => ({ finalizeReservedContent: mocks.finalize }));
import { recoverPidoiImage, pidoiImageActive } from '../server/services/pidoiImageWorker';
beforeEach(() => {
  vi.clearAllMocks(); pidoiImageActive.clear();
  mocks.row = { id: 12, user_id: 2, status: 'processing', metadata: JSON.stringify({ imageProtocol: 'pidoi-async-v1', count: 1,
    channelId: 5, progresses: [0], publicBaseUrl: 'https://local.test', pidoiImageJobs: [{ taskId: 'task_saved', index: 0 }] }) };
  mocks.localize.mockResolvedValue({ urls: ['/api/uploads/result.png'], issues: [] });
});
describe('Pidoi 原任务恢复', () => {
  it('查询网络失败日志保留任务关联和底层原因', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.poll.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
      await recoverPidoiImage(12);
      expect(spy).toHaveBeenCalledWith('[image-request] 查询失败', expect.stringContaining('"taskId":"task_saved"'));
      expect(spy.mock.calls[0][1]).toContain('ECONNRESET');
    } finally { spy.mockRestore(); }
  });
  it('下载网络失败不误标成查询失败，保留下载 cause', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.poll.mockResolvedValue({ status: 'completed', progress: 100, imageUrl: 'https://cdn/a?secret=yes' });
      mocks.localize.mockResolvedValue({ urls: [], issues: ['failed'], failures: [Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } })] });
      await recoverPidoiImage(12);
      expect(spy).toHaveBeenCalledWith('[image-request] 下载失败', expect.stringContaining('ETIMEDOUT'));
      expect(JSON.stringify(spy.mock.calls)).not.toContain('secret');
      expect(mocks.finalize).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('恢复保存的 ID，落盘后才结算，签名链接不关联密钥', async () => {
    mocks.poll.mockResolvedValue({ status: 'completed', progress: 100, imageUrl: 'https://cdn/result.png' });
    await recoverPidoiImage(12);
    expect(mocks.poll).toHaveBeenCalledWith(expect.anything(), 'task_saved');
    expect(mocks.localize).toHaveBeenCalledWith([{ url: 'https://cdn/result.png', channelId: 0, channelApiKeyId: null }], 12, 2, 'https://local.test');
    expect(mocks.finalize).toHaveBeenCalledWith(12, 'completed', expect.objectContaining({ imageUrls: ['/api/uploads/result.png'] }), '/api/uploads/result.png');
  });
  it('网络错误不退款、不重提，下一次扫描仍能查询', async () => {
    mocks.poll.mockRejectedValue(new Error('network'));
    await recoverPidoiImage(12);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(pidoiImageActive.has(12)).toBe(false);
  });
  it('确认失败才退款', async () => {
    mocks.poll.mockResolvedValue({ status: 'failed', progress: 100, error: 'failed' });
    await recoverPidoiImage(12);
    expect(mocks.finalize).toHaveBeenCalledWith(12, 'failed', expect.objectContaining({ failureReason: 'failed' }));
    expect(mocks.localize).not.toHaveBeenCalled();
  });
  it('仍在提交中的任务不会被恢复器抢占', async () => {
    pidoiImageActive.add(12);
    await recoverPidoiImage(12);
    expect(mocks.poll).not.toHaveBeenCalled();
  });
  it('没有任务 ID 的历史记录不会重新提交', async () => {
    mocks.row.metadata = '{}';
    await recoverPidoiImage(12);
    expect(mocks.poll).not.toHaveBeenCalled();
  });
  it('兼容接口已经返回图片时直接下载原结果，不轮询空 ID 或跟踪用的 request ID', async () => {
    for (const taskId of ['', 'request_trace']) {
      mocks.row.metadata = JSON.stringify({ imageProtocol: 'pidoi-async-v1', count: 1, channelId: 5,
        progresses: [0], publicBaseUrl: 'https://local.test', pidoiImageJobs: [{ taskId, index: 0,
          protocol: 'openai-compatible', status: 'completed', sourceUrl: 'https://cdn/signed.png' }] });
      await recoverPidoiImage(12);
    }
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(mocks.localize).toHaveBeenCalledTimes(2);
    expect(mocks.finalize).toHaveBeenCalledWith(12, 'completed', expect.anything(), '/api/uploads/result.png');
  });
});
