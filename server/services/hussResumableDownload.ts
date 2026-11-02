import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchHussVideoContent, HussApiError, type HussChannel } from './hussVideoAdapter.js';
import { responseDiagnostic, upstreamDiagnostic } from './upstreamDiagnostic.js';
import { prepareVideoForDelivery } from './videoCompatibilityService.js';

export type HussDownloadProgress = { phase: 'downloading' | 'validating' | 'retrying'; bytes: number; total: number | null; resumable: boolean };
type Receipt = { version: 1; etag: string | null; total: number | null; complete: boolean };
const active = new Map<string, Promise<string>>();
const strongTag = (tag: unknown): tag is string => typeof tag === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(tag);
const length = (value: string | null): number | null => value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

async function checkResponse(response: Response, channel: HussChannel) {
  if (response.ok && response.status !== 202) return;
  const retry = response.headers.get('retry-after') || '';
  const retryAfterMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) || 0;
  const payload = await response.clone().json().catch(() => null);
  if (typeof payload?.Code === 'string' && typeof payload?.Message === 'string') {
    const timing = ['ExpiresSeconds', 'Expires', 'ServerTime'].filter(k => typeof payload[k] === 'string' || typeof payload[k] === 'number').map(k => `${k}=${payload[k]}`).join('; ');
    await response.body?.cancel();
    throw new HussApiError(upstreamDiagnostic('HUSS/TOS', '原任务 /content 下载', {
      code: payload.Code, message: payload.Message + (timing ? '; ' + timing : ''),
    }, channel.apiKey, response.status, payload.RequestId), response.status, false, retryAfterMs);
  }
  throw new HussApiError(await responseDiagnostic('HUSS', response.status === 202 ? '原任务下载仍在准备，继续查询原任务' : '原任务 /content 下载', response, channel.apiKey), response.status, false, retryAfterMs);
}

/** One writer per original task in this app process. Persistent checkpoints survive app restart. */
export function saveHussVideo(channel: HussChannel & { id?: number; apiKeyId?: number | null }, taskId: string,
  finalPrefix: string, onProgress?: (progress: HussDownloadProgress) => void): Promise<string> {
  const identity = crypto.createHash('sha256').update(JSON.stringify([channel.baseUrl, channel.id, channel.apiKeyId, taskId, finalPrefix])).digest('hex');
  const existing = active.get(identity);
  if (existing) return existing;
  const pending = save(channel, taskId, finalPrefix, identity, onProgress);
  active.set(identity, pending);
  void pending.finally(() => { if (active.get(identity) === pending) active.delete(identity); }).catch(() => {});
  return pending;
}

async function save(channel: HussChannel, taskId: string, finalPrefix: string, identity: string,
  onProgress?: (progress: HussDownloadProgress) => void): Promise<string> {
  const directory = path.resolve('data/video-downloads'); // Not under publicly served uploads.
  fs.mkdirSync(directory, { recursive: true });
  const part = path.join(directory, `${identity}.part`);
  const checkpoint = path.join(directory, `${identity}.json`);
  const size = () => fs.existsSync(part) ? fs.statSync(part).size : 0;
  let receipt: Receipt = { version: 1, etag: null, total: null, complete: false };
  try {
    const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
    if (saved.version === 1 && (saved.total === null || Number.isSafeInteger(saved.total) && saved.total > 0))
      receipt = { version: 1, etag: strongTag(saved.etag) ? saved.etag : null, total: saved.total, complete: saved.complete === true };
  } catch { /* No usable checkpoint: start a new read of the original task. */ }
  const persist = () => {
    const temporary = checkpoint + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(receipt));
    fs.renameSync(temporary, checkpoint);
  };
  const report = (phase: HussDownloadProgress['phase'], bytes = size()) => {
    try { onProgress?.({ phase, bytes, total: receipt.total, resumable: Boolean(receipt.etag && receipt.total) }); } catch { /* UI diagnostics cannot discard a download. */ }
  };
  for (const extension of ['mp4', 'webm']) {
    const final = finalPrefix + '.' + extension;
    if (fs.existsSync(final) && fs.statSync(final).size > 0) return prepareVideoForDelivery(final);
  }
  try {
    if (!(receipt.complete && receipt.total === size())) {
      receipt.complete = false;
      const offset = size();
      const range = offset > 0 && receipt.etag && receipt.total && offset < receipt.total
        ? { offset, etag: receipt.etag } : undefined;
      let response = await fetchHussVideoContent(channel, taskId, range);
      // A stale checkpoint / unsupported range cannot be treated as task failure.
      if (range && response.status === 416) {
        await response.body?.cancel();
        response = await fetchHussVideoContent(channel, taskId);
      }
      await checkResponse(response, channel);
      let append = false;
      if (response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        const etag = response.headers.get('etag');
        if (!range || !match || Number(match[1]) !== offset || Number(match[2]) !== Number(match[3]) - 1
          || Number(match[3]) !== receipt.total || etag !== range.etag || response.headers.get('content-encoding')
          || (response.headers.has('content-length') && length(response.headers.get('content-length')) !== receipt.total! - offset)) {
          await response.body?.cancel();
          // Keep bytes, but disable unsafe append for the next attempt.
          receipt.etag = null; persist();
          throw new Error('HUSS 续传响应的文件标识或字节范围不一致，已停止拼接；下次重新读取原成品');
        }
        append = true;
      } else if (response.status === 200) {
        // If-Range mismatch or ignored Range: 200 is a full replacement, never append.
        fs.writeFileSync(part, '');
        receipt = { version: 1, etag: !response.headers.get('content-encoding') && strongTag(response.headers.get('etag')) ? response.headers.get('etag') : null,
          total: response.headers.get('content-encoding') ? null : length(response.headers.get('content-length')), complete: false };
        persist();
      } else {
        await response.body?.cancel();
        throw new Error(`HUSS 成品下载返回不支持的 HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('HUSS 成品下载返回空内容');
      let bytes = append ? offset : 0;
      let last = 0;
      report('downloading', bytes);
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (receipt.total && bytes > receipt.total) { callback(new Error('HUSS 成品下载超过声明长度，拒绝保存')); return; }
        if (Date.now() - last >= 3000) { last = Date.now(); report('downloading', bytes); }
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as any), meter, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
      if (!size() || receipt.total !== null && size() !== receipt.total)
        throw new Error(`HUSS 成品下载不完整：收到 ${size()} 字节，声明 ${receipt.total} 字节`);
      receipt.total = size(); receipt.complete = true; persist();
    }
    report('validating');
    const fd = fs.openSync(part, 'r');
    const header = Buffer.alloc(16);
    try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
    const mp4 = header.subarray(4, 8).toString('ascii') === 'ftyp';
    const webm = header.readUInt32BE(0) === 0x1a45dfa3;
    if (!mp4 && !webm) {
      receipt.complete = false; receipt.etag = null; persist();
      throw new Error('HUSS 成品下载未返回可识别的视频文件');
    }
    const playable = await prepareVideoForDelivery(part);
    const final = finalPrefix + (webm && playable === part ? '.webm' : '.mp4');
    fs.renameSync(playable, final);
    fs.rmSync(part, { force: true }); fs.rmSync(checkpoint, { force: true });
    return final;
  } catch (error) {
    report('retrying');
    throw error; // The existing worker backoff retries this same task; never POST or settle/refund here.
  }
}
