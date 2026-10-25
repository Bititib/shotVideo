import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4');
  // Excludes local, mapped IPv4, NAT64 and other non-global IPv6 ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, 'ipv6');
}

async function resolveImageHost(url: URL, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
    || /(^|\.)(localhost|local|internal)$/i.test(host)) throw new Error('图片地址必须是无账号密码的公网 HTTP/HTTPS 地址（标准端口）');
  signal.throwIfAborted();
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const pending = isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : lookup(host, { all: true, verbatim: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(item => !isPublicImageAddress(item.address))) throw new Error('禁止下载内网或非公网地址的图片');
  return addresses[0];
}

/** Each redirect gets its own DNS check; the actual socket uses that checked IP.
 * No cookies, channel authorization, proxy environment, or original URL in errors. */
export async function downloadPublicReferenceImage(source: string, signal: AbortSignal, maxBytes = 20 * 1024 * 1024): Promise<Buffer> {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error('图片 URL 格式无效'); }
  try {
    for (let hop = 0; hop <= 3; hop++) {
      const address = await resolveImageHost(url, signal);
      const result = await new Promise<{ location?: string; bytes?: Buffer }>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
          signal, agent: false,
          headers: { Accept: 'image/*', 'Accept-Encoding': 'identity', 'User-Agent': 'shotVideo-reference-fetcher/1.0' },
          lookup: ((_host: string, options: any, cb: any) => options?.all
            ? cb(null, [address]) : cb(null, address.address, address.family)) as any,
        }, response => {
          const status = response.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = response.headers.location;
            response.destroy();
            if (!location) reject(new Error('图片下载重定向缺少目标地址'));
            else resolve({ location });
            return;
          }
          if (status !== 200) { response.destroy(); reject(new Error(`图片下载失败（HTTP ${status}）`)); return; }
          if (Number(response.headers['content-length']) > maxBytes) {
            response.destroy(); reject(new Error('图片超过 20 MB 上限')); return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('error', reject);
          response.on('aborted', () => reject(new Error('图片下载连接中断，文件不完整')));
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) { response.destroy(); reject(new Error('图片超过 20 MB 上限')); return; }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (!response.complete) reject(new Error('图片下载连接中断，文件不完整'));
            else resolve({ bytes: Buffer.concat(chunks, size) });
          });
        });
        request.on('error', reject);
        request.end();
      });
      if (result.bytes) return result.bytes;
      if (hop === 3) throw new Error('图片下载重定向超过 3 次');
      url = new URL(result.location!, url);
    }
  } catch (error: any) {
    if (signal.aborted) throw new Error('图片下载超时');
    // System error messages can include signed URLs/addresses. Only expose code.
    if (error?.code) throw new Error(`图片下载连接失败（${String(error.code).replace(/[^A-Z0-9_]/g, '').slice(0, 60)}）`);
    if (error instanceof TypeError) throw new Error('图片下载地址或重定向无效');
    throw error;
  }
  throw new Error('图片下载未取得完整文件');
}
