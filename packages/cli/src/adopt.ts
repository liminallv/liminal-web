// Adopt unmanaged materials — the reverse leg of the material sync.
//
// Normally this SDK publishes YOUR materials to `<workspace>/materials/` for Blender to read.
// The addon's "Export Unmanaged Materials" operator runs that trip the other way: it packs
// every material in the scene Liminal doesn't already own into
// `<workspace>/materials/incoming_<pack name>.glb`, and stamps each source material with the id
// it will carry once adopted (`lm_adopting`, `<pack>_<sanitized name>` — see
// `adoptedMaterialId` in `@liminal-lv/core`).
//
// `syncWorkspace` (workspace.ts) is what actually closes the loop: it folds every pack this
// module finds into the SAME `materials.json` index it publishes from `options.materials`, so
// the very next Reload in Blender swaps the stamped source material for a normal, fully-managed
// one. This module only does the reading, and the bookkeeping of when a pack is safe to delete.
//
// A pack rides along in every sync for as long as any of its materials are still missing from
// your OWN material list — that absence is the signal that you have not copied it into source
// yet. Nothing is ever silently dropped this way: an unpersisted pack just keeps getting
// republished, run after run, until you add its materials to your list — at which point the
// next sync notices the pack is now redundant and deletes the incoming file for you.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  adoptedMaterialId,
  parseGlb,
  readImage,
  readMaterials,
  sanitizeMaterialName,
  type Glb,
  type MaterialDescriptor,
  type MaterialTextureSet,
  type PrimitiveMaterial,
} from '@liminal-lv/core';

const INCOMING_PREFIX = 'incoming_';
const INCOMING_SUFFIX = '.glb';

/** File extension per glTF image mime type. Anything else keeps its bytes under `.bin`. */
const EXTENSION_FOR_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/ktx2': '.ktx2',
};

/** One material read out of an `incoming_<pack>.glb`, on its way to your material list. */
export interface AdoptedMaterial {
  /** The pack name the designer typed into the export dialog. */
  readonly pack: string;
  /** The material's original name in the source `.blend`. */
  readonly sourceName: string;
  /** Ready to fold into your own material list — `id` already matches the addon's stamp. */
  readonly descriptor: MaterialDescriptor;
}

export interface AdoptMaterialsResult {
  /** Every material from a pack not (yet) fully covered by `known` — published in this run's
   *  index regardless of whether each individual material is itself already known, so a
   *  partially-persisted pack still round-trips as one unit. */
  readonly adopted: readonly AdoptedMaterial[];
  /** Pack names whose incoming `.glb` was deleted this run, because every material it carries
   *  was already present in `known` — i.e. you had already copied them into source. */
  readonly cleanedPacks: readonly string[];
  /** Locators of every texture file written this run, relative to `textureDir`. */
  readonly textures: readonly string[];
}

export interface AdoptMaterialsOptions {
  /**
   * Where to extract embedded texture images to. Omit and textures are ignored entirely, which
   * leaves a texture-driven material adopting as its flat factors — usually white, because that
   * is what glTF stores when a map does the work.
   *
   * Files land in `<textureDir>/<pack>/<image>.<ext>`, and each material's locators are the
   * paths RELATIVE to `textureDir` (POSIX separators, so they are stable across machines and
   * usable as a URL suffix in a browser). Point `textureDir` at the same directory on your next
   * sync, and your renderer at the same locators, and the round trip closes.
   */
  readonly textureDir?: string;
  /** Where progress goes. Defaults to silence. */
  readonly log?: (message: string) => void;
}

/**
 * Read every `incoming_*.glb` waiting in `<workspace>/materials/`, and clean up the ones you
 * have already persisted.
 *
 * @param known The ids your own material list already carries — `syncWorkspace` passes
 *   `options.materials`. A pack whose every material id is already in here is redundant: its
 *   incoming file is deleted. A pack with anything missing is left in place and returned in
 *   `adopted`, so it keeps riding along in the sync until you catch up.
 */
