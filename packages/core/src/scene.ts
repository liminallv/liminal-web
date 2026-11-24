// The importer: `.lm` bytes → a resolved, engine-neutral scene.
//
// This is the single resolution point for a level. A browser client, a headless build
// script and an authoritative game server all come through here, on the same bytes, and get
// the same answer — which for a networked game is not a convenience but a requirement.
//
// What it deliberately does NOT do:
//
//   • decide what a mesh collides as. It hands you the mesh, the designer's collision kind
//     and a world matrix; turning that into a collider is your engine's business, and
//     `@liminal-lv/collision-2d` / `@liminal-lv/collision-3d` are opt-in helpers, not a dependency.
//   • decide what an entity IS. Every `LM_entity` node comes back as a placed entity, brush
//     volumes included. Whether `func_collision_volume` should become an invisible wall and
//     no entity at all is a rule about *your* vocabulary; apply it to the result.
//   • flatten to 2D. Placements keep their full 4x4 matrix. A 2D game reads the two axes it
//     cares about (see `zRotationOf` / `yRotationOf` in `math.ts`) and ignores the rest.
//
// What it does do is everything that is genuinely the *format's* problem: prop coercion
// against the registry, mapping Blender's exported choice labels back to your values,
// resolving nested authored definitions, and refusing the shapes that cannot be resolved
// at all.

import type { LiminalPropDef, LmCollisionKind, LmEntityExtension } from './contract.ts';
import { parseDefinition, readDefinition, type LiminalMesh } from './definition.ts';
import { flattenScene, parseGlb, type FlatNode } from './glb/read.ts';
import { decomposeTrs, multiplyMat4, type Mat4, type Trs } from './math.ts';
import type { PlacedOf } from './props.ts';
import type { EntityDescriptor, EntityRegistry, RegistryView } from './registry.ts';

/** Thrown for a level that cannot be resolved at all, as opposed to one that merely warns. */
export class LiminalImportError extends Error {}

/** A property value after resolution: a choice label has been mapped back to its value. */
export type PropValue = number | string | boolean | readonly (number | string)[];

/**
 * One placed entity.
 *
 * `world` is authoritative and complete; `transform` is the same thing decomposed, for the
 * common case of feeding a scene-graph node. A 2D game usually wants neither in full — read
 * `transform.position` and one rotation axis.
 */
export interface PlacedEntity<C extends string = string, P = Readonly<Record<string, PropValue>>, M extends LiminalMesh | null = LiminalMesh | null> {
  /** The node's path in the level, the same id its `LevelNode` carries. */
  readonly id: string;
  readonly classname: C;
  /** Slash-joined path within the file this node was authored in. */
  readonly path: string;
  /** Full 4x4 column-major placement, in scene space. */
  readonly world: Mat4;
  readonly transform: Trs;
  readonly properties: P;
  /** The per-instance note the designer typed in Blender, if any. Documentation only. */
  readonly description?: string;
  /**
   * The mesh riding this entity's own node — present only for a **volume** entity, which
   * the addon spawns as an editable brush. This is the raw shape the designer drew; what it
   * becomes is up to you.
   */
  readonly mesh: M;
  /** Set when this entity came out of another entity's definition, naming its owner. */
  readonly parentId?: string;
}

interface LevelNodeBase<E> {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly local: Mat4;
  readonly world: Mat4;
  readonly parent: LevelNode<E> | null;
  readonly children: readonly LevelNode<E>[];
}

export interface GroupNode<E = PlacedEntity> extends LevelNodeBase<E> {
  readonly kind: 'group';
}

export interface EntityNode<E = PlacedEntity> extends LevelNodeBase<E> {
  readonly kind: 'entity';
  readonly entity: E;
}

export interface MeshNode<E = PlacedEntity> extends LevelNodeBase<E> {
  readonly kind: 'geometry';
  readonly geometry: readonly GeometryNode[];
}

export type LevelNode<E = PlacedEntity> = GroupNode<E> | EntityNode<E> | MeshNode<E>;

