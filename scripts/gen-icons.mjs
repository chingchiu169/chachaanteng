// Generate a simple placeholder app icon (icon.png + icon.ico) without external deps.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
mkdirSync(root, { recursive: true });

// --- minimal PNG encoder ---
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(size) {
  // dark slate background with an indigo radial glow (placeholder llama dot)
  const raw = Buffer.alloc(size * (1 + size * 4));
  const cx = size / 2;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cx;
      const d = Math.sqrt(dx * dx + dy * dy) / (size / 2);
      let r, g, b;
      if (d < 0.62) {
        // inner disc: indigo -> violet by distance
        const t = d / 0.62;
        r = Math.round(99 + t * (139 - 99));
        g = Math.round(102 + t * (92 - 102));
        b = Math.round(241 + t * (246 - 241));
      } else {
        // background: slate-950 with slight vignette
        const v = d < 1 ? 0 : 1;
        r = 15 - v * 8; g = 23 - v * 12; b = 42 - v * 20;
      }
      const o = rowStart + 1 + x * 4;
      raw[o] = Math.max(0, r);
      raw[o + 1] = Math.max(0, g);
      raw[o + 2] = Math.max(0, b);
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png512 = makePng(512);
writeFileSync(join(root, "icon.png"), png512);

// --- ICO (single 256x256 PNG entry) ---
const png256 = makePng(256);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // count
const entry = Buffer.alloc(16);
entry[0] = 0; // width 256 -> 0
entry[1] = 0; // height 256 -> 0
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png256.length, 8);
entry.writeUInt32LE(22, 12); // offset
writeFileSync(join(root, "icon.ico"), Buffer.concat([header, entry, png256]));

console.log("icons written:", join(root, "icon.png"), join(root, "icon.ico"));
