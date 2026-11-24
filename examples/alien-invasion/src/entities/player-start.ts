import { defineEntity } from '@liminal-lv/core';

import { BLENDER_FORWARD_EULER, label } from './kinds.ts';

export const info_player_start = defineEntity({
  classname: 'info_player_start',
  description:
    'Where the player appears. Local +Y is the facing direction. The frustum previews the camera from the first frame.',
  metadata: {
    color: '#4ADE80',
    gizmos: [
      { type: 'arrow', length: '1.5', euler: BLENDER_FORWARD_EULER, color: '#4ADE80' },
      { type: 'billboard', size: '0.5', texture: 'gizmos/player.png', offset: '0,0,0.9' },
      {
        type: 'frustum',
        near: '0.5',
        far: '16',
        offset: '0,-8,11',
        euler: '36,0,0',
        color: '#4ADE80',
        bindings: { fov: 'camera_fov' },
      },
      label('START', '#4ADE80'),
    ],
  },
  props: [
    {
      name: 'camera_fov',
      type: 'float',
      default_value: 42,
      min: 20,
      max: 90,
      step: 1,
      description: 'Vertical field of view of the follow camera, in degrees.',
    },
    {
      name: 'shells',
      type: 'int',
      default_value: 12,
      min: 0,
      max: 60,
      step: 1,
      description: 'Shotgun shells the player starts with.',
    },
  ],
});