/** One `LM_geo` mesh, placed. */
export interface GeometryNode {
  readonly id: string;
  readonly path: string;
  readonly world: Mat4;
  /** The designer's per-mesh collision kind. `NONE` means decoration: draw it, never collide. */
  readonly collision: LmCollisionKind;
  /** Per-mesh tags, drawn from the manifest's `geo_tags` vocabulary. */
  readonly tags: readonly string[];
  /** Local-space geometry. Apply `world` to place it. */
  readonly mesh: LiminalMesh;
  /** Set when this mesh came out of a placed entity's definition, naming its owner. */
  readonly entityId?: string;
}

/**
 * The rest pose of one node that a clip animates, placed in scene space. Exists independently
 * of `GeometryNode` because an animated node may be a bare pivot with no mesh of its own — see
 * `AnimatedNodeEntry` in `definition.ts` for why this can't just ride on the geometry list.
 */
export interface AnimationTarget {
  /** `"<entityId>/<path>"` — same id scheme `GeometryNode` uses for nested-definition meshes. */
  readonly id: string;
  /** Path relative to the owning entity's definition — matches a `GeometryNode.path`/
   *  `AnimationTrack.targetPath` at the same node. */
  readonly path: string;
  readonly world: Mat4;
  /** Always set on a target that reaches `LiminalScene.animationTargets` — a level-scope
   *  target (no owning entity) never leaves `parseScene` (see the "level-scope clips" note
   *  on `AnimationClip.entityId`). */
  readonly entityId?: string;
}

/** One TRS channel of a placed clip. `targetPath` stays relative to the owning entity's
 *  definition — exactly how `GeometryNode.path` stays relative while `GeometryNode.id` gets
 *  the owner prefix — so it addresses an `AnimationTarget` by `` `${clip.entityId}/${targetPath}` ``. */
export interface AnimationTrack {
  readonly targetPath: string;
  readonly property: 'translation' | 'rotation' | 'scale';
  readonly times: readonly number[];
  readonly values: readonly (readonly number[])[];
  readonly interpolation: 'LINEAR' | 'STEP';
}

/**
 * One named clip, placed. Only ever produced for a clip authored inside an entity's own `.lm`
 * definition — a clip authored at a level's top scope has no unambiguous single owner to
 * attribute it to (unlike geometry, which DeliverD-side callers resolve against the level's
 * own outliner; that ambiguity is explicitly not solved for clips here), so `parseScene` warns
 * about it via `LiminalScene.warnings` instead of placing it, and `entityId` is consequently
 * always defined on every entry that actually reaches this list.
 */
export interface AnimationClip {
  /** `"<entityId>/<clip name>"`. */
  readonly id: string;
  readonly name: string;
  readonly tracks: readonly AnimationTrack[];
  readonly entityId?: string;
}

export interface LiminalScene<C extends string = string, E extends PlacedEntity<C, object> = PlacedEntity<C>> {
  readonly name: string;
  /** Every `LM_entity` node, nested ones included. The order carries no meaning, but the same bytes always give the same order. */
  readonly entities: readonly E[];
  readonly roots: readonly LevelNode<E>[];
  readonly registry: RegistryView;
  /** Every `LM_geo` node, scene geometry first, then per-entity definition geometry. */
  readonly geometry: readonly GeometryNode[];
  /** Every named clip authored inside a placed entity's own `.lm` definition. */
  readonly clips: readonly AnimationClip[];
  /** Every node any clip in `clips` targets, placed. */
  readonly animationTargets: readonly AnimationTarget[];
  /**
   * Non-fatal drift, in the order it was found. Almost always a level authored against an
   * older manifest revision. Surface these somewhere a designer will read them.
   */
  readonly warnings: readonly string[];
}

