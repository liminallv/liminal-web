import { BLENDER_UP_EULER, defineEntity, entityRuntime, LIMINAL_SIGNALS } from '@liminal-lv/core';
import { Group, type Vector3 } from 'three';

import { dist } from '../physics.ts';
import { positionOf } from '../placement.ts';
import { portalMesh } from '../render.ts';
import type { World } from '../world.ts';
import { label } from './kinds.ts';

export const func_exit_portal = defineEntity({
  classname: 'func_exit_portal',
  description: 'Ends the level when the player steps in. Can start dormant and be switched on by a signal.',
  metadata: {
    color: '#22D3EE',
    gizmos: [
      { type: 'cone', length: '3', angle: '12', style: 'solid', alpha: '0.2', euler: BLENDER_UP_EULER, color: '#22D3EE' },
      { type: 'sphere', style: 'wire', color: '#22D3EE', bindings: { radius: 'radius' } },
      { type: 'billboard', size: '0.6', texture: 'gizmos/portal.png', offset: '0,0,1.5' },
      label('EXIT', '#22D3EE'),
    ],
  },
  props: [
    { name: 'targetname', type: 'source', default_value: '', description: 'Activating this name switches the portal on.' },
    { name: 'enabled', type: 'bool', default_value: true, description: 'Active from the start.' },
    { name: 'radius', type: 'float', default_value: 1, min: 0.5, max: 4, step: 0.25, description: 'Capture radius.' },
    { name: 'next_level', type: 'String', default_value: '', description: 'Level to load next. Blank restarts.' },
  ],
});

export class Portal extends Group {
  readonly pos: Vector3;
  readonly radius: number;
  readonly next: string;
  readonly visual: Group;
  enabled: boolean;

  constructor(pos: Vector3, radius: number, enabled: boolean, next: string) {
    super();
    this.pos = pos;
    this.radius = radius;
    this.enabled = enabled;
    this.next = next;
    this.visual = portalMesh();
    this.add(this.visual);
  }

  update(world: World, kills: number): void {
    if (!this.enabled || dist(this.pos, world.player.pos) > this.radius) return;
    world.finish('EVACUATED', `${kills} kills. ${this.next ? `Next stop: ${this.next}.` : 'Outpost cleared.'}`, 'Play again');
  }

  animate(time: number): void {
    this.visible = this.enabled;
    this.visual.rotation.y = time;
    this.visual.scale.setScalar(1 + Math.sin(time * 4) * 0.04);
  }
}

export const portal = entityRuntime(func_exit_portal, {
  spawn: (placed) => {
    const { radius, enabled, next_level } = placed.properties;
    return new Portal(positionOf(placed), radius, enabled, next_level);
  },
  signals: {
    targetname: (portal, message) => {
      portal.enabled = message.sig === LIMINAL_SIGNALS.ACTIVATE;
    },
  },
});
