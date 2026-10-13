// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatedImageReference, imageReferenceLimit, type ImageModel } from '../client/src/api/imageGen';
import { defaultRoutingLimits } from '../shared/modelRouting';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
describe('image reference capabilities and authenticated reuse', () => {
  it('uses accurate limits even for older cached models', () => {
    const model = (id: string) => ({ id, name: id, description: '', available: true });
    expect(imageReferenceLimit(model('gpt-image-2'))).toBe(5);
    expect(imageReferenceLimit(model('gpt-image-2-siyuetian'))).toBe(9);
    expect(imageReferenceLimit(model('gpt-image-2-mingfei'))).toBe(16);
    for (const id of ['gpt-image-2.5-flare', 'nano-banana-2.1', 'nano-banana-2-lite']) expect(imageReferenceLimit(model(id))).toBe(0);
    const managed: ImageModel = { ...model('custom-image-4k'), maxReferenceImages: 5, routingLimits: { ...defaultRoutingLimits(), maxImages: 16 } };
    expect(imageReferenceLimit(managed)).toBe(16);
  });

  it('preserves signed result URLs and authenticates their download', async () => {
    localStorage.setItem('token', 'test-only-token');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) });
    vi.stubGlobal('fetch', fetchMock);
    const url = '/api/uploads/result.png?signature=a%2Fb&expires=123';
    expect(await generatedImageReference(url)).toMatch(/^data:image\/png;base64,/);
    expect(fetchMock).toHaveBeenCalledWith('/api/image-gen/download?url=' + encodeURIComponent(url), { headers: { Authorization: 'Bearer test-only-token' } });
  });

  it('downloads protected media from its original endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image'], { type: 'image/jpeg' }) });
    vi.stubGlobal('fetch', fetchMock);
    await generatedImageReference('/api/media/42');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/media/42');
  });

  it('does not fetch images already stored as data URLs', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(await generatedImageReference('data:image/png;base64,aA==')).toBe('data:image/png;base64,aA==');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects inaccessible results and non-image downloads', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['expired'], { type: 'text/html' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(generatedImageReference('/api/uploads/gone.png')).rejects.toThrow('原图读取失败');
    await expect(generatedImageReference('/api/uploads/gone.png')).rejects.toThrow('不是有效图片');
  });
});