export interface ParseSceneOptions {
  /** Name for the resulting scene, and for error messages. Defaults to `"unnamed"`. */
  readonly name?: string;
  /**
   * Authored entity definitions — `.lm` bytes by classname.
   *
   * Supplied by the caller rather than read here, because this function has no filesystem:
   * a browser bundles them, a server and a build script read them off disk. Omit it and
   * entities resolve as bare placements with no geometry of their own.
   *
   * **It must be the same map on every host.** These bytes produce colliders, so a client
   * running without them, or with a stale export, has different physics from the server.
   * If you have a handshake, fingerprint them in it.
   */
  readonly definitions?: ReadonlyMap<string, Uint8Array>;
  /**
   * How deep one entity may nest another. A true cycle is caught exactly, by ancestry; this
   * only stops a pathological but acyclic chain from blowing the stack. Defaults to 8.
   */
  readonly maxDepth?: number;
  /**
   * What to do with a classname that is not in the registry.
   *
   * `'throw'` (the default) is right for a game: an unknown classname means the level was
   * authored against a manifest this build does not have, and silently dropping the entity
   * turns that into a level which loads and is subtly wrong. `'warn'` suits a tool that
   * wants to report on a level it cannot fully resolve.
   */
  readonly unknownClassname?: 'throw' | 'warn' | 'ignore';
}

const DEFAULT_MAX_DEPTH = 8;

/**
 * Parse a `.lm` into a resolved scene. Accepts the raw bytes from `fetch` or `readFile`.
 *
 * The classname type is inferred from the registry's own `classnames`, so passing a
 * concrete `EntityRegistry` gives you `PlacedEntity<'func_door' | 'env_light' | …>` and
 * exhaustive switches over it typecheck. A tool holding only a `RegistryView` — one built
 * at runtime from a manifest, say — gets `PlacedEntity<string>` and everything still works.
 */
export function parseScene<T extends Record<string, EntityDescriptor>>(
  data: ArrayBuffer | Uint8Array,
  registry: EntityRegistry<T>,
  options?: ParseSceneOptions,
): LiminalScene<keyof T & string, PlacedOf<T>>;
export function parseScene<C extends string = string>(
  data: ArrayBuffer | Uint8Array,
  registry: RegistryView & { readonly classnames: readonly C[] },
  options?: ParseSceneOptions,
): LiminalScene<C>;
export function parseScene(
  data: ArrayBuffer | Uint8Array,
  registry: RegistryView,
  options: ParseSceneOptions = {},
): LiminalScene {
  const ctx: Context = {
    registry,
    name: options.name ?? 'unnamed',
    definitions: options.definitions ?? EMPTY_DEFINITIONS,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    unknown: options.unknownClassname ?? 'throw',
    warnings: [],
    entities: [],
    geometry: [],
    clips: [],
    animationTargets: [],
  };

  const glb = parseGlb(data);
  const flat = flattenScene(glb);
  const root = readDefinition(glb, flat);
  const content: NodeContent = { entities: new Map(), geometry: new Map() };

  for (const entry of root.entities) {
    const placed = resolveEntry(ctx, entry.extension, entry.world, entry.path, entry.path, entry.mesh, undefined);
    if (!placed) continue;
    ctx.entities.push(placed);
    content.entities.set(entry.index, placed);
  }

  for (const entry of root.geometry) {
    const geometry: GeometryNode = {
      id: entry.path,
      path: entry.path,
      world: entry.world,
      collision: entry.collision,
      tags: entry.tags,
      mesh: entry.mesh,
    };
    ctx.geometry.push(geometry);
    addGeometry(content, entry.index, geometry);
  }

  const tree = buildTree(root.nodes, content, '', null, null);

  // A clip authored at the LEVEL's own top scope, rather than inside an entity's `.lm`
  // definition, has no unambiguous owner to attribute it to — `expand()` below is the only
  // place that knows "whose definition is this", so a root-scope clip is warned about and
  // dropped rather than placed. `root.animatedNodes` needs no matching warning: it is inert
  // without a clip referencing it.
  for (const clip of root.clips) {
    ctx.warnings.push(
      `animation "${clip.name}" is authored at the level's top scope — clips are only ` +
        "supported inside an entity's own .lm definition, and this one is ignored",
    );
  }

  for (const node of tree.entityNodes) expand(ctx, node, []);

  return {
    name: ctx.name,
    entities: ctx.entities,
    roots: tree.roots as unknown as LevelNode[],
    registry,
    geometry: ctx.geometry,
    clips: ctx.clips,
    animationTargets: ctx.animationTargets,
    warnings: ctx.warnings,
  };
}

