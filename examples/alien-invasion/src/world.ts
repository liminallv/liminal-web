import type { Group, Vector3 } from 'three';

import type { BodyKind } from './entities/kinds.ts';
import type { Spawner } from './entities/spawner.ts';
import type { Hud } from './hud.ts';
import type { View } from './render.ts';

export const PLAYER_MAX_HP = 100;

export interface Player {
  pos: Vector3;
  r: number;
  hp: number;
  shells: number;
  facing: Vector3;
  cooldown: number;
  hurt: number;
  mesh: Group;
}

export interface Body {
  kind: BodyKind;
  pos: Vector3;
  r: number;
}

export interface World {
  readonly view: View;
  readonly hud: Hud;
  readonly player: Player;
  bodies(): Body[];
  spawnMonster(spawner: Spawner): void;
  finish(title: string, text: string, button: string): void;
}
