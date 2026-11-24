import { transformDirection, type LiminalMesh, type Mat4, type PlacedEntity } from '@liminal-lv/core';
import { collider2dFrom } from '@liminal-lv/collision-2d';
import { Vector3 } from 'three';

import { fromCollider, normalize, planar, type Aabb, type Polygon } from './physics.ts';

type Placed = Pick<PlacedEntity, 'transform' | 'world'>;

export function positionOf(entity: Placed): Vector3 {
  return new Vector3(...entity.transform.position);
}

export function forwardOf(entity: Placed): Vector3 {
  const [x, , z] = transformDirection(entity.world, [0, 0, -1]);
  return normalize(planar(x, z));
}

export function footprintOf(entity: {
  readonly mesh: LiminalMesh;
  readonly world: Mat4;
}): { polygon: Polygon; box: Aabb; top: number; bottom: number } | null {
  const collider = collider2dFrom(entity.mesh, entity.world, 'CONVEX', { plane: 'xz' });
  if (!collider) return null;
  const polygon = fromCollider(collider.points);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of polygon.points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  let top = -Infinity;
  let bottom = Infinity;
  const p = entity.mesh.positions;
  const m = entity.world;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const y = m[1]! * p[i]! + m[5]! * p[i + 1]! + m[9]! * p[i + 2]! + m[13]!;
    top = Math.max(top, y);
    bottom = Math.min(bottom, y);
  }
  return {
    polygon,
    box: { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2 },
    top,
    bottom,
  };
}

export function setWorldPosition(object: { parent: { worldToLocal(v: Vector3): Vector3 } | null; position: Vector3 }, world: Vector3): void {
  object.position.copy(object.parent ? object.parent.worldToLocal(world.clone()) : world);
}