const EMPTY_DEFINITIONS: ReadonlyMap<string, Uint8Array> = new Map();

interface Context {
  readonly registry: RegistryView;
  readonly name: string;
  readonly definitions: ReadonlyMap<string, Uint8Array>;
  readonly maxDepth: number;
  readonly unknown: 'throw' | 'warn' | 'ignore';
  readonly warnings: string[];
  readonly entities: PlacedEntity<string>[];
  readonly geometry: GeometryNode[];
  readonly clips: AnimationClip[];
  readonly animationTargets: AnimationTarget[];
}

// ── Placement ────────────────────────────────────────────────────────────────

/**
 * Resolve one `LM_entity`'s props against the registry and place it. `null` when its
 * classname is unknown and the caller asked not to throw.
 *
 * Takes a bare matrix and id rather than a node, so that an entity nested inside another
 * entity's definition resolves through exactly this function: its placement is its local
 * matrix composed with its owner's, and its id is derived from its owner's — neither of
 * which is a node in the scene's own glTF.
 */
function resolveEntry(
  ctx: Context,
  extension: LmEntityExtension,
  world: Mat4,
  id: string,
  path: string,
  mesh: LiminalMesh | null,
  parentId: string | undefined,
): PlacedEntity<string> | null {
  const classname = extension.classname;
  if (!ctx.registry.has(classname)) {
    if (ctx.unknown === 'throw') {
      throw new LiminalImportError(
        `[${ctx.name}] node "${path}" has classname "${String(classname)}", which is not in the ` +
          'entity registry. Re-sync the Blender workspace and reload the manifest.',
      );
    }
    if (ctx.unknown === 'warn') {
      ctx.warnings.push(`node "${path}": unknown classname "${String(classname)}" — skipped`);
    }
    return null;
  }

  const descriptor = ctx.registry.find(classname);
  if (descriptor?.metadata?.volume && !mesh) {
    throw new LiminalImportError(
      `[${ctx.name}] node "${path}" is a ${classname}, a volume entity, but carries no brush mesh. ` +
        'The export is damaged; re-export the level from Blender.',
    );
  }
  const exported = extension.props ?? {};
  const properties: Record<string, PropValue> = {};

  for (const propDef of descriptor?.props ?? []) {
    const raw = exported[propDef.name]?.value;
    properties[propDef.name] =
      raw === undefined ? defaultValue(ctx, propDef) : coerce(ctx, propDef, raw, classname);
  }

  // Props the export carries that the registry no longer declares: the level was authored
  // against an older manifest. Not fatal — the level still plays.
  for (const key of Object.keys(exported)) {
    if (!(key in properties)) {
      ctx.warnings.push(
        `${classname}: ignoring unknown property "${key}" (stale manifest revision?)`,
      );
    }
  }

  return {
    id,
    classname,
    path,
    world,
    transform: decomposeTrs(world),
    properties,
    ...(extension.description ? { description: extension.description } : {}),
    mesh,
    ...(parentId !== undefined ? { parentId } : {}),
  };
}

/** The choice-set key a `$Key` / `$Key[]` prop refers to, or null for a plain type. */
function choiceTypeKey(propDef: LiminalPropDef): string | null {
  if (!propDef.type.startsWith('$')) return null;
  const key = propDef.type.slice(1);
  return key.endsWith('[]') ? key.slice(0, -2) : key;
}

