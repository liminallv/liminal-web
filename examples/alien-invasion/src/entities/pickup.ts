import { defineEntity, entityRuntime } from '@liminal-lv/core';
import { Group, type Vector3 } from 'three';

import { dist } from '../physics.ts';
import { positionOf } from '../placement.ts';
import { pickupMesh } from '../render.ts';
import { PLAYER_MAX_HP, type World } from '../world.ts';

export const item_health = defineEntity({
  classname: 'item_health',
  description: 'Restores health on touch.',
  metadata: {
    color: '#F472B6',
    gizmos: [
      { type: 'billboard', size: '0.45', texture: 'gizmos/health.png', offset: '0,0,0.6' },
      { type: 'sphere', radius: '0.5', style: 'wire', color: '#F472B6' },
    ],
  },
  props: [
    { name: 'amount', type: 'int', default_value: 25, min: 5, max: 100, step: 5, description: 'Health restored.' },
    {
      name: 'respawn',
      type: 'float',
      default_value: 0,
      min: 0,
      max: 120,
      step: 5,
      description: 'Seconds until it comes back. Zero means once only.',
    },
  ],
});

export const item_ammo = defineEntity({
  classname: 'item_ammo',
  description: 'A box of shotgun shells.',
  metadata: {
    color: '#FBBF24',
    gizmos: [
      { type: 'billboard', size: '0.45', texture: 'gizmos/ammo.png', offset: '0,0,0.6' },
      { type: 'sphere', radius: '0.5', style: 'wire', color: '#FBBF24' },
    ],
  },
  props: [
    { name: 'shells', type: 'int', default_value: 8, min: 1, max: 40, step: 1, description: 'Shells in the box.' },
    {
      name: 'respawn',
      type: 'float',
      default_value: 0,
      min: 0,
      max: 120,
      step: 5,
      description: 'Seconds until it comes back. Zero means once only.',
    },
  ],
});

export class Pickup extends Group {
  readonly kind: 'health' | 'ammo';
  readonly pos: Vector3;
  readonly amount: number;
  readonly respawn: number;
  readonly visual: Group;
  timer = 0;
  taken = false;

  constructor(kind: 'health' | 'ammo', pos: Vector3, amount: number, respawn: number) {
    super();
    this.kind = kind;
    this.pos = pos;
    this.amount = amount;
    this.respawn = respawn;
    this.visual = pickupMesh(kind);
    this.add(this.visual);
  }

  update(dt: number, world: World): void {
    if (this.taken) {
      if (this.respawn <= 0) return;
      this.timer -= dt;
      if (this.timer <= 0) this.taken = false;
      return;
    }
    const player = world.player;
    if (dist(this.pos, player.pos) > player.r + 0.45) return;
    if (this.kind === 'health') {
      if (player.hp >= PLAYER_MAX_HP) return;
      player.hp = Math.min(PLAYER_MAX_HP, player.hp + this.amount);
      world.hud.say(`+${this.amount} health`, 1.2);
    } else {
      player.shells += this.amount;
      world.hud.say(`+${this.amount} shells`, 1.2);
    }
    this.taken = true;
    this.timer = this.respawn;
    world.view.flash(this.pos, this.kind === 'health' ? 0xff80a0 : 0xffd060, 4);
  }

  animate(time: number): void {
    this.visible = !this.taken;
    this.visual.position.y = 0.55 + Math.sin(time * 3) * 0.08;
    this.visual.rotation.y = time * 1.5;
  }
}

export const health = entityRuntime(item_health, {
  spawn: (placed) => new Pickup('health', positionOf(placed), placed.properties.amount, placed.properties.respawn),
});

export const ammo = entityRuntime(item_ammo, {
  spawn: (placed) => new Pickup('ammo', positionOf(placed), placed.properties.shells, placed.properties.respawn),
});
