import { defineEntity, entityRuntime, LIMINAL_SIGNALS, type LevelNode, type PlacedFrom } from '@liminal-lv/core';

import type { Vector3 } from 'three';

import { positionOf } from '../placement.ts';
import type { World } from '../world.ts';
import { emitter, label, MONSTER_KINDS, type Emit, type MonsterKind } from './kinds.ts';

export const ai_spawner = defineEntity({
  classname: 'ai_spawner',
  description:
    'Spawns monsters in waves, scattered within radius. Starts when signalled on targetname, or immediately with auto_start. Child info_waypoint entities become the patrol route of what it spawns.',
  metadata: {
    color: '#F87171',
    gizmos: [
      { type: 'sphere', style: 'wire', color: '#F87171', bindings: { radius: 'radius' } },
      { type: 'billboard', size: '0.6', texture: 'gizmos/alien.png', offset: '0,0,1' },
      { type: 'path', mode: 'hierarchy', closed: 'true', color: '#A78BFA' },
      label('{{monster}} x{{count}} x{{waves}}', '#F87171'),
    ],
  },
  props: [
    { name: 'targetname', type: 'source', default_value: '', description: 'Signal this name to start the waves.' },
    { name: 'monster', type: '$Monster.Kind', default_value: 'Crawler', description: 'What this spawner produces.' },
    { name: 'count', type: 'int', default_value: 3, min: 1, max: 12, step: 1, description: 'Monsters per wave.' },
    { name: 'waves', type: 'int', default_value: 1, min: 1, max: 10, step: 1, description: 'How many waves.' },
    {
      name: 'interval',
      type: 'float',
      default_value: 4,
      min: 0.5,
      max: 30,
      step: 0.5,
      description: 'Seconds between waves.',
    },
    { name: 'radius', type: 'float', default_value: 2, min: 0.5, max: 8, step: 0.5, description: 'Spawn scatter radius.' },
    { name: 'auto_start', type: 'bool', default_value: false, description: 'Start on level load instead of waiting for a signal.' },
    { name: 'on_kill', type: 'destination', default_value: '', description: 'Signalled once per monster killed.' },
    { name: 'on_cleared', type: 'destination', default_value: '', description: 'Signalled when every wave is dead.' },
  ],
  types: { 'Monster.Kind': MONSTER_KINDS },
});

export interface PatrolStop {
  readonly pos: Vector3;
  readonly wait: number;
}

export class Spawner {
  readonly emit: Emit;
  readonly pos: Vector3;
  readonly kind: MonsterKind;
  readonly count: number;
  readonly interval: number;
  readonly radius: number;
  readonly onKill: string;
  readonly onCleared: string;
  readonly patrol: readonly PatrolStop[];
  readonly announce: boolean;
  wavesLeft: number;
  timer = 0;
  started = false;
  alive = 0;
  cleared = false;

  constructor(emit: Emit, pos: Vector3, props: PlacedFrom<typeof ai_spawner>['properties'], patrol: readonly PatrolStop[]) {
    this.emit = emit;
    this.pos = pos;
    this.kind = props.monster;
    this.count = props.count;
    this.wavesLeft = props.waves;
    this.interval = props.interval;
    this.radius = props.radius;
    this.onKill = props.on_kill;
    this.onCleared = props.on_cleared;
    this.patrol = patrol;
    this.announce = !props.auto_start;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = 0;
  }

  update(dt: number, world: World): void {
    if (!this.started || this.wavesLeft === 0) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.interval;
    this.wavesLeft--;
    for (let i = 0; i < this.count; i++) world.spawnMonster(this);
    if (this.announce) world.hud.say(this.wavesLeft > 0 ? 'Wave incoming' : 'Final wave', 1.5);
  }

  monsterKilled(): void {
    this.alive--;
    this.emit(this.onKill, true);
    if (this.alive === 0 && this.wavesLeft === 0 && !this.cleared) {
      this.cleared = true;
      this.emit(this.onCleared, true);
    }
  }
}

function patrolUnder(node: LevelNode): PatrolStop[] {
  const stops: { name: string; stop: PatrolStop }[] = [];
  const visit = (child: LevelNode): void => {
    if (child.kind === 'entity' && child.entity.classname === 'info_waypoint') {
      const wait = child.entity.properties['wait'];
      stops.push({ name: child.name, stop: { pos: positionOf(child.entity), wait: typeof wait === 'number' ? wait : 1 } });
    }
    child.children.forEach(visit);
  };
  node.children.forEach(visit);
  return stops.sort((a, b) => a.name.localeCompare(b.name)).map((s) => s.stop);
}

export const spawner = entityRuntime(ai_spawner, {
  spawn: (placed, self) => {
    const result = new Spawner(emitter(self), positionOf(placed), placed.properties, patrolUnder(self.node));
    if (placed.properties.auto_start) result.start();
    return result;
  },
  signals: {
    targetname: (spawner, message) => {
      if (message.sig === LIMINAL_SIGNALS.ACTIVATE) spawner.start();
    },
  },
});
