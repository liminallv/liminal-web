import { createRegistry } from '@liminal-lv/core';

import { counter, func_counter } from './counter.ts';
import { crate, prop_crate } from './crate.ts';
import { door, func_door } from './door.ts';
import { ammo, health, item_ammo, item_health } from './pickup.ts';
import { plate, func_pressure_plate } from './plate.ts';
import { info_player_start } from './player-start.ts';
import { func_exit_portal, portal } from './portal.ts';
import { ai_spawner, spawner } from './spawner.ts';
import { func_trigger, trigger } from './trigger.ts';
import { info_waypoint, waypoint } from './waypoint.ts';

export const REGISTRY = createRegistry(
  [
    info_player_start,
    info_waypoint,
    ai_spawner,
    item_health,
    item_ammo,
    func_door,
    func_trigger,
    func_exit_portal,
    func_counter,
    func_pressure_plate,
    prop_crate,
  ],
  { geoTags: ['floor', 'wall', 'cover'] },
);

export type Classname = (typeof REGISTRY.classnames)[number];

export const RUNTIMES = [spawner, waypoint, health, ammo, door, trigger, portal, counter, plate, crate] as const;
