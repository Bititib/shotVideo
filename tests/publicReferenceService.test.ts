import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { publishReferenceBytes, publishReferenceUrl } from '../server/services/publicReferenceService.js';
import { publicReferences } from '../server/middleware/publicReferences.js';
import { buildHmStudioImageForm, buildHmStudioVideoForm } from '../server/services/hmStudioAdapter.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6O1sAAAAASUVORK5CYII=', 'base64');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-references-test-'));
let server: Server, base: string;
beforeAll(async () => {
  vi.stubEnv('PUBLIC_REFERENCE_DIR', path.join(directory, 'public'));
  const app = express(); app.use('/reference-assets', publicReferences());
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true });
});
describe('public reference URL pipeline', () => {
  it('publishes random stable URLs with anonymous GET, HEAD, Range and no signature expiry', async () => {
    const url = publishReferenceBytes(png, 'image/png', base);
    expect(new URL(url).pathname).toMatch(/^\/reference-assets\/[a-f0-9-]{36}\.png$/);
    expect(new URL(url).search).toBe('');
    expect(publishReferenceBytes(png, 'image/png', base)).toBe(url);
    const response = await fetch(url + '?expires=1&signature=expired');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(200);
    const partial = await fetch(url, { headers: { Range: 'bytes=0-7' } });
    expect(partial.status).toBe(206); expect((await partial.arrayBuffer()).byteLength).toBe(8);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(base + '/reference-assets/')).status).toBe(404);
  });
  it('sends only URLs to HM for image/video/audio materials and image editing', async () => {
    const inputs = [png, Buffer.from('0000ftypisom video'), Buffer.from('RIFF0000WAVE audio')];
    const asData = (bytes: Buffer, mime: string) => `data:${mime};base64,${bytes.toString('base64')}`;
    const form = buildHmStudioVideoForm({ model: 'SD2.0FAST813', prompt: 'test', duration: 10, ratio: '16:9', resolution: '720p',
      imageSources: [asData(inputs[0], 'image/png')], videoSources: [asData(inputs[1], 'video/mp4')],
      audioSources: [asData(inputs[2], 'audio/wav')], localMediaBaseUrl: base });
    expect(form.get('channel')).toBe('lumen');
    for (const [, value] of form.entries()) expect(typeof value).toBe('string');
    const materials = JSON.parse(String(form.get('materials')));
    expect(materials.map((m: any) => m.type)).toEqual(['image', 'video', 'audio']);
    for (let index = 0; index < materials.length; index++) {
      const response = await fetch(materials[index].url);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(inputs[index]);
    }
    const image = buildHmStudioImageForm({ model: 'jimen-5.0', prompt: 'test', ratio: '1:1', localMediaBaseUrl: base,
      imageSources: [asData(png, 'image/png')] });
    expect(image.has('images')).toBe(false);
    expect((await fetch(String(image.get('image_url')))).status).toBe(200);
  });
  it('republishes authorized historical files and strips only our obsolete signature', () => {
    const root = path.join(directory, 'uploads'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'source.png'), png);
    const url = publishReferenceUrl(`${base}/api/uploads/source.png?expires=1&signature=old`, base, root);
    expect(url).toBe(publishReferenceBytes(png, 'image/png', base));
    expect(() => publishReferenceUrl('/uploads/%2e%2e/secret.png', base, root)).toThrow('路径');
    expect(() => publishReferenceUrl('/uploads/missing.png', base, root)).toThrow('不存在');
    const remote = 'https://cdn.example.test/image.png?requiredSignature=x';
    expect(publishReferenceUrl(remote, base)).toBe(remote);
  });
  it('rejects active content and invalid base URLs instead of exposing arbitrary files', () => {
    expect(() => publishReferenceBytes(Buffer.from('<html>bad</html>'), 'image/png', base)).toThrow('无效');
    expect(() => publishReferenceBytes(png, 'image/png', '')).toThrow('BACKEND_URL');
    expect(() => publishReferenceUrl('file:///etc/passwd', base)).toThrow('路径');
    expect(() => publishReferenceUrl('https://user:secret@example.test/a.png', base)).toThrow('账号密码');
  });
});
