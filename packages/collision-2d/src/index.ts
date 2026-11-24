// @liminal-lv/collision-2d — level geometry → 2D collider shapes.
//
// Opt-in, and deliberately separate from `@liminal-lv/core`. The importer hands you a mesh, a
// collision kind and a world matrix and stops there, because "what shape does this mesh
// collide as" is a question about *your engine*, not about the file format. This package is
// one answer to it, for a game whose play area is a plane.
//
// It produces plain data — points, boxes, triangle soups — and knows nothing about Rapier,
// Matter, Planck or Box2D. Feeding a `Collider2D` to your physics engine is a dozen lines
// you write once; see the README for a Rapier example.
//
// ## Which plane?
//
// A `.lm` is Y-up glTF. Two projections are common, and you pick with `plane`:
//
//   'xy'  (the default) — a side-on game. glTF +Y is "up", glTF Z is visual depth and is
//         discarded. Levels are authored in Blender's FRONT view.
//   'xz'  — a top-down game. The projection is (x, −z), not (x, z): negating Z is what
//         keeps a polygon that winds counter-clockwise when seen from above still wind
//         counter-clockwise in 2D, which every physics engine's convex-hull input assumes.

import { transformPoint, type LiminalMesh, type LmCollisionKind, type Mat4 } from '@liminal-lv/core';

export type Vec2 = readonly [number, number];

/** Which pair of glTF axes forms the play plane. See the note above. */
export type CollisionPlane = 'xy' | 'xz';

/** An oriented box: centre, half-extents, and a rotation in radians. */
export interface Box2D {
  readonly cx: number;
  readonly cy: number;
  readonly hx: number;
  readonly hy: number;
  readonly angle: number;
}

/** A triangle soup: flat xy vertex pairs plus triangle indices. */
export interface Trimesh2D {
  readonly vertices: readonly number[];
  readonly indices: readonly number[];
}

export interface Circle2D {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
}

/** A capsule as its two endpoints and a radius — the form most 2D engines accept. */
export interface Capsule2D {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly radius: number;
}

/**
 * One mesh, resolved into whatever 2D shape its collision kind asks for.
 *
 * `points` is always populated: it is the CONVEX shape, and it is also the outline to draw
 * for a collision debug overlay whatever the kind actually is. The kind-specific field is
 * the one your engine should prefer.
 */
export interface Collider2D {
  readonly kind: LmCollisionKind;
  /** Counter-clockwise convex hull of the world-space silhouette. */
  readonly points: readonly Vec2[];
  /** Present for `BOX`. */
  readonly box?: Box2D;
  /** Present for `CONCAVE`, when the mesh was indexed. */
  readonly trimesh?: Trimesh2D;
  /** Present for `SPHERE` and `CYLINDER`, which are the same shape once flattened. */
  readonly circle?: Circle2D;
  /** Present for `CAPSULE`. */
  readonly capsule?: Capsule2D;
}

export interface Collider2DOptions {
  readonly plane?: CollisionPlane;
}

/**
 * Build the 2D collider for one mesh at a given world placement.
 *
 * Returns `null` for `NONE` (decoration: draw it, never collide with it) and for a
 * silhouette that degenerates to a line or a point once flattened — there is no such thing
 * as a zero-area collider, and a physics engine handed one usually crashes rather than
 * complains.
 */
export function collider2dFrom(
  mesh: Pick<LiminalMesh, 'positions' | 'indices'>,
  world: Mat4,
  kind: LmCollisionKind,
  options: Collider2DOptions = {},
): Collider2D | null {
  if (kind === 'NONE') return null;

  const projected = projectToPlane(mesh.positions, world, options.plane);
  const points = convexHull2d(projected);
  if (points.length < 3) return null;

  switch (kind) {
    case 'BOX': {
      const box = minAreaBox(points);
      // A degenerate fit falls back to the convex hull rather than to nothing: the designer
      // asked for a collider, and `points` is always a valid one.
      return box ? { kind, points, box } : { kind: 'CONVEX', points };
    }
    case 'CONCAVE': {
      if (!mesh.indices) return { kind: 'CONVEX', points }; // nothing to build a soup from
      const trimesh = trimesh2d(projected, mesh.indices);
      return trimesh.indices.length >= 3 ? { kind, points, trimesh } : { kind: 'CONVEX', points };
    }
    case 'SPHERE':
    case 'CYLINDER':
      return { kind, points, circle: boundingCircle(points) };
    case 'CAPSULE':
      return { kind, points, capsule: boundingCapsule(points) };
    default:
      return { kind: 'CONVEX', points };
  }
}

/**
 * Project a flat xyz position array through a world matrix onto the play plane.
 *
 * Vertices are transformed first and flattened second, which matters: it means the result
 * is correct whether the designer's rotation lives on the object (a node transform) or is
 * baked into the mesh vertices (edit-mode modelling, or an applied rotation in Blender).
 */
export function projectToPlane(
  positions: readonly number[],
  world: Mat4,
  plane: CollisionPlane = 'xy',
): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const w = transformPoint(world, [positions[i]!, positions[i + 1]!, positions[i + 2]!]);
    out.push(plane === 'xy' ? [w[0], w[1]] : [w[0], -w[2]]);
  }
  return out;
}

/**
 * Andrew's monotone chain. Returns counter-clockwise hull points with no collinear runs;
 * fewer than three points come back unchanged, which callers read as "degenerate".
 */
