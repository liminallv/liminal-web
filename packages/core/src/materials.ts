// The material library — your game's materials, offered to the designer in Blender.
//
// Materials reach Blender as `<workspace>/materials/materials.json`: an index naming one
// preview image per entry, next to the images themselves. The addon builds a Principled BSDF
// around each preview, marks it as an asset, and files it into an asset-browser catalog named
// after **the part of its id before the first underscore** (`hull_steel` → "Hull").
//
// So the id prefix IS the category. There is no separate category field in the wire format;
// if you want your materials grouped sensibly in the asset browser, name them for it.
//
// On the way back, a mesh the designer assigned a material to carries that material's NAME
// on its exported glTF primitive (`PrimitiveMaterial.name`). Match it against this registry
// to resolve your own engine material, and fall back to the embedded PBR factors when you
// do not recognise it — that way a material added in Blender still draws with its authored
// colour instead of a flat default.

export interface MaterialDescriptor {
  /** Stable id. Also the glTF material name, and the asset-catalog prefix. */
  readonly id: string;
  /** Human-readable label, for your own tooling. Not part of the wire format. */
  readonly name: string;
  /** Linear-space base colour `[r, g, b, a]` — glTF `baseColorFactor`. */
  readonly color: readonly [number, number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  /** Linear-space emissive `[r, g, b]`, when the material glows. */
  readonly emissive?: readonly [number, number, number];
  /**
   * Texture maps, when the material is more than flat PBR factors.
   *
   * On a textured material the factors above become MULTIPLIERS over the maps rather than the
   * colour itself, so they should generally be left at white/1 — which is exactly what Blender
   * exports for a texture-driven material, and what `adoptIncomingMaterials` hands back.
   */
  readonly textures?: MaterialTextureSet;
}

/**
 * Where each of a material's maps lives, as opaque **locators** rather than pixels.
 *
 * A locator is whatever string your project uses to name a texture, and both sides of the sync
 * agree on it without this package having an opinion: `@liminal-lv/cli` resolves one to bytes on
 * disk when it publishes the material library, and your renderer resolves the same string to a
 * URL it can load. Keeping it opaque is what lets a locator be a repo-relative path in a build
 * script and a bundler URL in the browser without two parallel registries.
 *
 * Several slots naming the SAME locator is normal and cheap — the standard ORM packing puts
 * occlusion and metallic-roughness in one image, and the bake de-duplicates by locator.
 */
export interface MaterialTextureSet {
  readonly baseColor?: string;
  /** Blue channel = metallic, green = roughness, per glTF. */
  readonly metallicRoughness?: string;
  readonly normal?: string;
  /** Ambient occlusion — conventionally the red channel of the metallic-roughness image. */
  readonly occlusion?: string;
  readonly emissive?: string;
}

/**
 * Resolve the material name off an imported primitive against your library.
 *
 * Three lookups, in order, because a name reaches you at one of three points in the adoption
 * round trip and all three must land on the same descriptor:
 *
 * 1. **By `id`.** The managed case: the designer picked a library material in Blender, or has
 *    already Reloaded after an adoption so the addon swapped the source material for the baked
 *    one. This is the only case once a project has settled.
 * 2. **By `name`** — the descriptor's own source name. An adopted material keeps the Blender
 *    material's original name here (`adoptIncomingMaterials` sets it), so a level or entity
 *    exported from a `.blend` that has NOT been reloaded yet still resolves. Without this, the
 *    window between "sync adopted it" and "designer reloaded Blender" renders every adopted
 *    material as its bare factors — and a texture-driven material's factors are multipliers,
 *    which is a white, fully-emissive blowout rather than an obvious miss.
 * 3. **By sanitized name.** `hull.001` in Blender is `hull_001` in an adopted id, so the same
 *    material spelled either way still meets itself. This is the same sanitization the addon
 *    applies, so the two agree by construction.
 *
 * Returns undefined when nothing matches, which is a real answer: the caller should fall back to
 * the primitive's embedded factors rather than invent a material.
 */
export function findMaterial(
  materials: readonly MaterialDescriptor[],
  name: string | null | undefined,
): MaterialDescriptor | undefined {
  if (!name) return undefined;
  const byId = materials.find((material) => material.id === name);
  if (byId) return byId;
  const byName = materials.find((material) => material.name === name);
  if (byName) return byName;
  const sanitized = sanitizeMaterialName(name);
  return materials.find(
    (material) =>
      sanitizeMaterialName(material.name) === sanitized || material.id.endsWith(`_${sanitized}`),
  );
}

/** Every distinct locator a material references, in slot order. */
export function materialTextureLocators(material: MaterialDescriptor): string[] {
  const textures = material.textures;
  if (!textures) return [];
  const out: string[] = [];
  for (const locator of [
    textures.baseColor,
    textures.metallicRoughness,
    textures.normal,
    textures.occlusion,
    textures.emissive,
  ]) {
    if (locator && !out.includes(locator)) out.push(locator);
  }
  return out;
}

/** The asset-browser catalog Blender files a material under: the id prefix. */
export function materialCategory(id: string): string {
  const index = id.indexOf('_');
  return index > 0 ? id.slice(0, index) : id;
}

/** Index a material list by id, for resolving a `PrimitiveMaterial.name` off an import. */
export function materialsById(
  materials: readonly MaterialDescriptor[],
): ReadonlyMap<string, MaterialDescriptor> {
  return new Map(materials.map((material) => [material.id, material]));
}

// ── Adopting unmanaged materials ─────────────────────────────────────────────
//
// The reverse leg of the material sync. The Blender addon's "Export Unmanaged Materials"
// operator packs every scene material Liminal doesn't already own into
// `<workspace>/materials/incoming_<pack name>.glb`, and stamps each source material with the
// id it will carry once adopted — `<pack>_<sanitized source name>` — so that once your sync
// publishes a material under that id in `materials.json`, the addon's next Reload can match the
// two up by name and swap the stamped source for the fully-managed material.
// `@liminal-lv/cli`'s `adoptIncomingMaterials` reads those packs; this is the naming half of that
// contract, kept here because it has to byte-match the Blender side, not because it needs a
// filesystem.

/**
 * Reduce a material name to the charset shared with the Blender addon's adoption flow.
 *
 * Must stay byte-for-byte identical to `sanitize_name` in the addon's `material_export.py`
 * (mirrored on the Godot side by `_sanitize` in `material_import.gd`) — the exported name, the
 * `lm_adopting` stamp and the id you adopt it under all have to agree, or the round trip never
 * resolves.
 */
export function sanitizeMaterialName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').trim();
}

/**
 * The id an unmanaged material adopts from an `incoming_<pack>.glb` — the addon's `lm_adopting`
 * stamp on the source material.
 *
 * **Idempotent**, and that is load-bearing rather than tidiness. A designer re-running *Export
 * Unmanaged Materials* on a `.blend` whose materials were already adopted (they carry the
 * adopted name but Blender has not been reloaded, so the addon still sees them as unowned) would
 * otherwise get `pack_pack_hull` on the second pass and `pack_pack_pack_hull` on the third —
 * each one a NEW id that matches nothing already in the material list, so the pack could never
 * be recognised as fully adopted and would keep re-baking forever under ever-longer names.
 * Re-adopting an already-adopted material has to be a no-op, because it happens by accident.
 */
export function adoptedMaterialId(pack: string, sourceName: string): string {
  const sanitized = sanitizeMaterialName(sourceName);
  const prefix = `${sanitizeMaterialName(pack)}_`;
  return sanitized.startsWith(prefix) ? sanitized : `${pack}_${sanitized}`;
}
