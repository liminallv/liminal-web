// @liminal-lv/core — read Liminal Editor levels, describe entities for its Blender addon.
//
// Engine-agnostic and dependency-free. Nothing here imports a renderer, a physics engine,
// the DOM, or Node: the same module graph runs in a browser bundle and on an authoritative
// server, which is what lets both resolve a level to byte-identical geometry.
//
// The GLB *writer* is a separate entry point (`@liminal-lv/core/glb-write`) so that a game
// client, which only ever reads levels, does not bundle it.

export * from './contract.ts';
export * from './math.ts';
export * from './glb/read.ts';
export * from './registry.ts';
export * from './definition.ts';
export * from './scene.ts';
export * from './props.ts';
export * from './runtime.ts';
export * from './wiring.ts';
export * from './materials.ts';
