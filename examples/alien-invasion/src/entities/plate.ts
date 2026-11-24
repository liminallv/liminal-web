import { defineEntity, entityRuntime } from '@liminal-lv/core';
import { Group, type Mesh, type MeshStandardMaterial, type Vector3 } from 'three';

import { positionOf } from '../placement.ts';
import { plateMesh } from '../render.ts';
import type { World } from '../world.ts';
import { BODY_TYPES, emitter, label, type BodyKind, type Emit } from './kinds.ts';

export const func_pressure_plate = defineEntity({
  classname: 'func_pressure_plate',
  description:
    'A one metre floor plate. Holds target active while something it accepts rests on it. With latch it stays on after the first press, which makes it a switch.',
  metadata: {
    color: '#60A5FA',
    gizmos: [
      {
        type: 'box',
        size_x: '0.5',
        size_y: '0.5',
        size_z: '0.05',
        style: 'solid',
        alpha: '0.4',
        color: '#60A5FA',
        offset: '0,0,0.05',
      },
      label('-> {{target}}', '#60A5FA'),
    ],
  },
  props: [
    { name: 'target', type: 'destination', default_value: '', description: 'Held active while pressed.' },
    { name: 'accepts', type: '$Body.Kind[]', default_value: 'Player,Crate', description: 'What can press it.' },
    { name: 'latch', type: 'bool', default_value: false, description: 'Stay pressed forever after the first press.' },
  ],
  types: BODY_TYPES,
});

export class Plate extends Group {
  readonly emit: Emit;
  readonly pos: Vector3;
  readonly target: string;
  readonly accepts: ReadonlySet<BodyKind>;
  readonly latch: boolean;
  readonly plate: Mesh;
  pressed = false;

  constructor(emit: Emit, pos: Vector3, target: string, accepts: readonly BodyKind[], latch: boolean) {
    super();
    this.emit = emit;
    this.pos = pos;
    this.target = target;
    this.accepts = new Set(accepts);
    this.latch = latch;
    this.plate = plateMesh();
    this.add(this.plate);
  }

  update(world: World): void {
    const pressedNow = world
      .bodies()
      .some((b) => this.accepts.has(b.kind) && Math.abs(b.pos.x - this.pos.x) < 0.45 && Math.abs(b.pos.z - this.pos.z) < 0.45);
    if (pressedNow && !this.pressed) {
      this.pressed = true;
      this.emit(this.target, true);
      world.view.flash(this.pos, 0x60a5fa, 3);
    } else if (!pressedNow && this.pressed && !this.latch) {
      this.pressed = false;
      this.emit(this.target, false);
    }
    (this.plate.material as MeshStandardMaterial).emissiveIntensity = this.pressed ? 1.4 : 0.3;
    this.plate.position.y = this.pressed ? 0.015 : 0.04;
  }
}

export const plate = entityRuntime(func_pressure_plate, {
  spawn: (placed, self) => {
    const { target, accepts, latch } = placed.properties;
    return new Plate(emitter(self), positionOf(placed), target, accepts, latch);
  },
});
