// `entities.json` — the game → Blender half of the contract.
//
// The addon reads this to build its Add menu, its per-entity property editor, its viewport
// gizmos and its geometry-tag toggles. It is a straight serialization of your entity
// registry, so what designers see cannot drift from what your game defines.

import {
  gizmoTextureKey,
  type LiminalChoiceSet,
  type LiminalEntityMetadata,
  type LiminalManifest,
  type RegistryView,
} from '@liminal-lv/core';

/** The manifest minus `revision` — the form that gets compared for staleness. */
export type ManifestBody = Omit<LiminalManifest, 'revision'>;

/**
 * Serialize a registry into the manifest body.
 *
 * @param openTypes members of the registry's OPEN choice sets, enumerated by the caller
 *   (they live on disk; the registry declares them but cannot list them). Filling them here
 *   is what turns a free-text field in Blender into a real dropdown. A key absent from this
 *   map keeps whatever the registry declared.
 */
export function buildManifestBody(
  registry: RegistryView,
  openTypes: Readonly<Record<string, LiminalChoiceSet>> = {},
  modelled: ReadonlySet<string> = new Set(),
): ManifestBody {
  return {
    types: { ...registry.types, ...openTypes },
    geo_tags: registry.geoTags,
    // Copy contract fields only. A descriptor may carry any number of game-specific extras
    // (`goal`, a sim factory, a spawn weight); none of them mean anything to the addon, and
    // emitting one would change the manifest body and so bump the revision for no reason.
    entities: registry.list.map((entity) => {
      const metadata = withModel(entity.classname, entity.metadata, modelled);
      return {
        classname: entity.classname,
        uid: entity.uid ?? entity.classname,
        ...(entity.description ? { description: entity.description } : {}),
        ...(metadata ? { metadata: publishedMetadata(metadata) } : {}),
        ...(entity.props ? { props: entity.props } : {}),
      };
    }),
  };
}

function withModel(
  classname: string,
  metadata: LiminalEntityMetadata | undefined,
  modelled: ReadonlySet<string>,
): LiminalEntityMetadata | undefined {
  if (metadata?.model || !modelled.has(classname)) return metadata;
  return { ...metadata, model: classname };
}

/**
 * The manifest carries a gizmo texture by the KEY of its published PNG, never by the
 * locator the registry names it with — the same rewrite the Godot plugin applies to a
 * `res://` path at sync time.
 */
function publishedMetadata(metadata: LiminalEntityMetadata): LiminalEntityMetadata {
  if (!metadata.gizmos?.some((gizmo) => gizmo.texture)) return metadata;
  return {
    ...metadata,
    gizmos: metadata.gizmos.map((gizmo) =>
      gizmo.texture ? { ...gizmo, texture: gizmoTextureKey(gizmo.texture) } : gizmo,
    ),
  };
}

/**
 * The revision to write, or `null` when nothing changed and the file should be left alone.
 *
 * The contract's rule is: bump ONLY on a content change. The addon shows the revision and
 * uses it to prompt a designer to reload; if it moves every time a build runs, the prompt
 * stops meaning anything and designers learn to dismiss it. So compare the
 * revision-stripped bodies and, when they match, keep the old number and skip the write.
 *
 * Note that entity order is part of the body — re-sorting your registry is a content
 * change, and will (correctly) prompt everyone to reload.
 */
export function nextRevision(previous: unknown, body: ManifestBody): number | null {
  if (!previous || typeof previous !== 'object') return 1;
  const existing = previous as Record<string, unknown>;
  const existingRevision = typeof existing['revision'] === 'number' ? existing['revision'] : 0;
  const { revision: _ignored, ...existingBody } = existing;
  if (deepEqual(existingBody, body as unknown)) return null;
  return existingRevision + 1;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

export function serializeManifest(body: ManifestBody, revision: number): string {
  // `revision` first, so a human opening the file sees it immediately. The addon does not
  // care about key order.
  const json = JSON.stringify({ revision, ...body }, floatReplacer, 2);
  return `${json.replace(FLOAT_MARKER_RE, '$1.0')}\n`;
}

const FLOAT_MARKER_RE = /"__lm_float__(-?\d+)__"/g;

/**
 * Keep whole-number `float` and `Color` defaults looking like floats in the emitted JSON.
 *
 * `JSON.stringify` always drops a redundant `.0`, so a `float` default of `-1` is written
 * as the bare integer literal `-1`. Python's `json.load` has no int/float distinction, so
 * the addon reads that back as an `int` even though the prop is declared `float` — the
 * Blender custom property it seeds ends up int-typed, and the addon's manifest-reload sync
 * then sees a type change and force-resets the property to its default on **every** reload,
 * silently discarding whatever the designer set.
 *
 * Marking whole-number floats here and patching the marker back to a decimal literal after
 * stringifying is what keeps every such default unambiguously a float on the wire.
 */
function floatReplacer(this: { type?: unknown }, key: string, value: unknown): unknown {
  if (key !== 'default_value') return value;
  if (this.type === 'float' && typeof value === 'number' && Number.isInteger(value)) {
    return floatMarker(value);
  }
  if (this.type === 'Color' && Array.isArray(value)) {
    return value.map((v) => (typeof v === 'number' && Number.isInteger(v) ? floatMarker(v) : v));
  }
  return value;
}

function floatMarker(n: number): string {
  return `__lm_float__${n}__`;
}
