/**
 * Runtime tray-icon rendering (PLAN-012).
 *
 * Generates monochrome macOS *template* images in-process from a pixel mask, so
 * the tray needs NO bundled PNG assets and therefore NO copy-assets /
 * electron-builder changes (ADR-0007: zero packaging edits). Template images are
 * alpha-only as far as macOS is concerned — it tints them for light/dark/menu-bar
 * appearance automatically, so we draw a flat black glyph and let the OS invert.
 *
 * A tiny dependency-free PNG encoder (zlib is built into Node) builds the buffer;
 * `nativeImage.createFromBuffer` + `setTemplateImage(true)` finishes the job.
 */

import { deflateSync } from 'node:zlib';
import { nativeImage, type NativeImage } from 'electron';
import type { RemoteAccessState } from '../../shared/types';

const SIZE = 18; // logical points; @2x handled by macOS from the same template

// CRC-32 (PNG chunk checksums).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode an RGBA pixel buffer (size*size*4) as a PNG buffer. */
function encodePng(rgba: Buffer, size: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Prepend a filter byte (0 = none) per scanline.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Draw the glyph mask: a rounded "server rack" outline + a state accent pixel. */
function drawMask(state: RemoteAccessState, size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4); // all transparent black
  const set = (x: number, y: number, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = a;
  };

  // Rack body: rectangle from (3,3) to (14,14), 1px border, 2 divider lines.
  const x0 = 3, y0 = 3, x1 = size - 4, y1 = size - 4;
  for (let x = x0; x <= x1; x++) { set(x, y0); set(x, y1); }
  for (let y = y0; y <= y1; y++) { set(x0, y); set(x1, y); }
  const third = Math.round((y1 - y0) / 3);
  for (let x = x0 + 2; x <= x1 - 2; x++) {
    set(x, y0 + third);
    set(x, y0 + 2 * third);
  }
  // "LED" dot on each shelf (left edge).
  set(x0 + 2, y0 + Math.round(third / 2));
  set(x0 + 2, y0 + third + Math.round(third / 2));

  // State accent: bottom-right corner marker.
  if (state === 'running') {
    // filled dot
    set(x1, y1); set(x1 - 1, y1); set(x1, y1 - 1); set(x1 - 1, y1 - 1);
  } else if (state === 'error') {
    // exclamation-ish stroke
    set(x1, y1 - 3); set(x1, y1 - 2); set(x1, y1);
  }
  return rgba;
}

/** Build a template NativeImage for the given supervisor state. */
export function renderTrayIcon(state: RemoteAccessState): NativeImage {
  const png = encodePng(drawMask(state, SIZE), SIZE);
  const img = nativeImage.createFromBuffer(png);
  img.setTemplateImage(true);
  return img;
}
