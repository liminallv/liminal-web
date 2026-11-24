// Draws the PNGs the entity gizmos reference, so the example carries no binary art that
// cannot be regenerated. Run with `pnpm icons`; the sync publishes the results to Blender.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 64;
const OUT = fileURLToPath(new URL('../assets/gizmos/', import.meta.url));

type Rgba = readonly [number, number, number, number];

class Canvas {
  readonly data = new Uint8Array(SIZE * SIZE * 4);

  fill(color: Rgba): void {
    for (let i = 0; i < SIZE * SIZE; i++) this.data.set(color, i * 4);
  }

  paint(color: Rgba, inside: (x: number, y: number) => boolean): void {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (inside(x + 0.5, y + 0.5)) this.data.set(color, (y * SIZE + x) * 4);
      }
    }
  }

  circle(cx: number, cy: number, r: number, color: Rgba): void {
    this.paint(color, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
  }

  ring(cx: number, cy: number, outer: number, inner: number, color: Rgba): void {
    this.paint(color, (x, y) => {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      return d <= outer * outer && d >= inner * inner;
    });
  }

  rect(x0: number, y0: number, x1: number, y1: number, color: Rgba): void {
    this.paint(color, (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1);
  }

  triangle(a: [number, number], b: [number, number], c: [number, number], color: Rgba): void {
    const sign = (p: [number, number], q: [number, number], x: number, y: number) =>
      (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
    this.paint(color, (x, y) => {
      const d1 = sign(a, b, x, y);
      const d2 = sign(b, c, x, y);
      const d3 = sign(c, a, x, y);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      return !(neg && pos);
    });
  }

  thickLine(x0: number, y0: number, x1: number, y1: number, width: number, color: Rgba): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    const half = width / 2;
    this.paint(color, (x, y) => {
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
      const px = x0 + dx * t;
      const py = y0 + dy * t;
      return (x - px) ** 2 + (y - py) ** 2 <= half * half;
    });
  }
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const CLEAR: Rgba = [0, 0, 0, 0];
const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [20, 20, 24, 255];

function icon(draw: (c: Canvas) => void): Uint8Array {
  const canvas = new Canvas();
  canvas.fill(CLEAR);
  draw(canvas);
  return encodePng(canvas.data);
}

const icons: Record<string, Uint8Array> = {
  player: icon((c) => {
    c.circle(32, 32, 28, [40, 60, 48, 230]);
    c.triangle([32, 8], [52, 50], [32, 40], [74, 222, 128, 255]);
    c.triangle([32, 8], [12, 50], [32, 40], [52, 180, 100, 255]);
  }),
  alien: icon((c) => {
    c.circle(32, 28, 26, [60, 200, 90, 255]);
    c.rect(18, 40, 46, 58, [60, 200, 90, 255]);
    c.circle(22, 28, 7, BLACK);
    c.circle(42, 28, 7, BLACK);
    c.circle(24, 26, 2.5, WHITE);
    c.circle(44, 26, 2.5, WHITE);
    c.rect(26, 46, 38, 49, BLACK);
  }),
  health: icon((c) => {
    c.rect(6, 6, 58, 58, [250, 250, 250, 255]);
    c.rect(26, 14, 38, 50, [230, 50, 70, 255]);
    c.rect(14, 26, 50, 38, [230, 50, 70, 255]);
  }),
  ammo: icon((c) => {
    for (const x of [14, 32, 50]) {
      c.rect(x - 7, 10, x + 7, 54, [200, 40, 40, 255]);
      c.rect(x - 7, 42, x + 7, 54, [220, 170, 60, 255]);
      c.circle(x, 48, 2.5, BLACK);
    }
  }),
  portal: icon((c) => {
    c.ring(32, 32, 29, 21, [34, 211, 238, 255]);
    c.ring(32, 32, 17, 11, [140, 240, 255, 255]);
    c.circle(32, 32, 6, WHITE);
  }),
  counter: icon((c) => {
    c.rect(4, 4, 60, 60, [40, 30, 20, 230]);
    for (const x of [14, 24, 34, 44]) c.rect(x - 2, 14, x + 2, 50, [251, 146, 60, 255]);
    c.thickLine(8, 50, 54, 14, 5, [251, 146, 60, 255]);
  }),
  hazard: icon((c) => {
    c.fill([240, 180, 30, 255]);
    c.paint(BLACK, (x, y) => ((x + y) >> 4) % 2 === 0);
  }),
  grid: icon((c) => {
    c.fill([52, 211, 153, 40]);
    c.paint([52, 211, 153, 200], (x, y) => x < 3 || y < 3);
  }),
};

mkdirSync(OUT, { recursive: true });
for (const [name, bytes] of Object.entries(icons)) {
  writeFileSync(join(OUT, `${name}.png`), bytes);
  console.log(`wrote ${name}.png`);
}

function encodePng(rgba: Uint8Array): Uint8Array {
  const stride = SIZE * 4;
  const raw = new Uint8Array(SIZE * (stride + 1));
  for (let y = 0; y < SIZE; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, SIZE);
  view.setUint32(4, SIZE);
  header[8] = 8;
  header[9] = 6;
  return concat([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