export function adoptIncomingMaterials(
  workspace: string,
  known: ReadonlySet<string>,
  options: AdoptMaterialsOptions = {},
): AdoptMaterialsResult {
  const log = options.log ?? (() => {});
  const dir = join(workspace, 'materials');
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const packFiles = files
    .filter((file) => file.startsWith(INCOMING_PREFIX) && file.endsWith(INCOMING_SUFFIX))
    .sort();

  const adopted: AdoptedMaterial[] = [];
  const cleanedPacks: string[] = [];
  const textures: string[] = [];

  for (const file of packFiles) {
    const pack = file.slice(INCOMING_PREFIX.length, -INCOMING_SUFFIX.length);
    const path = join(dir, file);

    let glb: Glb;
    let materials: PrimitiveMaterial[];
    try {
      glb = parseGlb(readFileSync(path));
      materials = readMaterials(glb);
    } catch (error) {
      log(`${file}: unreadable, skipping (${message(error)}).`);
      continue;
    }

    // Textures are extracted BEFORE the redundancy check below, so the files are guaranteed on
    // disk before a fully-adopted pack is deleted. Doing it the other way round means the one
    // run that removes the pack is also the run that could leave a material pointing at a
    // texture that was never written.
    const locators = extractTextures(glb, pack, materials, options.textureDir, log);
    for (const locator of locators.values()) {
      if (!textures.includes(locator)) textures.push(locator);
    }

    const packMaterials: AdoptedMaterial[] = [];
    for (const material of materials) {
      if (!material.name) {
        log(`${file}: a material with no name — skipping it.`);
        continue;
      }
      const textureSet = bindTextureSet(material, locators);
      packMaterials.push({
        pack,
        sourceName: material.name,
        descriptor: {
          id: adoptedMaterialId(pack, material.name),
          name: material.name,
          color: material.color,
          metallic: material.metallic,
          roughness: material.roughness,
          ...(material.emissive ? { emissive: material.emissive } : {}),
          ...(textureSet ? { textures: textureSet } : {}),
        },
      });
    }
    if (packMaterials.length === 0) {
      log(`${file}: no named materials found — skipping.`);
      continue;
    }

    if (packMaterials.every((material) => known.has(material.descriptor.id))) {
      rmSync(path);
      cleanedPacks.push(pack);
      log(`${file}: every material already in your list — adopted, incoming file removed.`);
      continue;
    }

    adopted.push(...packMaterials);
    const pending = packMaterials.filter((material) => !known.has(material.descriptor.id));
    log(
      `${file}: ${pending.length} material(s) awaiting adoption into your material list ` +
        `(${pending.map((material) => material.descriptor.id).join(', ')}).`,
    );
  }

  return { adopted, cleanedPacks, textures };
}

/**
 * Write every image the pack's materials reference into `<textureDir>/<pack>/`, returning the
 * locator each IMAGE INDEX now lives at.
 *
 * Keyed by image index rather than by slot because glTF's standard ORM packing has the
 * occlusion and metallic-roughness slots of a material naming one image; writing per slot would
 * put the same megabytes on disk twice under two names, and then embed both again on the way
 * back out.
 */
function extractTextures(
  glb: Glb,
  pack: string,
  materials: readonly PrimitiveMaterial[],
  textureDir: string | undefined,
  log: (message: string) => void,
): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  if (!textureDir) return out;

  const wanted = new Set<number>();
  for (const material of materials) {
    for (const ref of Object.values(material.textures ?? {})) {
      if (ref) wanted.add(ref.image);
    }
  }
  if (wanted.size === 0) return out;

  const packDir = join(textureDir, pack);
  mkdirSync(packDir, { recursive: true });

  const usedNames = new Set<string>();
  for (const index of [...wanted].sort((a, b) => a - b)) {
    const image = readImage(glb, index);
    if (!image) {
      // An image pointing at an external file rather than the BIN chunk. Blender embeds when it
      // writes a .glb, so this means someone hand-assembled the pack; the material still adopts,
      // just without that map.
      log(`${pack}: image ${index} is not embedded in the pack — skipping it.`);
      continue;
    }
    const filename = uniqueImageName(image.name, index, image.mimeType, usedNames);
    writeFileSync(join(packDir, filename), image.bytes);
    // POSIX separators: a locator is also a URL suffix in the browser, and it has to read the
    // same on the machine that wrote it and the one that serves it.
    out.set(index, `${pack}/${filename}`);
  }
  return out;
}

/** A collision-free filename for one image, from its own name where it has a usable one. */
function uniqueImageName(
  name: string | null,
  index: number,
  mimeType: string,
  used: Set<string>,
): string {
  const extension = EXTENSION_FOR_MIME[mimeType] ?? '.bin';
  const base = sanitizeMaterialName(name ?? '') || `image_${index}`;
  let candidate = `${base}${extension}`;
  // Blender numbers its exported images `Image_0`, `Image_1`, … which are unique within a pack,
  // but nothing guarantees that in general — and two materials silently sharing a filename would
  // have one overwrite the other's map.
  if (used.has(candidate)) candidate = `${base}_${index}${extension}`;
  used.add(candidate);
  return candidate;
}

/** A material's texture slots as locators, or null when none of its images were written. */
function bindTextureSet(
  material: PrimitiveMaterial,
  locators: ReadonlyMap<number, string>,
): MaterialTextureSet | null {
  const textures = material.textures;
  if (!textures || locators.size === 0) return null;
  const out: {
    baseColor?: string;
    metallicRoughness?: string;
    normal?: string;
    occlusion?: string;
    emissive?: string;
  } = {};
  const baseColor = textures.baseColor && locators.get(textures.baseColor.image);
  if (baseColor) out.baseColor = baseColor;
  const metallicRoughness =
    textures.metallicRoughness && locators.get(textures.metallicRoughness.image);
  if (metallicRoughness) out.metallicRoughness = metallicRoughness;
  const normal = textures.normal && locators.get(textures.normal.image);
  if (normal) out.normal = normal;
  const occlusion = textures.occlusion && locators.get(textures.occlusion.image);
  if (occlusion) out.occlusion = occlusion;
  const emissive = textures.emissive && locators.get(textures.emissive.image);
  if (emissive) out.emissive = emissive;
  return Object.keys(out).length > 0 ? out : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
