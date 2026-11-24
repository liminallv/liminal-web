// @liminal-lv/collision-3d — level geometry → 3D collider shapes.
//
// Opt-in, like its 2D sibling, and for the same reason: `@liminal-lv/core` hands you a mesh, a
// collision kind and a world matrix and stops there, because turning that into a collider is
// a question about *your engine*.
//
// It produces plain data and knows nothing about Rapier, Cannon, Jolt, Havok or Ammo. What
// every one of them wants is here in the form they want it:
//
//   BOX               → an oriented box: centre, half-extents, rotation quaternion
//   SPHERE            → centre + radius
//   CAPSULE/CYLINDER  → an axis segment + radius
//   CONVEX            → a world-space point cloud, which every engine hulls itself
//   CONCAVE           → world-space vertices + triangle indices
//   NONE              → null; decoration, never collided
//
// ## Local frame vs. world frame
//
// Two ways to hand a collider to a physics engine, and they need different data:
//
//   • **Baked** (`space: 'world'`, the default) — the shape is in world coordinates and the
//     rigid body sits at the origin. Simplest, and right for static level geometry.
//   • **Local** (`space: 'local'`) — the shape is in the mesh's own frame and you place the
//     body at the returned `transform`. Right for anything that will move, and cheaper when
//     one mesh is instanced many times.
//
// The box, sphere and capsule fits are exact under `'local'` and approximate under
// `'world'`: an axis-aligned local box, once rotated, is only bounded by an axis-aligned
// world box. So a `BOX` in world space carries the rotation that makes it exact anyway —
// see `Box3D.rotation`.

import {
  rotationOf,
  scaleOf,
  transformPoint,
  translationOf,
  type LiminalMesh,
  type LmCollisionKind,
  type Mat4,
  type Quat,
  type Vec3,
} from '@liminal-lv/core';

/** An oriented box: centre, half-extents, and a rotation quaternion (xyzw). */
export interface Box3D {
  readonly center: Vec3;
  readonly halfExtents: Vec3;
  readonly rotation: Quat;
}

export interface Sphere3D {
  readonly center: Vec3;
  readonly radius: number;
}

/** A capsule or cylinder as its two axis endpoints and a radius. */
export interface Segment3D {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly radius: number;
}

/** Flat xyz vertex triples plus triangle indices. */
export interface Trimesh3D {
  readonly vertices: readonly number[];
  readonly indices: readonly number[];
}

export interface Collider3D {
  readonly kind: LmCollisionKind;
  /**
   * Where to place the rigid body carrying this shape. Identity under `space: 'world'`,
   * because the shape already has the placement baked into its coordinates.
   */
  readonly transform: Mat4;
  /** Present for `BOX`. */
  readonly box?: Box3D;
  /** Present for `SPHERE`. */
  readonly sphere?: Sphere3D;
  /** Present for `CAPSULE` and `CYLINDER`. */
  readonly segment?: Segment3D;
  /**
   * Present for `CONVEX`: the mesh's points, deduplicated. Physics engines compute the hull
   * themselves and do it better than a hand-rolled quickhull would, so this hands them the
   * cloud rather than guessing at the hull.
   */
  readonly points?: readonly number[];
  /** Present for `CONCAVE`. */
  readonly trimesh?: Trimesh3D;
}

export interface Collider3DOptions {
  /** `'world'` (default) bakes the placement into the shape; `'local'` puts it on `transform`. */
  readonly space?: 'world' | 'local';
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const MIN_EXTENT = 1e-3;

/**
 * Build the 3D collider for one mesh at a given world placement.
 *
 * Returns `null` for `NONE` — decoration: draw it, never collide with it — and for a mesh
 * with no vertices.
 */
export function collider3dFrom(
  mesh: Pick<LiminalMesh, 'positions' | 'indices'>,
  world: Mat4,
  kind: LmCollisionKind,
  options: Collider3DOptions = {},
): Collider3D | null {
  if (kind === 'NONE') return null;
  if (mesh.positions.length < 3) return null;

  const local = options.space === 'local';
  const points = local ? [...mesh.positions] : transformPositions(mesh.positions, world);
  const transform = local ? world : IDENTITY;
  const aabb = boundsOf(points);

  switch (kind) {
    case 'BOX':
      // The box fit needs the LOCAL bounds even when baking to world space — see `boxFrom`.
      return {
        kind,
        transform,
        box: boxFrom(local ? aabb : boundsOf(mesh.positions), world, local),
      };
    case 'SPHERE':
      return { kind, transform, sphere: sphereFrom(points, aabb) };
    case 'CAPSULE':
    case 'CYLINDER':
      return { kind, transform, segment: segmentFrom(aabb) };
    case 'CONCAVE':
      return mesh.indices
        ? { kind, transform, trimesh: { vertices: points, indices: [...mesh.indices] } }
        : { kind: 'CONVEX', transform, points: dedupe(points) };
    default:
      return { kind: 'CONVEX', transform, points: dedupe(points) };
  }
}

/** Every position transformed into world space, as a flat xyz array. */
export function transformPositions(positions: readonly number[], world: Mat4): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const p = transformPoint(world, [positions[i]!, positions[i + 1]!, positions[i + 2]!]);
    out.push(p[0], p[1], p[2]);
  }
  return out;
}

