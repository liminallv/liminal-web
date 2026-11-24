// A PNG writer and a deliberately partial PNG reader, private to `@liminal-lv/cli`.
//
// The material previews the Blender addon reads are ordinary image files, so writing them
// needs an encoder and composing them into a thumbnail atlas needs a decoder. `node:zlib`
// supplies the only hard part, which is why this is ~200 lines rather than a dependency.
//
// The reader handles what a base-colour texture realistically is — 8-bit, non-interlaced,
// truecolour with or without alpha — and returns null for everything else. A caller that
// cannot decode a preview falls back to a flat tile rather than failing the sync.

import { deflateSync, inflateSync } from 'node:zlib';

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** Row-major, top-down, 4 bytes per pixel. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

/** Encode straight RGBA as a truecolour-with-alpha PNG, every scanline filter 0. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;

  return concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Decode an 8-bit non-interlaced truecolour PNG, or null for anything else. */
export function decodePng(bytes: Uint8Array): DecodedImage | null {
  if (bytes.length < 8) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let channels = 0;

  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) return null;
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length < 13) return null;
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (data[8] !== 8 || data[12] !== 0) return null;
      if (data[9] === 2) channels = 3;
      else if (data[9] === 6) channels = 4;
      else return null;
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width <= 0 || height <= 0 || channels === 0 || parts.length === 0) return null;

  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(concat(parts)));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const pixels = unfilter(raw, width, height, channels);
  if (!pixels) return null;
  return { width, height, rgba: channels === 4 ? pixels : widenToRgba(pixels, width * height) };
}

/**
 * Resample to `size`×`size` by averaging each destination pixel's source box.
 *
 * A thumbnail is looked at, not sampled, so an area average is both the cheapest and the most
 * honest reduction — a point sample of a detailed texture aliases into noise.
 */
export function boxDownsample(image: DecodedImage, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let ty = 0; ty < size; ty++) {
    const y0 = Math.floor((ty * image.height) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * image.height) / size));
    for (let tx = 0; tx < size; tx++) {
      const x0 = Math.floor((tx * image.width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * image.width) / size));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let y = y0; y < Math.min(y1, image.height); y++) {
        for (let x = x0; x < Math.min(x1, image.width); x++) {
          const i = (y * image.width + x) * 4;
          r += image.rgba[i]!;
          g += image.rgba[i + 1]!;
          b += image.rgba[i + 2]!;
          a += image.rgba[i + 3]!;
          count++;
        }
      }
      const o = (ty * size + tx) * 4;
      if (count === 0) continue;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = Math.round(a / count);
    }
  }
  return out;
}

/**
 * A flat `size`×`size` tile of one linear colour, sRGB-encoded.
 *
 * `MaterialDescriptor.color` is a glTF `baseColorFactor` and therefore linear, while an image
 * file is read as sRGB. Writing the linear value straight into the file makes every mid grey
 * come out visibly dark.
 */
export function solidRgba(
  color: readonly [number, number, number, number],
  size: number,
): Uint8Array {
  const pixel = Uint8Array.of(
    encodeSrgb(color[0]),
    encodeSrgb(color[1]),
    encodeSrgb(color[2]),
    clampByte(color[3]),
  );
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < out.length; i += 4) out.set(pixel, i);
  return out;
}

function encodeSrgb(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  const encoded =
    clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return clampByte(encoded);
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array | null {
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? current[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      const value = line[x]!;
      switch (filter) {
        case 0:
          current[x] = value;
          break;
        case 1:
          current[x] = (value + left) & 0xff;
          break;
        case 2:
          current[x] = (value + up) & 0xff;
          break;
        case 3:
          current[x] = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          current[x] = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          return null;
      }
    }
    previous = current;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function widenToRgba(rgb: Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    out[i * 4] = rgb[i * 3]!;
    out[i * 4 + 1] = rgb[i * 3 + 1]!;
    out[i * 4 + 2] = rgb[i * 3 + 2]!;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
