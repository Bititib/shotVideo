import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema.js');
  const sqlite = new Database(':memory:');
  for (const table of Object.values(schema)) {
    try {
      const config = getTableConfig(table as any);
      sqlite.exec(`CREATE TABLE IF NOT EXISTS "${config.name}" (${config.columns.map(c => `"${c.name}" ${c.getSQLType()}${c.primary ? ' PRIMARY KEY' : ''}`).join(',')})`);
    } catch { /* Relations are not tables. */ }
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
});
vi.mock('../server/services/channelService.js', () => {
  const channel = { id: 6, type: 'openai', name: 'Pidoi 图片渠道', baseUrl: 'https://pidoi.com', apiKey: 'test-key', timeout: 120_000, modelMapping: {} };
  return { ChannelService: { findChannelsForModel: () => [channel], getChannelRaw: () => channel } };
});
vi.mock('../server/services/pricingService.js', () => ({ PricingService: { quote: (_model: string, input: any) => ({ cost: (input.count || 1) * 0.22 }) } }));
vi.mock('../server/services/pidoiImageStorage.js', () => ({ localizeRecoveredImages: vi.fn() }));
vi.mock('../server/services/specificationGenerationService.js', () => ({ handleSpecificationGeneration: async () => false }));
vi.mock('../server/middleware/quota.js', () => ({ quotaMiddleware: vi.fn(), logUsage: vi.fn() }));
import { sqlite } from '../server/db/index.js';
import router from '../server/routes/imageGen.js';
import { localizeRecoveredImages } from '../server/services/pidoiImageStorage.js';
import { recoverPidoiImage, pidoiImageActive } from '../server/services/pidoiImageWorker.js';
import { generateSpecificationImage } from '../server/services/specificationAdapters.js';

function row() { return sqlite.prepare('SELECT * FROM contents ORDER BY id DESC LIMIT 1').get() as any; }
function balance() { return (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance; }
function reservation() { return sqlite.prepare('SELECT * FROM billing_reservations ORDER BY id DESC LIMIT 1').get() as any; }
async function generate() {
  const layer = router.stack.find((layer: any) => layer.route?.path === '/generate' && layer.route.methods.post) as any;
  const chunks: string[] = [];
  const res: any = { setHeader: vi.fn(), flushHeaders: vi.fn(), write: (chunk: string) => chunks.push(chunk),
    end: () => { res.writableEnded = true; }, status: (code: number) => { res.code = code; return res; }, json: vi.fn() };
  const req: any = { userId: 1, body: { model: 'gpt-image-2', prompt: 'cat', quality: 'high', resolution: '4K', n: 1 }, protocol: 'https', get: () => 'local.test', headers: {}, socket: {} };
  await layer.route.stack.at(-1).handle(req, res, () => {});
  return { res, chunks };
}
beforeEach(() => {
  sqlite.exec(`DELETE FROM users; DELETE FROM contents; DROP TABLE IF EXISTS billing_reservations;
    INSERT INTO users(id,balance) VALUES(1,100);`);
  vi.mocked(localizeRecoveredImages).mockResolvedValue({ urls: ['/api/uploads/result.png'], issues: [], failures: [] });
});
afterEach(async () => {
  await vi.waitFor(() => expect(pidoiImageActive.size).toBe(0));
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('Pidoi 网页提交到保存和结算', () => {
  it('异步入口不存在时，网站使用与 API 相同的入口生成并下载，最终同步成功', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('404 page not found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: [{ url: 'https://storage.test/cat.png?signature=x' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { res, chunks } = await generate();
    expect(res.writableEnded).toBe(true);
    expect(chunks.join('')).toContain('"background":true');
    await vi.waitFor(() => expect(row().status).toBe('completed'));
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://pidoi.com/v1/image/generations', 'https://pidoi.com/v1/images/generations']);
    const metadata = JSON.parse(row().metadata);
    expect(metadata.upstreamTaskIds).toEqual([]);
    expect(metadata.upstreamResponses[0]).toMatchObject({ httpStatus: 200, state: 'response_without_id' });
    expect(metadata.pidoiImageJobs[0]).toMatchObject({ protocol: 'openai-compatible', sourceUrl: 'https://storage.test/cat.png?signature=x' });
    expect(row().result_url).toBe('/api/uploads/result.png');
    expect(balance()).toBeCloseTo(99.78);
    expect(reservation()).toMatchObject({ state: 'settled', actual: 0.22 });
  });

  it('明确拒绝后结束失败并全额退款，不再卡在待核实', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { message: 'Model not found' } }, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await generate();
    await vi.waitFor(() => expect(row().status).toBe('failed'));
    expect(JSON.parse(row().metadata).submissionFailure).toMatchObject({ httpStatus: 404, confirmedFailure: true });
    expect(reservation().state).toBe('refunded');
    expect(balance()).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localizeRecoveredImages).not.toHaveBeenCalled();
  });

  it('兼容入口返回 403 后同样退款，不再尝试第三次提交', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'Invalid token' } }, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await generate();
    await vi.waitFor(() => expect(row().status).toBe('failed'));
    expect(reservation().state).toBe('refunded');
    expect(balance()).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('传输中断只核实原请求，不自动退款和重新生成', async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    vi.stubGlobal('fetch', fetchMock);
    await generate();
    await vi.waitFor(() => expect(row().status).toBe('review'));
    expect(balance()).toBeCloseTo(99.78);
    expect(reservation().state).toBe('review');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('图片下载失败保存原结果，下次恢复只下载，不重新生成', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: [{ url: 'https://storage.test/cat.png' }] }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(localizeRecoveredImages).mockResolvedValueOnce({ urls: [], issues: ['download error'], failures: [new Error('fetch failed')] });
    await generate();
    await vi.waitFor(() => expect(pidoiImageActive.size).toBe(0));
    expect(row().status).toBe('processing');
    expect(reservation().state).toBe('reserved');
    expect(JSON.parse(row().metadata).upstreamImageUrls).toEqual(['https://storage.test/cat.png']);
    await recoverPidoiImage(row().id);
    expect(row().status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localizeRecoveredImages).toHaveBeenCalledTimes(2);
    expect(reservation().state).toBe('settled');
  });

  it('规格路由也能处理同样的 404 兼容入口，记录同步响应证据', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: [{ url: 'https://storage.test/cat.png' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const evidence = vi.fn(), submitted = vi.fn();
    const result = await generateSpecificationImage({ channel: { id: 6, baseUrl: 'https://pidoi.com', apiKey: 'test-key' },
      route: { executionModel: 'gpt-image-2', upstreamModel: 'gpt-image-2' } } as any,
    { prompt: 'cat', input: { ratio: '1:1', resolution: '4K' }, images: [], videos: [], audios: [], firstFrame: '', lastFrame: '', body: {}, publicBaseUrl: 'https://local.test' } as any,
    vi.fn(), submitted, evidence);
    expect(result.imageUrl).toBe('https://storage.test/cat.png');
    expect(submitted).not.toHaveBeenCalled();
    expect(evidence).toHaveBeenLastCalledWith({ id: '', httpStatus: 200, state: 'response_without_id' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