function defaultValue(ctx: Context, propDef: LiminalPropDef): PropValue {
  const typeKey = choiceTypeKey(propDef);
  if (typeKey !== null) {
    if (propDef.type.endsWith('[]')) return choiceList(ctx, typeKey, propDef.default_value ?? '', null);
    return ctx.registry.resolveChoice(typeKey, propDef.default_value) ?? firstChoice(ctx, typeKey);
  }
  if (propDef.default_value !== undefined) return coerce(ctx, propDef, propDef.default_value, '');
  switch (propDef.type) {
    case 'bool':
      return false;
    case 'int':
    case 'float':
      return 0;
    case 'Color':
      return [0, 0, 0, 1];
    case 'Vector2':
    case 'Vector3':
    case 'Vector4':
      return new Array<number>(vectorLength(propDef.type)).fill(0);
    default:
      return '';
  }
}

function firstChoice(ctx: Context, typeKey: string): string | number {
  const set = ctx.registry.types[typeKey];
  const first = set ? Object.values(set)[0] : undefined;
  return first ?? '';
}

function choiceList(ctx: Context, typeKey: string, raw: unknown, owner: string | null): (string | number)[] {
  const values: (string | number)[] = [];
  for (const label of String(raw).split(',').map((part) => part.trim()).filter(Boolean)) {
    const resolved = ctx.registry.resolveChoice(typeKey, label);
    if (resolved !== undefined) values.push(resolved);
    else if (owner) ctx.warnings.push(`${owner}: unknown choice "${label}"`);
  }
  return values;
}

function colorOf(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || (raw.length !== 3 && raw.length !== 4)) return null;
  const channels = raw.map(Number);
  return channels.length === 3 ? [...channels, 1] : channels;
}

function vectorLength(type: 'Vector2' | 'Vector3' | 'Vector4'): number {
  return type === 'Vector2' ? 2 : type === 'Vector3' ? 3 : 4;
}

/** Map one exported value onto its resolved runtime form. */
function coerce(ctx: Context, propDef: LiminalPropDef, raw: unknown, classname: string): PropValue {
  const typeKey = choiceTypeKey(propDef);
  if (typeKey !== null) {
    if (propDef.type.endsWith('[]')) return choiceList(ctx, typeKey, raw, `${classname}.${propDef.name}`);
    const resolved = ctx.registry.resolveChoice(typeKey, raw);
    if (resolved === undefined) {
      ctx.warnings.push(
        `${classname}.${propDef.name}: "${String(raw)}" is not a valid ${typeKey} choice — using the default`,
      );
      return defaultValue(ctx, propDef);
    }
    return resolved;
  }

  switch (propDef.type) {
    case 'bool':
      return Boolean(raw);
    case 'int':
    case 'float':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw) || 0;
    case 'Color':
      return colorOf(raw) ?? colorOf(propDef.default_value) ?? [0, 0, 0, 1];
    case 'Vector2':
    case 'Vector3':
    case 'Vector4': {
      const length = vectorLength(propDef.type);
      return Array.isArray(raw) && raw.length === length
        ? raw.map(Number)
        : new Array<number>(length).fill(0);
    }
    default:
      return typeof raw === 'string' ? raw : String(raw);
  }
}

// ── Definition expansion ─────────────────────────────────────────────────────

/**
 * Instantiate one placed entity's authored definition into the scene: its meshes become
 * geometry at this placement, and its nested `LM_entity` children become real entities in
 * the scene's own list.
 *
 * Children are fully real rather than decorative, because everything downstream — your light
 * loop, your spawn pass, your renderer — already walks the entity list and needs no special
 * case for "this one came from inside another one". `parentId`, and the `owner/path` id, are
 * there for the cases that do care.
 *
 * The placement composes the child's own matrix with its owner's **in full**: scale and
 * off-axis rotation on an entity are honoured, not silently dropped.
 */
