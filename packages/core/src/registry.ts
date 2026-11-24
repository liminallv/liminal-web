// The entity registry — your game's vocabulary, expressed in the Liminal contract.
//
// A registry is the single source of truth for what a designer can place. It is read by
// three different things that have no discovery mechanism in common:
//
//   • the workspace sync tool, which serializes it to `entities.json` for Blender;
//   • the `.lm` importer, which resolves an exported node's props against it;
//   • your game, which instantiates behaviour for each placed classname.
//
// So it is built once, from an object literal you write by hand, and passed around. There
// is deliberately no filesystem scan and no decorator magic: a static object is what keeps
// the classname union a *literal* type (so `Record<Classname, …>` and exhaustive switches
// typecheck), and what fixes the order entities are written to the manifest in — which
// matters, because the manifest's revision counter compares the entity array positionally.

import type { LiminalChoiceSet, LiminalEntityDef, LiminalPropDef } from './contract.ts';

/**
 * One entity's definition. Extends the wire shape with two build-time-only fields that
 * describe the choice sets it introduces; neither reaches `entities.json` as-is.
 *
 * **Adding your own fields is expected.** Declare an interface extending this one with
 * whatever your game needs (`goal`, `spawnWeight`, a sim factory) and use it throughout;
 * `createRegistry` is generic over the descriptor type, so the extras stay fully typed on
 * the way out. This package only ever reads the fields declared here.
 */
export interface EntityDescriptor<C extends string = string> extends Omit<LiminalEntityDef, 'uid'> {
  readonly classname: C;
  /** What `entities.json` carries as `uid`. Defaults to the classname; only Godot needs another value. */
  readonly uid?: string;
  /**
   * Choice sets this entity introduces, referenced from its own props as `$Key`.
   * `createRegistry` folds every entity's block into the manifest's flat top-level `types`
   * table, so a set only one entity uses can live with that entity instead of in a global
   * table far away from it.
   *
   * Declaring the same key twice with *different* members is an error — see
   * `mergeChoiceTypes` for why that has to be loud.
   */
  readonly types?: Readonly<Record<string, LiminalChoiceSet>>;
  /**
   * Which of this entity's own `types` are **open**: sets whose real membership is content
   * on disk that the game bundle cannot enumerate (comms scripts, sound banks, sub-levels).
   *
   * For an open set the label IS the value, so `resolveChoice` accepts any label rather
   * than only the declared ones. Without that, a level fails to load because the shipped
   * build cannot see the files the designer authored against. Validate them in a build-time
   * check that *does* have a filesystem — that is a much better place to catch a typo than
   * a silent fallback at load time.
   */
  readonly openTypes?: readonly string[];
}

/** Identity, with one job: keep the definition's literal types, so its classname and props stay exact. */
export function defineEntity<const D extends EntityDescriptor>(def: D & StrictProps<D>): D {
  return def;
}

type StrictProps<D> = D extends { readonly props: readonly (infer P)[] }
  ? { readonly props: readonly (P & { readonly [K in Exclude<keyof P, keyof LiminalPropDef>]: never })[] }
  : unknown;

export interface EntityRegistryOptions {
  /**
   * The geometry-tag vocabulary offered as per-mesh toggles in Blender, written to the
   * manifest's `geo_tags`. Tags come back on each `LM_geo` node.
   */
  readonly geoTags?: readonly string[];
}

/**
 * The read-only slice of a registry that the rest of this package needs.
 *
 * `EntityRegistry<T>` is invariant in `T` (it exposes the descriptor map itself), so a
 * function taking a *specific* registry type cannot be handed someone else's. Every internal
 * consumer takes this instead, which any registry satisfies regardless of its vocabulary —
 * and so does a hand-rolled object, if you have a reason to synthesize one.
 */
export interface EntityLookup {
  has(classname: string): boolean;
  find(classname: string): EntityDescriptor | undefined;
  resolveChoice(typeKey: string, raw: unknown): string | number | undefined;
}

/**
 * A registry read without reference to its vocabulary — everything a *tool* needs.
 *
 * Take this, not `EntityRegistry<T>`, in any function that accepts someone else's registry.
 * The generic form is invariant in `T` because it exposes the descriptor map itself, so
 * `EntityRegistry<MyGame>` is not assignable to `EntityRegistry<Record<string, …>>` and a
 * caller would be stuck. This view drops the two members that cause that and is assignable
 * from every registry.
 */
export interface RegistryView extends EntityLookup {
  readonly list: readonly EntityDescriptor[];
  readonly classnames: readonly string[];
  readonly types: Readonly<Record<string, LiminalChoiceSet>>;
  readonly openTypes: ReadonlySet<string>;
  readonly geoTags: readonly string[];
}

export interface EntityRegistry<
  T extends Record<string, EntityDescriptor> = Record<string, EntityDescriptor>,
> extends RegistryView {
  /** The descriptor map exactly as you declared it, with your own extra fields intact. */
  readonly entities: T;
  /** Descriptors in declaration order — which is manifest order. Do not re-sort. */
  readonly list: readonly T[keyof T][];
  readonly classnames: readonly (keyof T & string)[];
  /** Every entity's choice sets, folded into the flat table the manifest wants. */
  readonly types: Readonly<Record<string, LiminalChoiceSet>>;
  readonly openTypes: ReadonlySet<string>;
  readonly geoTags: readonly string[];
  /** Narrowing form of `has`, for a classname you are about to use as a key. */
  isClassname(x: unknown): x is keyof T & string;
  /** Typed lookup for a classname already known to be in the registry. */
  get<K extends keyof T>(classname: K): T[K];
  /** Untyped lookup for a classname off the wire. `undefined` when unknown. */
  find(classname: string): EntityDescriptor | undefined;
  /**
   * Map a Blender-exported choice back to its value.
   *
   * Blender stores and exports the choice **label**, so that is the expected input; a value
   * that is already resolved passes through, which keeps hand-written and tool-generated
   * levels loadable. An open set (see `EntityDescriptor.openTypes`) additionally accepts
   * any label it does not know.
   *
   * Returns `undefined` for an unknown type key or an unrecognised label.
   */
  resolveChoice(typeKey: string, raw: unknown): string | number | undefined;
}

