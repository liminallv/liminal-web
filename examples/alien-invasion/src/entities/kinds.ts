import { LIMINAL_SIGNALS, type LiminalGizmoDef, type SpawnSelf } from '@liminal-lv/core';

export const MONSTER_KINDS = { Crawler: 0, Brute: 1, Spitter: 2 } as const;
export type MonsterKind = (typeof MONSTER_KINDS)[keyof typeof MONSTER_KINDS];

export const BODY_KINDS = { Player: 0, Crate: 1, Monster: 2 } as const;
export type BodyKind = (typeof BODY_KINDS)[keyof typeof BODY_KINDS];

export const BODY_TYPES = { 'Body.Kind': BODY_KINDS };

export type Emit = (name: string, on: boolean) => void;

export const emitter =
  (self: SpawnSelf): Emit =>
  (name, on) => {
    self.signal(name, on ? LIMINAL_SIGNALS.ACTIVATE : LIMINAL_SIGNALS.DEACTIVATE);
  };

export const BLENDER_FORWARD_EULER = '90,0,0';

export const label = (text: string, color: string, size = '12'): LiminalGizmoDef => ({
  type: 'text',
  text,
  size,
  color,
  offset: '0,0,1.2',
});
