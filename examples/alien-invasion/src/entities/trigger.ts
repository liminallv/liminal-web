import { defineEntity, entityRuntime } from '@liminal-lv/core';

import { pointInPolygon, type Polygon } from '../physics.ts';
import { footprintOf } from '../placement.ts';
import type { World } from '../world.ts';
import { BODY_TYPES, emitter, label, type BodyKind, type Emit } from './kinds.ts';

export const func_trigger = defineEntity({
  classname: 'func_trigger',
  description:
    'An invisible region. Signals on_enter when something it accepts comes in and on_exit when the last one leaves.',
  metadata: {
    color: '#34D399',
    volume: true,
    gizmos: [
      { type: 'volume', color: '#34D399', alpha: '0.3', texture: 'gizmos/grid.png', texture_scale: '32' },
      label('-> {{on_enter}}', '#34D399'),
    ],
  },
  props: [
    { name: 'on_enter', type: 'destination', default_value: '', description: 'Activated on first entry.' },
    { name: 'on_exit', type: 'destination', default_value: '', description: 'Activated when the region empties.' },
    { name: 'accepts', type: '$Body.Kind[]', default_value: 'Player', description: 'What can trip it.' },
    { name: 'once', type: 'bool', default_value: true, description: 'Fire the first entry only.' },
  ],
  types: BODY_TYPES,
});

export class Trigger {
  readonly emit: Emit;
  readonly polygon: Polygon;
  readonly onEnter: string;
  readonly onExit: string;
  readonly accepts: ReadonlySet<BodyKind>;
  readonly once: boolean;
  occupied = false;
  fired = false;

  constructor(emit: Emit, polygon: Polygon, onEnter: string, onExit: string, accepts: readonly BodyKind[], once: boolean) {
    this.emit = emit;
    this.polygon = polygon;
    this.onEnter = onEnter;
    this.onExit = onExit;
    this.accepts = new Set(accepts);
    this.once = once;
  }

  update(world: World): void {
    const occupied = world.bodies().some((b) => this.accepts.has(b.kind) && pointInPolygon(b.pos, this.polygon));
    if (occupied && !this.occupied) {
      if (!(this.once && this.fired)) {
        this.fired = true;
        this.emit(this.onEnter, true);
      }
    } else if (!occupied && this.occupied) {
      if (!this.once) this.emit(this.onEnter, false);
      this.emit(this.onExit, true);
    }
    this.occupied = occupied;
  }
}

export const trigger = entityRuntime(func_trigger, {
  spawn: (placed, self) => {
    const footprint = footprintOf(placed);
    if (!footprint) throw new Error(`${placed.id}: the trigger's brush has no footprint on the play plane`);
    const { on_enter, on_exit, accepts, once } = placed.properties;
    return new Trigger(emitter(self), footprint.polygon, on_enter, on_exit, accepts, once);
  },
});