export interface Aabb3D {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly center: Vec3;
  readonly halfExtents: Vec3;
}

/** The axis-aligned bounds of a flat xyz position array. */
export function boundsOf(positions: readonly number[]): Aabb3D {
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
    if (z < minz) minz = z;
    if (z > maxz) maxz = z;
  }
  return {
    min: [minx, miny, minz],
    max: [maxx, maxy, maxz],
    center: [(minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2],
    halfExtents: [(maxx - minx) / 2, (maxy - miny) / 2, (maxz - minz) / 2],
  };
}

/**
 * An oriented box, built from the mesh's **local** bounds either way.
 *
 * That is the whole trick. Fitting an axis-aligned box to world-space points inflates every
 * rotated shape — a 2x2 box turned 45° bounds out to 2.83 across, so a wall becomes a
 * collider you bump into a foot early. Taking the extents from the local frame, scaling
 * them, and carrying the node's rotation on the shape is exact for any orientation.
 *
 * Under `space: 'local'` the rotation is identity, because `Collider3D.transform` carries
 * the node's placement instead and applying it twice would be worse than not at all.
 *
 * A mesh whose rotation is *baked into its vertices* has an identity node rotation, so this
 * degrades to an honest local AABB — the same answer any approach could give without an
 * exhaustive minimum-volume OBB search, which no level pipeline should be paying for.
 * (`@liminal-lv/collision-2d` does run that search, because in 2D it is a cheap sweep over
 * hull edges rather than an orientation space.)
 */
function boxFrom(local: Aabb3D, world: Mat4, inLocalSpace: boolean): Box3D {
  if (inLocalSpace) {
    return {
      center: local.center,
      halfExtents: clampExtents(local.halfExtents),
      rotation: [0, 0, 0, 1],
    };
  }
  const scale = scaleOf(world);
  return {
    center: transformPoint(world, local.center),
    halfExtents: clampExtents([
      local.halfExtents[0] * Math.abs(scale[0]),
      local.halfExtents[1] * Math.abs(scale[1]),
      local.halfExtents[2] * Math.abs(scale[2]),
    ]),
    rotation: rotationOf(world),
  };
}

/** Half-extents are clamped, so a paper-thin wall is still a collider rather than a plane. */
function clampExtents(half: Vec3): Vec3 {
  return [
    Math.max(MIN_EXTENT, half[0]),
    Math.max(MIN_EXTENT, half[1]),
    Math.max(MIN_EXTENT, half[2]),
  ];
}

/**
 * The sphere enclosing every point, centred on the bounds' midpoint.
 *
 * Not the minimum enclosing sphere (Ritter's or Welzl's) — for a collider derived from a
 * roughly round mesh the two barely differ, and this one is trivially deterministic across
 * hosts, which matters far more when a client and a server must agree on physics.
 */
function sphereFrom(positions: readonly number[], aabb: Aabb3D): Sphere3D {
  const [cx, cy, cz] = aabb.center;
  let radius = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const dx = positions[i]! - cx;
    const dy = positions[i + 1]! - cy;
    const dz = positions[i + 2]! - cz;
    const d = Math.hypot(dx, dy, dz);
    if (d > radius) radius = d;
  }
  return { center: aabb.center, radius: Math.max(MIN_EXTENT, radius) };
}

/**
 * A capsule or cylinder along the bounds' longest axis. The radius is the larger of the two
 * remaining half-extents, and the segment is shortened by that radius at each end so the
 * caps land on the original bounds rather than outside them.
 */
function segmentFrom(aabb: Aabb3D): Segment3D {
  const half = aabb.halfExtents;
  let axis = 0;
  if (half[1] > half[axis]!) axis = 1;
  if (half[2] > half[axis]!) axis = 2;

  const others = [0, 1, 2].filter((i) => i !== axis) as [number, number];
  const radius = Math.max(MIN_EXTENT, Math.max(half[others[0]]!, half[others[1]]!));
  const reach = Math.max(0, half[axis]! - radius);

  const offset: [number, number, number] = [0, 0, 0];
  offset[axis] = reach;
  const c = aabb.center;
  return {
    a: [c[0] - offset[0], c[1] - offset[1], c[2] - offset[2]],
    b: [c[0] + offset[0], c[1] + offset[1], c[2] + offset[2]],
    radius,
  };
}

/**
 * Drop duplicate positions, which an exported mesh has a great many of: a cube drawn with
 * per-face normals has 24 vertices for 8 distinct corners. Hulling algorithms do not care,
 * but the point cloud is often uploaded to the physics engine every frame in a networked
 * rollback, and a third of the data is a third of the data.
 */
export function dedupe(positions: readonly number[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    const key = `${x},${y},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x, y, z);
  }
  return out;
}

export { translationOf };
