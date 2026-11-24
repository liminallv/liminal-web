// The Liminal contract — the wire types shared by both directions of an integration.
//
// This is a transcription of a contract defined by the Liminal Editor **Blender addon**.
// Do not "improve" these shapes: the addon parses them literally, and a field it does not
// recognise is a field a designer cannot see. The reference implementation is:
//
//   blender/liminal_editor/library.py    the actual parser  (entities.json → Blender)
//   blender/liminal_editor/export.py     the actual emitter (Blender → .lm)
//
// Where the addon's shipped documentation and its Python source disagree, the SOURCE wins.
// Points where they do disagree are called out inline below.
//
// Two directions, two formats:
//
//   game → Blender    <workspace>/entities.json          LiminalManifest
//   Blender → game    <workspace>/levels/<name>.lm       glTF 2.0 binary + LM_* extensions
//
// `<workspace>` is whatever directory the designer points the addon at (its "project
// directory"). Its layout is fixed by the addon:
//
//   <workspace>/.lmworkspace               empty marker; the addon refuses a folder without it
//   <workspace>/entities.json              entity definitions, choice types, geometry tags
//   <workspace>/models/<name>.glb          preview meshes referenced by `metadata.model`
//   <workspace>/gizmo_textures/<key>.png   images referenced by a gizmo's `texture`
//   <workspace>/materials/materials.json   the material index, over loose preview images
//   <workspace>/levels/<name>.lm           ← the addon writes these; your game reads them

// ── Game → Blender: <workspace>/entities.json ────────────────────────────────

/**
 * Property types the addon understands (`library._parse_prop`).
 *
 * `source`/`destination` are the **entity-wiring pair**: a `source` prop holds this entity's
 * own connection name, a `destination` prop holds the name it signals. The addon draws them
 * as arrows in the viewport; dispatching them at runtime is the game's job (see `wiring.ts`).
 *
 * Wiring is discovered by prop TYPE, never by prop NAME. `target`/`targetname` are a
 * convention inherited from Quake-lineage editors, not a contract — an entity may carry any
 * number of either kind under any names, and every piece of Blender tooling discovers them
 * by type.
 *
 * `$Key` references the manifest's top-level `types` table; `$Key[]` is its multi-select
 * form. There is no `enum` with inline options: a choice set always lives in `types`.
 *
 * The vector types are what Godot's `type_string` names them. Blender edits them as plain
 * float arrays and exports them back as arrays, with no axis conversion of any kind.
 */
export type LiminalPropType =
  | 'bool'
  | 'int'
  | 'float'
  | 'String'
  | 'Color' // [r, g, b, a] linear floats
  | 'Vector2' // [x, y]
  | 'Vector3' // [x, y, z]
  | 'Vector4' // [x, y, z, w]
  | 'source'
  | 'destination'
  | `$${string}`; // `$TypeKey` or `$TypeKey[]`

export type LiminalPropDefault = boolean | number | string | readonly number[];

export interface LiminalPropDef {
  readonly name: string;
  readonly type: LiminalPropType;
  /**
   * Seeded onto the Blender object at placement time. For a `$TypeKey` prop this must be
   * the choice **label**, not its value: the addon writes the label into the custom property
   * and exports it verbatim (`entity/ui.py`, `entity/placement.py`).
   */
  readonly default_value?: LiminalPropDefault;
  readonly description?: string;
  /** `int`/`float` only: the Blender property slider's hard and soft bounds. */
  readonly min?: number;
  readonly max?: number;
  /** `int`/`float` only: the slider's increment, in the prop's own unit. */
  readonly step?: number;
}

/**
 * `path` draws a polyline through the entity's child objects; `volume` fills a volume
 * entity's own mesh and is a no-op on anything else.
 */
export type LiminalGizmoType =
  | 'sphere'
  | 'arrow'
  | 'cone'
  | 'frustum'
  | 'box'
  | 'billboard'
  | 'volume'
  | 'text'
  | 'path';

/**
 * A procedural viewport shape drawn on the entity. Every dimension is a NUMERIC STRING,
 * per the addon's parser — `"1.5"`, not `1.5`.
 */