export function convexHull2d(points: readonly Vec2[]): Vec2[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (input: readonly Vec2[]): Vec2[] => {
    const chain: Vec2[] = [];
    for (const point of input) {
      while (chain.length >= 2) {
        const a = chain[chain.length - 2];
        const b = chain[chain.length - 1];
        if (!a || !b || cross(a, b, point) > 0) break;
        chain.pop();
      }
      chain.push([point[0], point[1]]);
    }
    chain.pop(); // shared endpoint with the other chain
    return chain;
  };

  return [...build(sorted), ...build([...sorted].reverse())];
}

/**
 * The minimum-area oriented bounding box of a convex hull.
 *
 * By the rotating-calipers theorem one side of the minimum-area rectangle is always
 * collinear with a hull edge, so sweeping every edge direction and keeping the tightest
 * rectangle is exact, not an approximation.
 *
 * Take the hull of **world-space** points, not a local AABB transformed afterwards. The two
 * differ whenever a designer's rotation is baked into the mesh vertices rather than sitting
 * on the node: the local AABB is then axis-aligned and far too fat, while the node reports
 * an angle of zero. The world silhouette has no such blind spot.
 *
 * Returns `null` for a hull with no area.
 */
export function minAreaBox(points: readonly Vec2[]): Box2D | null {
  if (points.length < 3) return null;
  let bestCx = 0;
  let bestCy = 0;
  let bestHx = 0;
  let bestHy = 0;
  let bestArea = Infinity;
  let bestAngle = 0;

  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue; // degenerate edge

    // Candidate frame: u along the edge, v perpendicular (counter-clockwise).
    const ux = dx / len;
    const uy = dy / len;
    const vx = -uy;
    const vy = ux;
    let minu = Infinity;
    let maxu = -Infinity;
    let minv = Infinity;
    let maxv = -Infinity;
    for (const p of points) {
      const pu = p[0] * ux + p[1] * uy;
      const pv = p[0] * vx + p[1] * vy;
      if (pu < minu) minu = pu;
      if (pu > maxu) maxu = pu;
      if (pv < minv) minv = pv;
      if (pv > maxv) maxv = pv;
    }
    const area = (maxu - minu) * (maxv - minv);
    if (area < bestArea) {
      const cu = (minu + maxu) / 2;
      const cv = (minv + maxv) / 2;
      bestCx = cu * ux + cv * vx;
      bestCy = cu * uy + cv * vy;
      bestHx = (maxu - minu) / 2;
      bestHy = (maxv - minv) / 2;
      bestArea = area;
      bestAngle = Math.atan2(uy, ux);
    }
  }

  if (!Number.isFinite(bestArea) || bestArea <= 0) return null;
  return {
    cx: bestCx,
    cy: bestCy,
    hx: Math.max(MIN_EXTENT, bestHx),
    hy: Math.max(MIN_EXTENT, bestHy),
    angle: bestAngle,
  };
}

/** Half-extents are clamped to this, so a paper-thin wall is still a collider. */
const MIN_EXTENT = 1e-3;

/**
 * A triangle soup from projected points and the mesh's own triangle indices.
 *
 * Zero-area triangles are dropped. That is not a nicety: an extruded shape's side faces
 * collapse to slivers when flattened, and a physics engine cannot compute a normal for a
 * degenerate triangle. The front and back caps both survive and overlap, which harmlessly
 * double-fills the silhouette.
 */
export function trimesh2d(points: readonly Vec2[], indices: readonly number[]): Trimesh2D {
  const vertices: number[] = [];
  for (const [x, y] of points) vertices.push(x, y);
  const keep: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    const ax = points[a]?.[0] ?? 0;
    const ay = points[a]?.[1] ?? 0;
    const bx = points[b]?.[0] ?? 0;
    const by = points[b]?.[1] ?? 0;
    const cx = points[c]?.[0] ?? 0;
    const cy = points[c]?.[1] ?? 0;
    const area2 = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
    if (area2 > 1e-6) keep.push(a, b, c);
  }
  return { vertices, indices: keep };
}

/**
 * The circle enclosing a hull, centred on the midpoint of its bounding box.
 *
 * Not the minimum enclosing circle (Welzl's algorithm) — for a collider derived from a
 * roughly round mesh the two barely differ, and this one is trivially deterministic across
 * hosts, which matters far more when a client and a server must agree.
 */
export function boundingCircle(points: readonly Vec2[]): Circle2D {
  let minx = Infinity;
  let maxx = -Infinity;
  let miny = Infinity;
  let maxy = -Infinity;
  for (const [x, y] of points) {
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  let radius = 0;
  for (const [x, y] of points) radius = Math.max(radius, Math.hypot(x - cx, y - cy));
  return { cx, cy, radius: Math.max(MIN_EXTENT, radius) };
}

/**
 * A capsule along the hull's longer axis: the minimum-area box's long axis becomes the
 * segment, and its short half-extent becomes the radius. The segment is shortened by the
 * radius at each end so the capped ends land on the original box rather than outside it.
 */
export function boundingCapsule(points: readonly Vec2[]): Capsule2D {
  const box = minAreaBox(points);
  if (!box) {
    const circle = boundingCircle(points);
    return { ax: circle.cx, ay: circle.cy, bx: circle.cx, by: circle.cy, radius: circle.radius };
  }
  const alongX = box.hx >= box.hy;
  const half = alongX ? box.hx : box.hy;
  const radius = alongX ? box.hy : box.hx;
  const angle = box.angle + (alongX ? 0 : Math.PI / 2);
  const reach = Math.max(0, half - radius);
  const dx = Math.cos(angle) * reach;
  const dy = Math.sin(angle) * reach;
  return {
    ax: box.cx - dx,
    ay: box.cy - dy,
    bx: box.cx + dx,
    by: box.cy + dy,
    radius: Math.max(MIN_EXTENT, radius),
  };
}
