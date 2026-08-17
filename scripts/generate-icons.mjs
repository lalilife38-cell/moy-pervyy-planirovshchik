import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const table = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function makeIcon(size) {
  const rgba = Buffer.alloc((size * 4 + 1) * size);
  const center = size / 2;
  const radius = size * 0.265;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const onClock = distance < radius;
      const onRim = distance > radius * 0.82 && distance < radius;
      const onHour = Math.abs(x - center) < size * 0.025 && y > center - radius * 0.52 && y < center + size * 0.03;
      const onMinute = Math.abs((y - center) - (x - center) * 0.56) < size * 0.025 && x > center && x < center + radius * 0.58;
      const offset = row + 1 + x * 4;
      const color = onRim || onHour || onMinute ? [255, 255, 255, 255]
        : onClock ? [139, 105, 162, 255]
        : [115, 82, 139, 255];
      rgba.set(color, offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rgba, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL("../public/icons/", import.meta.url), { recursive: true });
for (const size of [192, 512]) writeFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url), makeIcon(size));