export interface LiminalGizmoDef {
  readonly type: LiminalGizmoType;
  readonly radius?: string;
  readonly length?: string;
  readonly angle?: string;
  readonly fov?: string;
  readonly near?: string;
  readonly far?: string;
  /** Uniform HALF-extent for `box`; text size for `text`. */
  readonly size?: string;
  /**
   * `box` only: independent per-axis HALF-extents, same unit as `size`, overriding it on
   * whichever axis is set or bound. An axis left unset falls back to `size`, so a plain
   * `size`-only box still draws the same cube.
   */
  readonly size_x?: string;
  readonly size_y?: string;
  readonly size_z?: string;
  /**
   * `billboard` draws this image as its icon; `volume` tiles it over the fill. In a registry
   * this is a texture LOCATOR, the same opaque string a `MaterialTextureSet` uses; the sync
   * rewrites it to the key of the PNG it publishes under `gizmo_textures/`, which is all the
   * addon ever sees. See `gizmoTextureKey`.
   */
  readonly texture?: string;
  /** `volume` only: texels per metre, projected in object space. Defaults to `"128"`. */
  readonly texture_scale?: string;
  /** `text` gizmo only. Supports `{{prop_name}}` tokens, substituted live in the viewport. */
  readonly text?: string;
  readonly color?: string; // #RRGGBB
  readonly style?: 'wire' | 'solid';
  readonly alpha?: string;
  /** Local translation `"x,y,z"` in BLENDER space (Z-up). See `BLENDER_UP_EULER`. */
  readonly offset?: string;
  /** Local rotation `"rx,ry,rz"` in degrees, BLENDER space, XYZ order. */
  readonly euler?: string;
  /** `path` only: `"hierarchy"` (default) follows child order, `"nearest"` chains by distance. */
  readonly mode?: 'hierarchy' | 'nearest';
  /** `path` only: `"true"` closes the polyline back to its first point. */
  readonly closed?: 'true' | 'false';
  /** Binds a gizmo dimension field to a property name so it tracks that value live. */
  readonly bindings?: Readonly<Record<string, string>>;
}

/**
 * The key under which a gizmo texture is published: `<workspace>/gizmo_textures/<key>.png`.
 *
 * Byte-for-byte the Godot plugin's `LMGizmoTextures.key_for_path`, so a project that syncs
 * from both hosts names the same image the same way: the locator minus its extension, with
 * every run of characters outside `[A-Za-z0-9_]` collapsed to one `_`. A leading `./` or `/`
 * is dropped the way Godot drops `res://`.
 */
export function gizmoTextureKey(locator: string): string {
  const relative = locator.replace(/^(\.\/|\/)+/, '');
  const slash = relative.lastIndexOf('/');
  const dot = relative.lastIndexOf('.');
  const stem = dot > slash ? relative.slice(0, dot) : relative;
  return stem.replace(/[^A-Za-z0-9_]+/g, '_');
}

export interface LiminalEntityMetadata {
  /** Viewport tint, `#RRGGBB`. */
  readonly color?: string;
  /** Preview mesh, resolved as `<workspace>/models/<model>.glb`. */
  readonly model?: string;
  /**
   * `true` → the addon spawns this entity as an **editable brush** rather than an Empty, and
   * its mesh rides the `LM_entity` node itself on export. What that mesh becomes (a collider,
   * a trigger region, both) is the game's decision, not the contract's.
   */
  readonly volume?: boolean;
  readonly gizmos?: readonly LiminalGizmoDef[];
}

export interface LiminalEntityDef {
  readonly classname: string;
  /**
   * The identifier the host engine resolves in order to instantiate this entity. Godot
   * writes a `uid://…` resource id; the contract also permits a bare class name, which is
   * what a game instantiating from its own registry should write (its classname is fine).
   *
   * Required by the addon, and it must stay **stable**: it is stamped onto every placed
   * instance at placement time and round-trips through the `.lm`.
   */
  readonly uid: string;
  readonly description?: string;
  readonly metadata?: LiminalEntityMetadata;
  readonly props?: readonly LiminalPropDef[];
}

