import { Vector3 } from 'three';

export interface Polygon {
  readonly points: readonly (readonly [x: number, z: number])[];
}

export interface Aabb {
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hz: number;
}

export function planar(x: number, z: number): Vector3 {
  return new Vector3(x, 0, z);
}

export function len(v: Vector3): number {
  return Math.hypot(v.x, v.z);
}

export function normalize(v: Vector3): Vector3 {
  const l = len(v);
  return l > 1e-9 ? planar(v.x / l, v.z / l) : planar(0, 0);
}

export function dist(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function fromCollider(points: readonly (readonly [number, number])[]): Polygon {
  return { points: points.map(([x, y]) => [x, -y] as const).reverse() };
}

export function pointInPolygon(p: Vector3, poly: Polygon): boolean {
  const pts = poly.points;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if ((b[0] - a[0]) * (p.z - a[1]) - (b[1] - a[1]) * (p.x - a[0]) < 0) return false;
  }
  return true;
}

export function pointInAabb(p: Vector3, box: Aabb): boolean {
  return Math.abs(p.x - box.cx) <= box.hx && Math.abs(p.z - box.cz) <= box.hz;
}

function closestOnSegment(p: Vector3, a: readonly [number, number], b: readonly [number, number]): Vector3 {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.z - a[1]) * dz) / l2));
  return planar(a[0] + dx * t, a[1] + dz * t);
}

export function resolveCirclePolygon(c: Vector3, r: number, poly: Polygon): boolean {
  const pts = poly.points;
  if (pointInPolygon(c, poly)) {
    let best = Infinity;
    let nx = 0;
    let nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const ex = b[0] - a[0];
      const ez = b[1] - a[1];
      const el = Math.hypot(ex, ez) || 1;
      const ox = ez / el;
      const oz = -ex / el;
      const d = (c.x - a[0]) * ox + (c.z - a[1]) * oz;
      if (d < best) {
        best = d;
        nx = ox;
        nz = oz;
      }
    }
    c.x += nx * (best + r);
    c.z += nz * (best + r);
    return true;
  }
  let touched = false;
  for (let i = 0; i < pts.length; i++) {
    const q = closestOnSegment(c, pts[i]!, pts[(i + 1) % pts.length]!);
    const dx = c.x - q.x;
    const dz = c.z - q.z;
    const d = Math.hypot(dx, dz);
    if (d < r && d > 1e-9) {
      c.x += (dx / d) * (r - d);
      c.z += (dz / d) * (r - d);
      touched = true;
    }
  }
  return touched;
}

export function resolveCircleAabb(c: Vector3, r: number, box: Aabb): Vector3 | null {
  const qx = Math.max(box.cx - box.hx, Math.min(c.x, box.cx + box.hx));
  const qz = Math.max(box.cz - box.hz, Math.min(c.z, box.cz + box.hz));
  const dx = c.x - qx;
  const dz = c.z - qz;
  const d = Math.hypot(dx, dz);
  if (d >= r) return null;
  if (d > 1e-9) {
    const n = planar(dx / d, dz / d);
    c.x += n.x * (r - d);
    c.z += n.z * (r - d);
    return n;
  }
  const px = box.hx - Math.abs(c.x - box.cx);
  const pz = box.hz - Math.abs(c.z - box.cz);
  if (px < pz) {
    const s = Math.sign(c.x - box.cx) || 1;
    c.x = box.cx + s * (box.hx + r);
    return planar(s, 0);
  }
  const s = Math.sign(c.z - box.cz) || 1;
  c.z = box.cz + s * (box.hz + r);
  return planar(0, s);
}

export function resolveCircleCircle(a: Vector3, ra: number, b: Vector3, rb: number, weight = 0.5): void {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  const overlap = ra + rb - d;
  if (overlap <= 0) return;
  const nx = d > 1e-9 ? dx / d : 1;
  const nz = d > 1e-9 ? dz / d : 0;
  a.x -= nx * overlap * weight;
  a.z -= nz * overlap * weight;
  b.x += nx * overlap * (1 - weight);
  b.z += nz * overlap * (1 - weight);
}

export function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return Math.abs(a.cx - b.cx) < a.hx + b.hx && Math.abs(a.cz - b.cz) < a.hz + b.hz;
}

export function aabbPolygonOverlap(box: Aabb, poly: Polygon): boolean {
  const corners = [
    planar(box.cx - box.hx, box.cz - box.hz),
    planar(box.cx + box.hx, box.cz - box.hz),
    planar(box.cx + box.hx, box.cz + box.hz),
    planar(box.cx - box.hx, box.cz + box.hz),
  ];
  if (corners.some((c) => pointInPolygon(c, poly))) return true;
  if (poly.points.some(([x, z]) => pointInAabb(planar(x, z), box))) return true;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    for (let j = 0; j < poly.points.length; j++) {
      const p = poly.points[j]!;
      const q = poly.points[(j + 1) % poly.points.length]!;
      if (segmentsCross(a, b, planar(p[0], p[1]), planar(q[0], q[1]))) return true;
    }
  }
  return false;
}

function segmentsCross(a: Vector3, b: Vector3, c: Vector3, d: Vector3): boolean {
  const o = (p: Vector3, q: Vector3, r: Vector3) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

export function raySegment(o: Vector3, d: Vector3, a: readonly [number, number], b: readonly [number, number]): number | null {
  const ex = b[0] - a[0];
  const ez = b[1] - a[1];
  const denom = d.x * ez - d.z * ex;
  if (Math.abs(denom) < 1e-12) return null;
  const fx = a[0] - o.x;
  const fz = a[1] - o.z;
  const t = (fx * ez - fz * ex) / denom;
  const u = (fx * d.z - fz * d.x) / denom;
  return t >= 0 && u >= 0 && u <= 1 ? t : null;
}

export function rayPolygon(o: Vector3, d: Vector3, poly: Polygon): number | null {
  let best: number | null = null;
  const pts = poly.points;
  for (let i = 0; i < pts.length; i++) {
    const t = raySegment(o, d, pts[i]!, pts[(i + 1) % pts.length]!);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

export function rayAabb(o: Vector3, d: Vector3, box: Aabb): number | null {
  const x0 = box.cx - box.hx;
  const x1 = box.cx + box.hx;
  const z0 = box.cz - box.hz;
  const z1 = box.cz + box.hz;
  return rayPolygon(o, d, {
    points: [
      [x0, z1],
      [x1, z1],
      [x1, z0],
      [x0, z0],
    ],
  });
}

export function rayCircle(o: Vector3, d: Vector3, c: Vector3, r: number): number | null {
  const fx = o.x - c.x;
  const fz = o.z - c.z;
  const b = fx * d.x + fz * d.z;
  const cc = fx * fx + fz * fz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : cc < 0 ? 0 : null;
}
