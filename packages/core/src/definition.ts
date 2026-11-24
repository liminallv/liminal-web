// Authored entity definitions — "an entity is a script plus an `.lm`".
//
// A placeable entity may carry its own authored mini-scene, built in Blender exactly like a
// level and exported through the same operator. It can hold `LM_geo` meshes, brush volumes,
// and nested `LM_entity` children — which is how a landing port bundles a mast with a strobe
// on top of it, or a door bundles its frame with the trigger that opens it.
//
// Parsing is split from placement on purpose: the bytes are parsed once per classname and
// cached, while instantiation re-runs per placed instance, because placing a definition
// means composing every one of its transforms with the instance's own.

import { LM_ENTITY_EXTENSION, LM_GEO_EXTENSION, isLmCollisionKind } from './contract.ts';
import type { LmCollisionKind, LmEntityExtension, LmGeoExtension } from './contract.ts';
import {
  flattenScene,
  mergePrimitives,
  mergePrimitivesByMaterial,
  parseGlb,
  readAnimations,
  readMeshPrimitives,
  type FlatNode,
  type Glb,
  type MergedGeometry,
} from './glb/read.ts';
import type { Mat4 } from './math.ts';

/** Mesh data as it comes out of a `.lm`, in its own local frame. */
export interface LiminalMesh extends MergedGeometry {}

/** One `LM_geo` node, still in the frame of the file it was authored in. */
export interface GeometryEntry {
  /** The glTF node index, shared by the entries one multi-material node splits into. */
  readonly index: number;
  /** Slash-joined path within the file, e.g. `Mast/Strobe`. */
  readonly path: string;
  readonly world: Mat4;
  readonly collision: LmCollisionKind;
  readonly tags: readonly string[];
  readonly mesh: LiminalMesh;
}

/** One `LM_entity` node, still in the frame of the file it was authored in. */
export interface EntityEntry {
  readonly index: number;
  readonly path: string;
  readonly world: Mat4;
  readonly extension: LmEntityExtension;
  /**
   * The mesh riding the `LM_entity` node itself. Non-null only for a **volume** entity —
   * one the addon spawns as an editable brush rather than an Empty. What that mesh means
   * (a collider, a trigger region, a spawn area, all three) is your game's decision.
   */
  readonly mesh: LiminalMesh | null;
}

/** One TRS channel of a clip, still in the frame of the file it was authored in. */
export interface AnimationTrackEntry {
  /** The animated node's `path` within this file — matches a `GeometryEntry.path` when the
   *  same node also carries a mesh, and an `AnimatedNodeEntry.path` either way. */
  readonly targetPath: string;
  readonly property: 'translation' | 'rotation' | 'scale';
  readonly times: readonly number[];
  readonly values: readonly (readonly number[])[];
  readonly interpolation: 'LINEAR' | 'STEP';
}

/** One named glTF animation — one Blender Action, one clip. */
export interface ClipEntry {
  readonly name: string;
  readonly tracks: readonly AnimationTrackEntry[];
}

/**
 * The rest pose of a node that at least one clip's track targets, even when that node carries
 * no mesh of its own (a bare pivot Empty — the hinge-pivot authoring pattern). `GeometryEntry`
 * only exists for nodes with real `LM_geo` + mesh data, so this fills the gap: one entry per
 * DISTINCT animated node in the file, keyed by node index and deduplicated that way rather
 * than by `path` (paths are not deduplicated across siblings — a pre-existing limitation this
 * does not compound).
 */
export interface AnimatedNodeEntry {
  readonly path: string;
  readonly world: Mat4;
}

/** The parsed contents of one `.lm`, before anything is placed. */
export interface ParsedDefinition {
  /** Every node of the file's tree, scene wrapper excluded, parents before children. */
  readonly nodes: readonly FlatNode[];
  readonly geometry: readonly GeometryEntry[];
  readonly entities: readonly EntityEntry[];
  readonly clips: readonly ClipEntry[];
  readonly animatedNodes: readonly AnimatedNodeEntry[];
}

/**
 * Read every `LM_geo` and `LM_entity` node out of a `.lm`'s scene graph.
 *
 * Used for both halves of the format, because they are the same format: a level is a `.lm`
 * and so is an authored entity definition. The only difference is what the caller does with
 * the result.
 */