/** A named choice set. Values are ints (native enums) or strings (ids/paths). */
export type LiminalChoiceSet = Readonly<Record<string, number | string>>;

export interface LiminalManifest {
  /**
   * Staleness counter the addon shows, and uses to prompt a designer to reload. Bump it
   * ONLY when the content actually changes, or the prompt stops meaning anything — see
   * `nextRevision` in `@liminal-lv/cli`.
   */
  readonly revision: number;
  readonly types: Readonly<Record<string, LiminalChoiceSet>>;
  /** Authoritative geometry-tag vocabulary; drives the addon's per-mesh tag toggles. */
  readonly geo_tags: readonly string[];
  readonly entities: readonly LiminalEntityDef[];
}

// ── Blender → Game: <workspace>/levels/<name>.lm ─────────────────────────────
//
// A `.lm` is a plain glTF 2.0 binary (`.glb`) carrying two custom node extensions. Any glTF
// loader can open one; the extensions are simply ignored if unsupported.

export const LM_ENTITY_EXTENSION = 'LM_entity';
export const LM_GEO_EXTENSION = 'LM_geo';

export type LmPropValue = boolean | number | string | readonly number[];

/**
 * One exported property.
 *
 * NOTE: the addon's `export_format.md` documents `props` as a flat name→value map, but
 * `export.py` writes this wrapped `{ type, value }` form and real `.lm` files contain it.
 *
 * `type` is the addon's PARSED type, not the manifest's declared one — `$Key` arrives here
 * as `enum` and `$Key[]` as `multi_enum`.
 */
export interface LmEntityProp {
  readonly type: string;
  readonly value?: LmPropValue;
}

export interface LmEntityExtension {
  readonly classname: string;
  readonly uid: string;
  readonly props: Readonly<Record<string, LmEntityProp>>;
  /** Per-instance note the designer typed in Blender. Documentation, not gameplay data. */
  readonly description?: string;
}

export const LM_COLLISION_KINDS = [
  'SPHERE',
  'BOX',
  'CYLINDER',
  'CAPSULE',
  'CONVEX',
  'CONCAVE',
  'NONE',
] as const;

export type LmCollisionKind = (typeof LM_COLLISION_KINDS)[number];

export interface LmGeoExtension {
  readonly collision: LmCollisionKind;
  /** Free-form per-mesh tags, drawn from the manifest's `geo_tags` vocabulary. */
  readonly tags?: readonly string[];
}

export function isLmCollisionKind(x: unknown): x is LmCollisionKind {
  return typeof x === 'string' && (LM_COLLISION_KINDS as readonly string[]).includes(x);
}

// ── Coordinate space ─────────────────────────────────────────────────────────
//
// Blender is Z-up and glTF is Y-up. The exporter applies the standard mapping
//
//   Blender (x, y, z)  →  glTF (x, z, -y)
//
// so a `.lm` is an ordinary Y-up glTF file and needs no axis correction on import. Two
// consequences worth knowing when authoring gizmos and preview models:
//
//  - glTF "up" (+Y) is Blender +Z.
//  - A preview model authored in glTF space lands in Blender's XZ plane.
//
// A 2D game whose physics plane is glTF X/Y therefore has its designers working in
// Blender's FRONT view, with Blender +Y running into the screen as visual depth.

/**
 * Euler for a gizmo that must point along glTF **+Y** ("up").
 *
 * The addon draws an un-rotated `arrow`/`cone` along Blender −Z (`entity/overlay.py`'s
 * `_BL_FWD`), so a 180° X flip aims it at Blender +Z, which is glTF +Y.
 */
export const BLENDER_UP_EULER = '180,0,0';

/**
 * Euler for a gizmo that must point along glTF **+X** ("right"). Blender X maps straight to
 * glTF X with no flip, so the un-rotated arrow (Blender −Z) needs a −90° Y rotation.
 */
export const BLENDER_RIGHT_EULER = '0,-90,0';
