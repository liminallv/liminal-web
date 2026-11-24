import type { GeometryNode, LevelNode, Mat4, PlacedEntity } from '@liminal-lv/core';
import { Group, Matrix4, Mesh, Object3D } from 'three';

import { toBufferGeometry, toMaterial, type MaterialOptions } from './index.ts';

export interface SpawnedLookup {
  get(entityId: string): { readonly result: unknown } | undefined;
}

export interface SceneGraphOptions extends MaterialOptions {
  readonly spawned?: SpawnedLookup;
  readonly onMesh?: (mesh: Mesh, geometry: GeometryNode) => void;
}

type AnyLevelNode = LevelNode<PlacedEntity<string, object>>;

export function toObject3D(scene: { readonly roots: readonly AnyLevelNode[] }, options: SceneGraphOptions = {}): Group {
  const root = new Group();
  const placed = new Set<Object3D>();
  for (const node of scene.roots) root.add(build(node, options, placed));
  return root;
}

function build(node: AnyLevelNode, options: SceneGraphOptions, placed: Set<Object3D>): Object3D {
  const object = objectFor(node, options, placed);
  if (!object.name) object.name = node.name;
  object.userData['liminalId'] = node.id;
  setLocal(object, node.local);
  for (const child of node.children) object.add(build(child, options, placed));
  return object;
}

function objectFor(node: AnyLevelNode, options: SceneGraphOptions, placed: Set<Object3D>): Object3D {
  if (node.kind === 'geometry') {
    const meshes = node.geometry.map((geometry) => {
      const mesh = new Mesh(toBufferGeometry(geometry.mesh), toMaterial(geometry.mesh.material, options));
      mesh.name = geometry.path.slice(geometry.path.lastIndexOf('/') + 1);
      options.onMesh?.(mesh, geometry);
      return mesh;
    });
    if (meshes.length === 1) return meshes[0]!;
    const group = new Group();
    group.add(...meshes);
    return group;
  }
  if (node.kind === 'entity') {
    const result = options.spawned?.get(node.entity.id)?.result;
    if (result instanceof Object3D) {
      if (placed.has(result)) throw new Error(`toObject3D: entity "${node.id}" returned an object already placed in the level`);
      placed.add(result);
      return result;
    }
  }
  return new Group();
}

function setLocal(object: Object3D, local: Mat4): void {
  new Matrix4().fromArray([...local]).decompose(object.position, object.quaternion, object.scale);
}
