import fs from 'fs';
import path from 'path';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array, previous = 0) {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
export function resolveBatchArchiveFile(url: string, root: string) {
  const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  if (!pathname.startsWith('/uploads/')) throw new Error('视频尚未保存到本站，暂不能打包');
  const realRoot = fs.realpathSync(root);
  const file = fs.realpathSync(path.resolve(realRoot, pathname.slice('/uploads/'.length)));
  const relative = path.relative(realRoot, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(file).isFile() || !/\.(mp4|webm|mov)$/i.test(file)) throw new Error('无效的视频文件路径');
  return file;
}

/** Uncompressed streaming ZIP; videos are already compressed. No shell/archive
 * dependency and no multi-gigabyte Buffer in server memory. ZIP64 is deliberately
 * excluded; the caller limits the archive to < 3 GiB before issuing a ticket. */
export async function* streamVideoZip(files: { path: string; name: string }[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const localOffset = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x808, 6);
    local.writeUInt16LE(0x21, 12); local.writeUInt16LE(name.length, 26);
    yield local; yield name; offset += local.length + name.length;
    let crc = 0; let size = 0;
    const input = fs.createReadStream(file.path);
    try {
      for await (const chunk of input) {
        const bytes = chunk as Buffer; crc = crc32(bytes, crc); size += bytes.length; offset += bytes.length;
        if (offset >= 0xf0000000) throw new Error('打包文件过大，请分批下载');
        yield bytes;
      }
    } finally { input.destroy(); }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12);
    yield descriptor; offset += descriptor.length;
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x808, 8);
    header.writeUInt16LE(0x21, 14); header.writeUInt32LE(crc, 16); header.writeUInt32LE(size, 20); header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(localOffset, 42);
    central.push(header, name);
  }
  const end = Buffer.alloc(22); const centralSize = central.reduce((n, b) => n + b.length, 0);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  for (const buffer of central) yield buffer;
  yield end;
}
