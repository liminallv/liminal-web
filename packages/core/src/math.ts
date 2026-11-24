// 4x4 matrix and TRS helpers, in glTF's own conventions.
//
// Column-major, matching `node.matrix`: translation lives at indices 12, 13, 14. That is
// also Three.js's `Matrix4.elements` layout and gl-matrix's `mat4`, so a `Mat4` from this
// package can be handed to either without transposing.
//
// Deliberately a plain `readonly number[]` rather than a class. The whole point of the
// package is that it makes no assumptions about your engine's maths library; a bare array
// is the one representation everything can consume.

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];
/** Quaternion in glTF order: x, y, z, w. */
export type Quat = Vec4;

/** A 4x4 column-major transform, matching glTF's `node.matrix` layout. */
export type Mat4 = readonly number[];

export const IDENTITY_MAT4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major TRS composition, matching glTF's `matrix` convention. */
export function composeTrs(t: Vec3, q: Quat, s: Vec3): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Transform a point: rotation, scale and translation all applied. */
export function transformPoint(m: Mat4, p: Vec3): [number, number, number] {
  const [x, y, z] = p;
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

/**
 * Transform a direction — translation ignored, result renormalized. Correct for normals
 * only under uniform scale; a non-uniformly scaled mesh needs the inverse-transpose, which
 * is your renderer's job and not something this package guesses at.
 */
export function transformDirection(m: Mat4, v: Vec3): [number, number, number] {
  const [x, y, z] = v;
  const nx = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z;
  const ny = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z;
  const nz = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** The translation column. */
export function translationOf(m: Mat4): [number, number, number] {
  return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
}

/** Per-axis scale — the length of each basis vector. Negative determinant flips X. */
export function scaleOf(m: Mat4): [number, number, number] {
  const sx = Math.hypot(m[0] ?? 0, m[1] ?? 0, m[2] ?? 0);
  const sy = Math.hypot(m[4] ?? 0, m[5] ?? 0, m[6] ?? 0);
  const sz = Math.hypot(m[8] ?? 0, m[9] ?? 0, m[10] ?? 0);
  return [determinant3(m) < 0 ? -sx : sx, sy, sz];
}

function determinant3(m: Mat4): number {
  const a = m[0] ?? 0, b = m[1] ?? 0, c = m[2] ?? 0;
  const d = m[4] ?? 0, e = m[5] ?? 0, f = m[6] ?? 0;
  const g = m[8] ?? 0, h = m[9] ?? 0, i = m[10] ?? 0;
  return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
}

/**
 * Rotation as a quaternion, with scale divided out first. Shepperd's method: pick the
 * largest of the four diagonal-derived terms so the square root is never taken of a value
 * near zero, which is where the naive `w`-first derivation loses all its precision.
 */
export function rotationOf(m: Mat4): [number, number, number, number] {
  const [sx, sy, sz] = scaleOf(m);
  const ix = sx === 0 ? 0 : 1 / sx;
  const iy = sy === 0 ? 0 : 1 / sy;
  const iz = sz === 0 ? 0 : 1 / sz;
  const m00 = (m[0] ?? 0) * ix, m01 = (m[1] ?? 0) * ix, m02 = (m[2] ?? 0) * ix;
  const m10 = (m[4] ?? 0) * iy, m11 = (m[5] ?? 0) * iy, m12 = (m[6] ?? 0) * iy;
  const m20 = (m[8] ?? 0) * iz, m21 = (m[9] ?? 0) * iz, m22 = (m[10] ?? 0) * iz;

  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m12 - m21) / s, (m20 - m02) / s, (m01 - m10) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m10 + m01) / s, (m20 + m02) / s, (m12 - m21) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m10 + m01) / s, 0.25 * s, (m21 + m12) / s, (m20 - m02) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m20 + m02) / s, (m21 + m12) / s, 0.25 * s, (m01 - m10) / s];
}

export interface Trs {
  readonly position: [number, number, number];
  readonly rotation: [number, number, number, number];
  readonly scale: [number, number, number];
}

/** Split a matrix back into translation, rotation and scale. */
export function decomposeTrs(m: Mat4): Trs {
  return { position: translationOf(m), rotation: rotationOf(m), scale: scaleOf(m) };
}

/**
 * Rotation about the glTF **Z** axis, in radians — the 2D angle for a game whose play plane
 * is glTF X/Y. Derived from the X basis vector with scale divided out, so a scaled node
 * still reports its true angle.
 *
 * For a play plane of glTF X/Z (a top-down game) you want `yRotationOf` instead.
 */
export function zRotationOf(m: Mat4): number {
  const r00 = m[0] ?? 0;
  const r10 = m[1] ?? 0;
  const r20 = m[2] ?? 0;
  const scaleX = Math.hypot(r00, r10, r20);
  if (scaleX === 0) return 0;
  return Math.atan2(r10 / scaleX, r00 / scaleX);
}

/**
 * Rotation about the glTF **Y** axis (yaw), in radians — the heading for a game whose play
 * plane is glTF X/Z. Positive is from +X toward −Z, the right-handed convention.
 */
export function yRotationOf(m: Mat4): number {
  const r00 = m[0] ?? 0;
  const r01 = m[1] ?? 0;
  const r02 = m[2] ?? 0;
  const scaleX = Math.hypot(r00, r01, r02);
  if (scaleX === 0) return 0;
  return Math.atan2(-r02 / scaleX, r00 / scaleX);
}

/** A quaternion for a rotation of `radians` about glTF Z. */
export function quatFromZRotation(radians: number): [number, number, number, number] {
  const half = radians / 2;
  return [0, 0, Math.sin(half), Math.cos(half)];
}

/** A quaternion for a rotation of `radians` about glTF Y. */
export function quatFromYRotation(radians: number): [number, number, number, number] {
  const half = radians / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}