/** The classname → descriptor map an array of descriptors stands for. */
export type RegistryMapOf<A extends readonly EntityDescriptor[]> = {
  [D in A[number] as D['classname']]: D;
};

/**
 * Build a registry from your entity definitions.
 *
 * Pass an array and each classname is written once, in its own definition. Pass a map of
 * classname → descriptor and the parameter type enforces that **every key equals its own
 * descriptor's `classname`**, which catches an aliased import naming the wrong module.
 *
 * **Order is significant.** It is the order entities are written to `entities.json`, and the
 * manifest's staleness check compares that array positionally, so re-sorting bumps the
 * revision and prompts every designer to reload for no reason. Append.
 */
export function createRegistry<const A extends readonly EntityDescriptor[]>(
  entities: A,
  options?: EntityRegistryOptions,
): EntityRegistry<RegistryMapOf<A>>;
export function createRegistry<T extends Record<string, EntityDescriptor>>(
  entities: T & { [K in keyof T]: T[K] extends EntityDescriptor<K & string> ? T[K] : never },
  options?: EntityRegistryOptions,
): EntityRegistry<T>;
export function createRegistry(
  definitions: Record<string, EntityDescriptor> | readonly EntityDescriptor[],
  options: EntityRegistryOptions = {},
): EntityRegistry {
  return buildRegistry(isList(definitions) ? mapOf(definitions) : definitions, options);
}

function isList(x: Record<string, EntityDescriptor> | readonly EntityDescriptor[]): x is readonly EntityDescriptor[] {
  return Array.isArray(x);
}

function mapOf(list: readonly EntityDescriptor[]): Record<string, EntityDescriptor> {
  const map: Record<string, EntityDescriptor> = {};
  for (const entity of list) {
    if (Object.hasOwn(map, entity.classname)) {
      throw new Error(`createRegistry: classname '${entity.classname}' is defined twice`);
    }
    map[entity.classname] = entity;
  }
  return map;
}

function buildRegistry<T extends Record<string, EntityDescriptor>>(
  entities: T,
  options: EntityRegistryOptions,
): EntityRegistry<T> {
  const list = Object.values(entities) as T[keyof T][];
  const classnames = Object.keys(entities) as (keyof T & string)[];
  const types = mergeChoiceTypes(list);
  const openTypes = new Set<string>(list.flatMap((entity) => entity.openTypes ?? []));
  const geoTags = options.geoTags ?? [];

  return {
    entities,
    list,
    classnames,
    types,
    openTypes,
    geoTags,
    has(classname: string): boolean {
      return Object.hasOwn(entities, classname);
    },
    isClassname(x: unknown): x is keyof T & string {
      return typeof x === 'string' && Object.hasOwn(entities, x);
    },
    get<K extends keyof T>(classname: K): T[K] {
      return entities[classname];
    },
    find(classname: string): EntityDescriptor | undefined {
      return Object.hasOwn(entities, classname) ? entities[classname] : undefined;
    },
    resolveChoice(typeKey: string, raw: unknown): string | number | undefined {
      const set = types[typeKey];
      if (!set) return undefined;
      if (typeof raw === 'string' && Object.hasOwn(set, raw)) return set[raw];
      const values = Object.values(set);
      if ((typeof raw === 'string' || typeof raw === 'number') && values.includes(raw)) return raw;
      if (typeof raw === 'string' && openTypes.has(typeKey)) return raw;
      return undefined;
    },
  };
}

/**
 * Fold every entity's own `types` block into the one flat table the manifest wants.
 *
 * Throws on a key declared twice with *different* members. The manifest's `types` is a
 * single flat namespace shared by every entity, and a silent last-write-wins there is the
 * worst bug this per-entity layout could introduce: the manifest would offer one entity's
 * dropdown under another entity's prop, and `resolveChoice` would start returning
 * `undefined` for labels already baked into committed levels — which imports as "unknown
 * choice, using the default", a warning nobody reads and a level that quietly plays
 * differently.
 *
 * Re-declaring a key with the SAME members is fine: that is what two entities sharing a set
 * from a common module looks like.
 */
export function mergeChoiceTypes(
  defs: readonly EntityDescriptor[],
): Readonly<Record<string, LiminalChoiceSet>> {
  const out: Record<string, LiminalChoiceSet> = {};
  const owners = new Map<string, string>();
  for (const def of defs) {
    for (const [key, set] of Object.entries(def.types ?? {})) {
      const existing = out[key];
      if (existing && !sameChoiceSet(existing, set)) {
        throw new Error(
          `[liminal] choice set "${key}" is declared by both ${owners.get(key)} and ` +
            `${def.classname} with different members. A set used by more than one entity ` +
            'belongs in a shared module, spread into each entity that uses it.',
        );
      }
      out[key] = set;
      if (!owners.has(key)) owners.set(key, def.classname);
    }
  }
  return out;
}

function sameChoiceSet(a: LiminalChoiceSet, b: LiminalChoiceSet): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}
