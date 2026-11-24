import { defineEntity, entityRuntime, LIMINAL_SIGNALS } from '@liminal-lv/core';
import { Color, Group, type Mesh, type MeshStandardMaterial } from 'three';

import { resolveCircleAabb, type Aabb } from '../physics.ts';
import { footprintOf } from '../placement.ts';
import { doorMesh } from '../render.ts';
import type { World } from '../world.ts';
import { BODY_KINDS, label } from './kinds.ts';

export const func_door = defineEntity({
  classname: 'func_door',
  description:
    'A sliding slab. Shape it in edit mode. With required at 0 it opens for anyone nearby; otherwise it opens once that many distinct senders hold targetname active. lock_name slams and locks it, unlock_name releases it.',
  metadata: {
    color: '#FBBF24',
    volume: true,
    gizmos: [
      { type: 'volume', color: '#FBBF24', alpha: '0.85', texture: 'gizmos/hazard.png', texture_scale: '48' },
      { type: 'arrow', length: '1', color: '#FBBF24', offset: '0,0,0' },
      label('{{targetname}} [{{required}}]', '#FBBF24'),
    ],
  },
  props: [
    { name: 'targetname', type: 'source', default_value: '', description: 'Senders that hold this name open the door.' },
    {
      name: 'required',
      type: 'int',
      default_value: 0,
      min: 0,
      max: 8,
      step: 1,
      description: 'Distinct active senders needed. Zero makes a proximity door.',
    },
    { name: 'lock_name', type: 'source', default_value: '', description: 'Activating this name closes and locks the door.' },
    { name: 'unlock_name', type: 'source', default_value: '', description: 'Activating this name unlocks the door.' },
    { name: 'start_locked', type: 'bool', default_value: false, description: 'Locked until unlock_name fires.' },
    { name: 'speed', type: 'float', default_value: 2.5, min: 0.5, max: 10, step: 0.5, description: 'Metres per second it slides.' },
  ],
});

const PROXIMITY_REACH = 1.6;

export class Door extends Group {
  readonly box: Aabb;
  readonly height: number;
  readonly required: number;
  readonly speed: number;
  readonly slab: Mesh;
  readonly active = new Set<string>();
  locked: boolean;
  open = 0;

  constructor(box: Aabb, height: number, required: number, speed: number, locked: boolean, slab: Mesh) {
    super();
    this.box = box;
    this.height = height;
    this.required = required;
    this.speed = speed;
    this.locked = locked;
    this.slab = slab;
    this.add(slab);
  }

  get solid(): boolean {
    return this.open < 0.85;
  }

  update(dt: number, world: World): void {
    const bodies = world.bodies();
    let wantOpen: boolean;
    if (this.locked) wantOpen = false;
    else if (this.required > 0) wantOpen = this.active.size >= this.required;
    else {
      const reachX = this.box.hx + PROXIMITY_REACH;
      const reachZ = this.box.hz + PROXIMITY_REACH;
      wantOpen = bodies.some(
        (b) => b.kind !== BODY_KINDS.Crate && Math.abs(b.pos.x - this.box.cx) < reachX && Math.abs(b.pos.z - this.box.cz) < reachZ,
      );
    }
    const rate = (this.speed / Math.max(this.height, 0.1)) * dt;
    if (wantOpen) this.open = Math.min(1, this.open + rate);
    else if (!bodies.some((b) => resolveCircleAabb(b.pos.clone(), b.r, this.box) !== null)) this.open = Math.max(0, this.open - rate);
    this.slab.position.y = -this.open * (this.height + 0.05);
    (this.slab.material as MeshStandardMaterial).emissive = this.locked ? new Color(0x7f1d1d) : new Color(0x402800);
  }
}

export const door = entityRuntime(func_door, {
  spawn: (placed) => {
    const footprint = footprintOf(placed);
    if (!footprint) throw new Error(`${placed.id}: the door's brush has no footprint on the play plane`);
    const { required, speed, start_locked } = placed.properties;
    return new Door(footprint.box, footprint.top - footprint.bottom, required, speed, start_locked, doorMesh(placed.mesh));
  },
  signals: {
    targetname: (door, message) => {
      if (message.sig === LIMINAL_SIGNALS.ACTIVATE) door.active.add(message.senderId);
      else door.active.delete(message.senderId);
    },
    lock_name: (door, message, world: World) => {
      if (message.sig !== LIMINAL_SIGNALS.ACTIVATE) return;
      door.locked = true;
      world.hud.say('Locked in!', 2);
    },
    unlock_name: (door, message) => {
      if (message.sig === LIMINAL_SIGNALS.ACTIVATE) door.locked = false;
    },
  },
});
