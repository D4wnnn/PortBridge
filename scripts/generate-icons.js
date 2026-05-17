const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writePng(filePath, width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]));
    rows.push(pixels.subarray(y * width * 4, (y + 1) * width * 4));
  }

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);

  fs.writeFileSync(filePath, png);
}

function parseHex(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255
  ];
}

function makeCanvas(size, fill) {
  const pixels = Buffer.alloc(size * size * 4);
  const color = parseHex(fill);
  for (let i = 0; i < size * size; i += 1) {
    pixels.set(color, i * 4);
  }
  return pixels;
}

function setPixel(pixels, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  pixels.set(color, (Math.floor(y) * size + Math.floor(x)) * 4);
}

function rect(pixels, size, x, y, width, height, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      setPixel(pixels, size, px, py, color);
    }
  }
}

function circle(pixels, size, cx, cy, radius, color) {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) {
        setPixel(pixels, size, x, y, color);
      }
    }
  }
}

function line(pixels, size, x1, y1, x2, y2, thickness, color) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  for (let i = 0; i <= steps; i += 1) {
    const x = x1 + (dx * i) / steps;
    const y = y1 + (dy * i) / steps;
    circle(pixels, size, Math.round(x), Math.round(y), Math.floor(thickness / 2), color);
  }
}

function drawIcon(size) {
  const green = parseHex('#176b5b');
  const mint = parseHex('#d7f2eb');
  const pixels = makeCanvas(size, '#176b5b');
  const scale = size / 256;

  const pad = Math.round(42 * scale);
  rect(pixels, size, pad, Math.round(54 * scale), size - pad * 2, Math.round(148 * scale), mint);
  circle(pixels, size, Math.round(86 * scale), Math.round(128 * scale), Math.round(20 * scale), green);
  circle(pixels, size, Math.round(170 * scale), Math.round(128 * scale), Math.round(20 * scale), green);
  line(pixels, size, Math.round(104 * scale), Math.round(128 * scale), Math.round(154 * scale), Math.round(128 * scale), Math.max(3, Math.round(14 * scale)), green);
  line(pixels, size, Math.round(138 * scale), Math.round(101 * scale), Math.round(169 * scale), Math.round(128 * scale), Math.max(3, Math.round(14 * scale)), green);
  line(pixels, size, Math.round(138 * scale), Math.round(155 * scale), Math.round(169 * scale), Math.round(128 * scale), Math.max(3, Math.round(14 * scale)), green);

  return pixels;
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
writePng(path.join(assetsDir, 'icon.png'), 256, 256, drawIcon(256));
writePng(path.join(assetsDir, 'tray.png'), 32, 32, drawIcon(32));
