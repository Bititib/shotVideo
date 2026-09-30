import fs from 'node:fs/promises';
import sharp from 'sharp';

// Run after replacing the transparent master artwork.
const source = 'client/public/brand/lingxu-mascot.png';
const sizes = [16, 32, 48];
const icons = await Promise.all(sizes.map(size => sharp(source).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
icons.forEach((icon, index) => {
  const entry = 6 + index * 16;
  header[entry] = sizes[index];
  header[entry + 1] = sizes[index];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(icon.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += icon.length;
});
await fs.writeFile('client/public/favicon.ico', Buffer.concat([header, ...icons]));
await sharp(source).resize(32, 32).png().toFile('client/public/brand/favicon-32.png');
await sharp(source).resize(180, 180).flatten({ background: '#F7F3E8' }).png().toFile('client/public/apple-touch-icon.png');
console.log('Brand icons generated.');
