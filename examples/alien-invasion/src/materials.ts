import type { MaterialDescriptor } from '@liminal-lv/core';

export const MATERIALS: readonly MaterialDescriptor[] = [
  { id: 'wall_concrete', name: 'Concrete', color: [0.42, 0.43, 0.45, 1], metallic: 0, roughness: 0.9 },
  { id: 'wall_panel', name: 'Hull Panel', color: [0.28, 0.33, 0.42, 1], metallic: 0.6, roughness: 0.5 },
  { id: 'wall_hazard', name: 'Hazard', color: [0.9, 0.65, 0.1, 1], metallic: 0.2, roughness: 0.6 },
  { id: 'floor_plate', name: 'Deck Plate', color: [0.16, 0.17, 0.2, 1], metallic: 0.5, roughness: 0.7 },
  { id: 'floor_arena', name: 'Arena Deck', color: [0.24, 0.12, 0.12, 1], metallic: 0.3, roughness: 0.8 },
  {
    id: 'glow_cyan',
    name: 'Cyan Glow',
    color: [0.1, 0.6, 0.7, 1],
    metallic: 0,
    roughness: 0.3,
    emissive: [0.2, 1.2, 1.4],
  },
];
