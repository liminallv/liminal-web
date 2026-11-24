import { parseScene } from '@liminal-lv/core';
import { collider2dFrom } from '@liminal-lv/collision-2d';

import { REGISTRY } from './entities/index.ts';
import { fromCollider, type Polygon } from './physics.ts';

const parseLevel = (bytes: Uint8Array, name: string) => parseScene(bytes, REGISTRY, { name });

export type LevelScene = ReturnType<typeof parseLevel>;

export interface Level {
  readonly scene: LevelScene;
  readonly walls: readonly Polygon[];
}

export async function loadLevel(url: string, name: string): Promise<Level> {
  const buffer: ArrayBuffer = await fetch(url).then((r) => r.arrayBuffer());
  const scene = parseLevel(new Uint8Array(buffer), name);
  const walls: Polygon[] = [];
  for (const node of scene.geometry) {
    if (node.tags.includes('floor')) continue;
    const collider = collider2dFrom(node.mesh, node.world, node.collision, { plane: 'xz' });
    if (collider) walls.push(fromCollider(collider.points));
  }
  return { scene, walls };
}