export function readDefinition(glb: Glb, flat: readonly FlatNode[]): ParsedDefinition {
  const geometry: GeometryEntry[] = [];
  const entities: EntityEntry[] = [];
  const byIndex = new Map(flat.map((entry) => [entry.index, entry]));

  for (const entry of flat) {
    const extensions = entry.node.extensions;
    if (!extensions) continue;

    const entityExt = extensions[LM_ENTITY_EXTENSION] as LmEntityExtension | undefined;
    if (entityExt) {
      entities.push({
        index: entry.index,
        path: entry.path,
        world: entry.world,
        extension: entityExt,
        mesh: nodeMesh(glb, entry),
      });
      // An `LM_entity` node never also carries `LM_geo`: the export hook writes the entity
      // extension and returns before it would reach the geometry branch.
      continue;
    }

    const geoExt = extensions[LM_GEO_EXTENSION] as LmGeoExtension | undefined;
    if (!geoExt) continue;
    const meshes = nodeMeshesByMaterial(glb, entry);
    if (meshes.length === 0) continue; // an LM_geo node with no mesh is nothing at all
    // One material slot (the overwhelming common case) keeps the node's bare name. More than
    // one — a designer put several materials on the same Blender object — becomes one
    // GeometryEntry per material, suffixed by that material's name so each stays individually
    // addressable and none silently wins over the others the way a plain merge would (see
    // `mergePrimitivesByMaterial`).
    for (const [i, mesh] of meshes.entries()) {
      const suffix = meshes.length === 1 ? '' : `.${mesh.material?.name ?? i}`;
      geometry.push({
        index: entry.index,
        path: `${entry.path}${suffix}`,
        world: entry.world,
        // A malformed or unknown kind falls back to CONCAVE — the shape that fills exactly
        // what the designer modelled, which is the least surprising thing to collide with.
        collision: isLmCollisionKind(geoExt.collision) ? geoExt.collision : 'CONCAVE',
        tags: geoExt.tags ?? [],
        mesh,
      });
    }
  }

  const clips: ClipEntry[] = [];
  const animatedNodes = new Map<number, AnimatedNodeEntry>();
  for (const raw of readAnimations(glb, flat)) {
    const tracks: AnimationTrackEntry[] = [];
    for (const track of raw.tracks) {
      const node = byIndex.get(track.nodeIndex);
      if (!node) continue; // readAnimations already filters unknown nodes; defensive here too
      tracks.push({
        targetPath: node.path,
        property: track.path,
        times: track.times,
        values: track.values,
        interpolation: track.interpolation,
      });
      if (!animatedNodes.has(track.nodeIndex)) {
        animatedNodes.set(track.nodeIndex, { path: node.path, world: node.world });
      }
    }
    if (tracks.length > 0) clips.push({ name: raw.name, tracks });
  }

  return {
    nodes: flat.filter((entry) => !entry.wrapper),
    geometry,
    entities,
    clips,
    animatedNodes: Array.from(animatedNodes.values()),
  };
}

/** The merged mesh hanging off one node, or null when it has none (or it is empty). */
function nodeMesh(glb: Glb, entry: FlatNode): LiminalMesh | null {
  const meshIndex = entry.node.mesh;
  if (meshIndex === undefined) return null;
  const merged = mergePrimitives(readMeshPrimitives(glb, meshIndex));
  return merged.positions.length === 0 ? null : merged;
}

/**
 * Every mesh hanging off one `LM_geo` node, one per distinct material. Empty when the node
 * has no mesh. Unlike `nodeMesh`, nothing is dropped when a node carries more than one
 * material slot — see `mergePrimitivesByMaterial`.
 */
function nodeMeshesByMaterial(glb: Glb, entry: FlatNode): LiminalMesh[] {
  const meshIndex = entry.node.mesh;
  if (meshIndex === undefined) return [];
  return mergePrimitivesByMaterial(readMeshPrimitives(glb, meshIndex)).filter(
    (mesh) => mesh.positions.length > 0,
  );
}

/**
 * Parse one `.lm` and cache the result **on the bytes object**.
 *
 * A definition supplied once and placed fifty times is decoded once; re-supplying different
 * bytes re-parses rather than serving a stale definition, which is what makes this safe to
 * use behind a hot-reloading asset pipeline.
 */
const cache = new WeakMap<object, ParsedDefinition>();

export function parseDefinition(bytes: Uint8Array): ParsedDefinition {
  const hit = cache.get(bytes);
  if (hit) return hit;
  const glb = parseGlb(bytes);
  const def = readDefinition(glb, flattenScene(glb));
  cache.set(bytes, def);
  return def;
}
