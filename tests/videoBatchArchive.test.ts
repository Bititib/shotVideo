import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { Readable } from 'stream';
import { crc32, streamVideoZip } from '../server/services/videoBatchArchive';

describe('streamed video ZIP', () => {
  it('matches standard CRC32 and supports incremental chunks', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('56789'), crc32(Buffer.from('1234')))).toBe(0xcbf43926);
  });
  it('produces standard local headers, descriptors, central entries and end record', async () => {
    const mock = vi.spyOn(fs, 'createReadStream').mockImplementation(() => Readable.from([Buffer.from('hello'), Buffer.from(' world')]) as any);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of streamVideoZip([{ path: 'unused', name: 'video-1.mp4' }])) chunks.push(chunk);
      const zip = Buffer.concat(chunks);
      expect(zip.readUInt32LE(0)).toBe(0x04034b50);
      expect(zip.readUInt16LE(6)).toBe(0x808);
      const dataStart = 30 + zip.readUInt16LE(26);
      expect(zip.subarray(dataStart, dataStart + 11).toString()).toBe('hello world');
      expect(zip.readUInt32LE(dataStart + 11)).toBe(0x08074b50);
      expect(zip.readUInt32LE(dataStart + 15)).toBe(crc32(Buffer.from('hello world')));
      const end = zip.length - 22;
      expect(zip.readUInt32LE(end)).toBe(0x06054b50);
      expect(zip.readUInt16LE(end + 10)).toBe(1);
      const central = zip.readUInt32LE(end + 16);
      expect(zip.readUInt32LE(central)).toBe(0x02014b50);
      expect(zip.readUInt32LE(central + 20)).toBe(11);
      expect(zip.readUInt32LE(central + 42)).toBe(0);
    } finally { mock.mockRestore(); }
  });
});
