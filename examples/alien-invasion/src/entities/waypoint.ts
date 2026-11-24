import { defineEntity, entityRuntime } from '@liminal-lv/core';
import { Group } from 'three';

import { waypointMarker } from '../render.ts';
import { label } from './kinds.ts';

export const info_waypoint = defineEntity({
  classname: 'info_waypoint',
  description:
    'One stop on a patrol route. Parent several under an ai_spawner and its path gizmo draws the route in child order.',
  metadata: {
    color: '#A78BFA',
    gizmos: [
      { type: 'sphere', radius: '0.25', style: 'solid', color: '#A78BFA', alpha: '0.5' },
      label('{{wait}}s', '#A78BFA', '10'),
    ],
  },
  props: [
    {
      name: 'wait',
      type: 'float',
      default_value: 1,
      min: 0,
      max: 10,
      step: 0.5,
      description: 'Seconds a patrolling monster lingers here.',
    },
  ],
});

export const waypoint = entityRuntime(info_waypoint, {
  spawn: () => new Group().add(waypointMarker()),
});