function expand(ctx: Context, owner: MutableNode, ancestry: readonly string[]): void {
  const entity = owner.entity!;
  const bytes = ctx.definitions.get(entity.classname);
  if (!bytes) return; // no authored definition — the entity is a bare placement

  if (ancestry.includes(entity.classname)) {
    throw new LiminalImportError(
      `[${ctx.name}] entity "${entity.classname}" contains itself ` +
        `(${[...ancestry, entity.classname].join(' → ')}). An authored entity cannot nest its ` +
        'own classname, directly or through a chain.',
    );
  }
  if (ancestry.length >= ctx.maxDepth) {
    throw new LiminalImportError(
      `[${ctx.name}] authored entities nest deeper than ${ctx.maxDepth} at ` +
        `"${entity.classname}" (${[...ancestry, entity.classname].join(' → ')})`,
    );
  }

  const def = parseDefinition(bytes);
  const placement = entity.world;
  const childAncestry = [...ancestry, entity.classname];

  const content: NodeContent = { entities: new Map(), geometry: new Map() };

  for (const geo of def.geometry) {
    const geometry: GeometryNode = {
      id: `${entity.id}/${geo.path}`,
      path: geo.path,
      world: multiplyMat4(placement, geo.world),
      collision: geo.collision,
      tags: geo.tags,
      mesh: geo.mesh,
      entityId: entity.id,
    };
    ctx.geometry.push(geometry);
    addGeometry(content, geo.index, geometry);
  }

  for (const clip of def.clips) {
    ctx.clips.push({
      id: `${entity.id}/${clip.name}`,
      name: clip.name,
      tracks: clip.tracks,
      entityId: entity.id,
    });
  }
  for (const node of def.animatedNodes) {
    ctx.animationTargets.push({
      id: `${entity.id}/${node.path}`,
      path: node.path,
      world: multiplyMat4(placement, node.world),
      entityId: entity.id,
    });
  }

  for (const child of def.entities) {
    const resolved = resolveEntry(
      ctx,
      child.extension,
      multiplyMat4(placement, child.world),
      `${entity.id}/${child.path}`,
      child.path,
      child.mesh,
      entity.id,
    );
    if (!resolved) continue;
    ctx.entities.push(resolved);
    content.entities.set(child.index, resolved);
  }

  const tree = buildTree(def.nodes, content, `${entity.id}/`, owner, placement);
  owner.children.push(...tree.roots);
  for (const node of tree.entityNodes) expand(ctx, node, childAncestry);
}

interface NodeContent {
  readonly entities: Map<number, PlacedEntity<string>>;
  readonly geometry: Map<number, GeometryNode[]>;
}

interface MutableNode {
  readonly kind: LevelNode['kind'];
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly local: Mat4;
  readonly world: Mat4;
  readonly parent: MutableNode | null;
  readonly children: MutableNode[];
  readonly entity?: PlacedEntity<string>;
  readonly geometry?: readonly GeometryNode[];
}

function addGeometry(content: NodeContent, index: number, geometry: GeometryNode): void {
  const list = content.geometry.get(index);
  if (list) list.push(geometry);
  else content.geometry.set(index, [geometry]);
}

function buildTree(
  nodes: readonly FlatNode[],
  content: NodeContent,
  idPrefix: string,
  owner: MutableNode | null,
  placement: Mat4 | null,
): { roots: MutableNode[]; entityNodes: MutableNode[] } {
  const byIndex = new Map<number, MutableNode>();
  const roots: MutableNode[] = [];
  const entityNodes: MutableNode[] = [];

  for (const flat of nodes) {
    const parent = flat.parent === null ? null : (byIndex.get(flat.parent) ?? null);
    const entity = content.entities.get(flat.index);
    const geometry = content.geometry.get(flat.index);
    const node: MutableNode = {
      kind: entity ? 'entity' : geometry ? 'geometry' : 'group',
      id: `${idPrefix}${flat.path}`,
      name: flat.node.name ?? `node-${flat.index}`,
      path: flat.path,
      local: parent ? flat.local : flat.world,
      world: placement ? multiplyMat4(placement, flat.world) : flat.world,
      parent: parent ?? owner,
      children: [],
      ...(entity ? { entity } : {}),
      ...(geometry ? { geometry } : {}),
    };
    byIndex.set(flat.index, node);
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (entity) entityNodes.push(node);
  }

  return { roots, entityNodes };
}
