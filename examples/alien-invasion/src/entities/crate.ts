import { defineEntity, entityRuntime, type LiminalGizmoDef } from '@liminal-lv/core';
import { Group, Vector3 } from 'three';

import type { Aabb } from '../physics.ts';
import { positionOf, setWorldPosition } from '../placement.ts';
import { crateMesh } from '../render.ts';

const pushArrow = (euler: string): LiminalGizmoDef => ({
  type: 'arrow',
  length: '0.9',
  euler,
  offset: '0,0,0.5',
  color: '#C4A484',
});

export const prop_crate = defineEntity({
  classname: 'prop_crate',
  description:
    'A one metre crate the player shoves one tile at a time along the four cardinal directions. Place it on whole metre coordinates.',
  metadata: {
    color: '#C4A484',
    gizmos: [
      { type: 'box', size: '0.5', style: 'solid', alpha: '0.35', offset: '0,0,0.5', bindings: { color: 'tint' } },
      pushArrow('90,0,0'),
      pushArrow('-90,0,0'),
      pushArrow('0,-90,0'),
      pushArrow('0,90,0'),
    ],
  },
  props: [
    { name: 'tint', type: 'Color', default_value: [0.77, 0.64, 0.52, 1], description: 'Paint colour.' },
  ],
});

const SLIDE_SECONDS = 0.28;

export class Crate extends Group {
  readonly entityId: string;
  pos = new Vector3();
  slide: { from: Vector3; to: Vector3; t: number } | null = null;
  lean = 0;

  constructor(entityId: string, tint: readonly [number, number, number]) {
    super();
    this.entityId = entityId;
    this.add(crateMesh(tint));
  }

  box(shrink = 0): Aabb {
    return { cx: this.pos.x, cz: this.pos.z, hx: 0.5 - shrink, hz: 0.5 - shrink };
  }

  update(dt: number): void {
    if (!this.slide) return;
    this.slide.t = Math.min(1, this.slide.t + dt / SLIDE_SECONDS);
    const s = this.slide.t;
    this.pos.lerpVectors(this.slide.from, this.slide.to, s * s * (3 - 2 * s));
    if (s >= 1) this.slide = null;
    setWorldPosition(this, this.pos);
  }
}

export const crate = entityRuntime(prop_crate, {
  spawn: (placed) => {
    const [r, g, b] = placed.properties.tint;
    const result = new Crate(placed.id, [r, g, b]);
    result.pos.copy(positionOf(placed));
    return result;
  },
});
