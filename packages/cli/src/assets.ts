// The two halves of game → Blender: entity preview models and the material library.
//
// Preview models are `.glb` files the addon imports directly. The material library is a set of
// preview IMAGES plus a JSON index — `buildMaterialPreviews` and `buildThumbnailAtlas` produce
// the pixels, and `workspace.ts` writes the index around them.
//
// Nothing here touches the filesystem — the caller owns where things live.

import {
  LM_GEO_EXTENSION,
  flattenScene,
  materialTextureLocators,
  parseGlb,
  readMeshPrimitives,
  transformDirection,
  transformPoint,
  type MaterialDescriptor,
  type Vec3,
} from '@liminal-lv/core';
import { boxDownsample, decodePng, encodePng, solidRgba } from './png.ts';
import {
  box,
  buildGlb,
  type GlbImageInput,
  type GlbMaterialTextures,
  type GlbMeshInput,
  type PrimitiveMesh,
} from '@liminal-lv/core/glb-write';

/** Mesh data for a preview model: everything `GlbMeshInput` needs except its name. */
export type PreviewGeometry = Omit<GlbMeshInput, 'name'>;

export interface GeneratedModel {
  readonly classname: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  /** True when the preview came from an authored `.lm` rather than a procedural shape. */
  readonly authored: boolean;
}

export interface BuildModelsOptions {
  /**
   * Procedural stand-in geometry per classname, for entities you have not modelled yet.
   * Build them with the primitives in `@liminal-lv/core/glb-write`, in glTF space (+Y up), at
   * the size the entity really is — a preview that lies about scale is worse than none.
   */
  readonly procedural?: Readonly<Record<string, PreviewGeometry>>;
  /** Real geometry flattened out of an authored `.lm`, which always wins over a stand-in. */
  readonly authored?: ReadonlyMap<string, PreviewGeometry>;
}

/**
 * Preview models for Blender's Add menu, one `.glb` per entity that has geometry.
 *
 * An entity that has been authored previews as its REAL geometry: the designer places the
 * actual landing port, not a stand-in box. An entity with neither authored nor procedural
 * geometry exports no model at all and relies on gizmos instead — which is the right answer
 * for anything whose size is a *property* rather than a shape (a gravity well, a trigger
 * radius), because a fixed mesh would misrepresent it.
 *
 * Output is sorted by classname so that the same registry always produces the same files.
 */
export function buildModels(options: BuildModelsOptions = {}): GeneratedModel[] {
  const procedural = options.procedural ?? {};
  const authored = options.authored ?? new Map<string, PreviewGeometry>();

  const classnames = new Set<string>([...Object.keys(procedural), ...authored.keys()]);
  const out: GeneratedModel[] = [];
  for (const classname of [...classnames].sort()) {
    const real = authored.get(classname);
    const geometry = real ?? procedural[classname];
    if (!geometry) continue;
    out.push({
      classname,
      filename: `${classname}.glb`,
      bytes: buildGlb({
        meshes: [{ name: classname, ...geometry }],
        nodes: [{ name: classname, mesh: 0 }],
      }),
      authored: real !== undefined,
    });
  }
  return out;
}

/** Resolve a `MaterialDescriptor` texture locator to encoded image bytes, or null to skip it. */
export type TextureResolver = (locator: string) => GlbImageInput | null;

export interface BuildMaterialLibraryOptions {
  /**
   * How to turn a material's texture locators into embedded images. Omit and materials bake
   * as flat PBR factors, exactly as they did before textures existed.
   *
   * A locator is opaque to this package (see `MaterialTextureSet`), so this is where a host
   * says what one means — `workspace.ts` supplies a filesystem-backed resolver rooted at a
   * directory you choose.
   */
  readonly resolveTexture?: TextureResolver;
  /** Where problems go. Defaults to silence. */
  readonly log?: (message: string) => void;
}

/**
 * A material library as one `.glb`: one glTF material per entry.
 *
 * **No longer part of the workspace sync.** The addon reads `materials/materials.json` and the
 * loose preview images `buildMaterialPreviews` produces. This stays because the other direction
 * still speaks glTF: an `incoming_*.glb` pack is exactly this file, so anything generating one
 * — the adoption tests included — still needs the writer.
 *
 * Every material MUST be bound to a mesh primitive. Blender's glTF importer only
 * materializes materials that some primitive references, so a file with a `materials` array
 * and no meshes imports as nothing at all. The carrier meshes are plain unit cubes laid out on
 * a grid.
 *
 * Textures are EMBEDDED, not referenced, so the file survives being copied or moved. The cost
 * is that it grows to the size of its textures, which is why `resolveTexture` de-duplicates by
 * locator — the standard ORM packing means most materials name fewer images than slots.
 */
export function buildMaterialLibrary(
  materials: readonly MaterialDescriptor[],
  options: BuildMaterialLibraryOptions = {},
): Uint8Array {
  const geometry = box(1, 1, 1);
  const meshes: GlbMeshInput[] = [];
  const nodes: { name: string; mesh: number; translation: Vec3 }[] = [];

  const columns = 5;
  materials.forEach((material, index) => {
    meshes.push({ name: `preview_${material.id}`, ...geometry, material: index });
    nodes.push({
      name: `preview_${material.id}`,
      mesh: index,
      translation: [(index % columns) * 2, Math.floor(index / columns) * 2, 0],
    });
  });

  const { images, indexOf } = collectImages(materials, options);

  return buildGlb({
    meshes,
    nodes,
    images,
    materials: materials.map((material) => {
      const textures = bindTextures(material, indexOf);
      return {
        // The material NAME is the contract: it is what the addon catalogs, what the designer
        // picks, and what comes back on the exported mesh primitive.
        name: material.id,
        baseColorFactor: material.color,
        metallic: material.metallic,
        roughness: material.roughness,
        ...(material.emissive ? { emissiveFactor: material.emissive } : {}),
        ...(textures ? { textures } : {}),
      };
    }),
  });
}

/**
 * Every distinct image the materials reference, resolved once each.
 *
 * De-duplication is by LOCATOR, and it matters more than it looks: a single ORM image is
 * normally named by both the occlusion and the metallic-roughness slot of the same material,
 * so resolving per slot would embed every one of them twice.
 */
function collectImages(
  materials: readonly MaterialDescriptor[],
  options: BuildMaterialLibraryOptions,
): { images: GlbImageInput[]; indexOf: ReadonlyMap<string, number> } {
  const images: GlbImageInput[] = [];
  const indexOf = new Map<string, number>();
  if (!options.resolveTexture) return { images, indexOf };

  const log = options.log ?? (() => {});
  for (const material of materials) {
    for (const locator of materialTextureLocators(material)) {
      if (indexOf.has(locator)) continue;
      let image: GlbImageInput | null = null;
      try {
        image = options.resolveTexture(locator);
      } catch (error) {
        log(`${material.id}: texture "${locator}" could not be read (${message(error)}).`);
      }
      if (!image) {
        // Recorded as absent so a locator that fails once is not retried per material, and so
        // `bindTextures` leaves the slot empty rather than pointing at the wrong image.
        indexOf.set(locator, -1);
        continue;
      }
      indexOf.set(locator, images.length);
      images.push(image);
    }
  }
  return { images, indexOf };
}

/** A material's texture slots as image indices, or null when none of them resolved. */
function bindTextures(
  material: MaterialDescriptor,
  indexOf: ReadonlyMap<string, number>,
): GlbMaterialTextures | null {
  const textures = material.textures;
  if (!textures) return null;
  const resolve = (locator: string | undefined): number | undefined => {
    if (locator === undefined) return undefined;
    const index = indexOf.get(locator);
    return index === undefined || index < 0 ? undefined : index;
  };
  const out: {
    baseColor?: number;
    metallicRoughness?: number;
    normal?: number;
    occlusion?: number;
    emissive?: number;
  } = {};
  const baseColor = resolve(textures.baseColor);
  if (baseColor !== undefined) out.baseColor = baseColor;
  const metallicRoughness = resolve(textures.metallicRoughness);
  if (metallicRoughness !== undefined) out.metallicRoughness = metallicRoughness;
  const normal = resolve(textures.normal);
  if (normal !== undefined) out.normal = normal;
  const occlusion = resolve(textures.occlusion);
  if (occlusion !== undefined) out.occlusion = occlusion;
  const emissive = resolve(textures.emissive);
  if (emissive !== undefined) out.emissive = emissive;
  return Object.keys(out).length > 0 ? out : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Material previews: what the addon actually reads ────────────────────────

/** One material's palette image, ready to be written under `materials/previews/`. */
export interface MaterialPreview {
  /** The descriptor id — the identity the addon catalogs, prunes and adopts by. */
  readonly name: string;
  /** File name within `previews/`, extension included. */
  readonly filename: string;
  readonly bytes: Uint8Array;
  /** The descriptor's linear base colour, kept for the atlas's fallback tile. */
  readonly color: readonly [number, number, number, number];
  readonly roughness: number;
  readonly metallic: number;
  /** The base-colour locator these bytes were copied from, when they were. */
  readonly source?: string;
  /** False when the preview is a synthesised flat tile rather than a real texture. */
  readonly textured: boolean;
}

export interface BuildMaterialPreviewsOptions {
  /**
   * How to turn a material's base-colour locator into image bytes. Omit and every material
   * previews as a flat tile of its `color`.
   */
  readonly resolveTexture?: TextureResolver;
  /** Where problems go. Defaults to silence. */
  readonly log?: (message: string) => void;
}

/** Edge of a synthesised flat tile. A solid colour needs no more than this. */
const FLAT_PREVIEW_SIZE = 64;

/** Default atlas tile edge — Blender's own native preview size. */
export const THUMBNAIL_SIZE = 128;

/**
 * Extensions for the image types Blender can open. A base-colour texture in any other format
 * is not copied through: the material falls back to its flat colour, which is a poorer preview
 * but a live one, where an unreadable file would delete the material from the `.blend`.
 */
const PREVIEW_EXTENSION_FOR_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/**
 * One palette image per material.
 *
 * There is no renderer here and there must not be one, so a preview comes from whichever of two
 * sources the descriptor offers. A material with a base-colour texture previews as that texture,
 * copied byte for byte — it already IS the picture of the material, at higher fidelity than any
 * bake. A factor-only material previews as a flat tile of its colour, sRGB-encoded.
 *
 * The one thing this cannot show is a factor tinting a textured material. Those factors are
 * multipliers and are conventionally white, so the copy is normally exact; a project that does
 * tint gets an untinted preview rather than a compositor.
 */
export function buildMaterialPreviews(
  materials: readonly MaterialDescriptor[],
  options: BuildMaterialPreviewsOptions = {},
): MaterialPreview[] {
  const log = options.log ?? (() => {});
  return materials.map((material) => {
    const copied = copyBaseColor(material, options.resolveTexture, log);
    return {
      name: material.id,
      filename: copied ? `${material.id}${copied.extension}` : `${material.id}.png`,
      bytes:
        copied?.bytes ??
        encodePng(FLAT_PREVIEW_SIZE, FLAT_PREVIEW_SIZE, solidRgba(material.color, FLAT_PREVIEW_SIZE)),
      color: material.color,
      roughness: material.roughness,
      metallic: material.metallic,
      ...(copied ? { source: copied.locator } : {}),
      textured: copied !== null,
    };
  });
}

function copyBaseColor(
  material: MaterialDescriptor,
  resolveTexture: TextureResolver | undefined,
  log: (message: string) => void,
): { locator: string; extension: string; bytes: Uint8Array } | null {
  const locator = material.textures?.baseColor;
  if (!locator || !resolveTexture) return null;

  let image: GlbImageInput | null = null;
  try {
    image = resolveTexture(locator);
  } catch (error) {
    log(`${material.id}: preview texture "${locator}" could not be read (${message(error)}).`);
  }
  if (!image) return null;

  const extension = PREVIEW_EXTENSION_FOR_MIME[image.mimeType];
  if (!extension) {
    log(`${material.id}: "${locator}" is ${image.mimeType}, which Blender cannot open — flat tile instead.`);
    return null;
  }
  return { locator, extension, bytes: image.bytes };
}

/** Every thumbnail in one sheet, plus the geometry the addon needs to slice it. */
export interface ThumbnailAtlas {
  readonly bytes: Uint8Array;
  /** Tile edge in pixels. */
  readonly size: number;
  readonly columns: number;
  readonly rows: number;
}

/**
 * Pack the previews into a single sheet, tile `i` for material `i`.
 *
 * Purely a performance feature: it saves the addon one file open and decode per material, and
 * the per-material path it degrades to is correct on its own. Tiles are laid out row-major from
 * the TOP-LEFT, plain raster order, which the addon flips into Blender's bottom-up pixel space
 * itself.
 *
 * A preview this package cannot decode — a copied JPEG or WebP — contributes its material's
 * flat colour rather than failing the sheet.
 */
export function buildThumbnailAtlas(
  previews: readonly MaterialPreview[],
  size: number = THUMBNAIL_SIZE,
): ThumbnailAtlas | null {
  if (previews.length === 0) return null;

  const columns = Math.ceil(Math.sqrt(previews.length));
  const rows = Math.ceil(previews.length / columns);
  const width = columns * size;
  const sheet = new Uint8Array(width * rows * size * 4);

  previews.forEach((preview, index) => {
    const decoded = decodePng(preview.bytes);
    const tile = decoded ? boxDownsample(decoded, size) : solidRgba(preview.color, size);
    const column = index % columns;
    const row = Math.floor(index / columns);
    for (let y = 0; y < size; y++) {
      const destination = ((row * size + y) * width + column * size) * 4;
      sheet.set(tile.subarray(y * size * 4, (y + 1) * size * 4), destination);
    }
  });

  return { bytes: encodePng(width, rows * size, sheet), size, columns, rows };
}

/**
 * Flatten every `LM_geo` mesh in an authored `.lm` into a single preview mesh.
 *
 * This closes the loop: an entity authored in Blender previews in Blender **as itself**.
 * Without it, `metadata.model` can only ever point at a procedural stand-in, and a designer
 * discovers the real shape after export.
 *
 * Hierarchy, materials and collision kinds are all irrelevant to a placement aid, so world
 * matrices are baked in and everything is merged. Volume brushes are skipped deliberately:
 * they are invisible in game, and a designer placing an entity should see what the player
 * will see. Returns `null` when the definition draws nothing at all.
 */
export function previewFromDefinition(bytes: Uint8Array): PreviewGeometry | null {
  const glb = parseGlb(bytes);
  const positions: Vec3[] = [];
  const normals: Vec3[] = [];
  const indices: number[] = [];
  let haveNormals = true;

  for (const entry of flattenScene(glb)) {
    if (!entry.node.extensions?.[LM_GEO_EXTENSION]) continue;
    const meshIndex = entry.node.mesh;
    if (meshIndex === undefined) continue;

    for (const prim of readMeshPrimitives(glb, meshIndex)) {
      const base = positions.length;
      for (let i = 0; i + 2 < prim.positions.length; i += 3) {
        positions.push(
          transformPoint(entry.world, [
            prim.positions[i]!,
            prim.positions[i + 1]!,
            prim.positions[i + 2]!,
          ]),
        );
      }
      if (prim.normals && prim.normals.length === prim.positions.length) {
        for (let i = 0; i + 2 < prim.normals.length; i += 3) {
          normals.push(
            transformDirection(entry.world, [
              prim.normals[i]!,
              prim.normals[i + 1]!,
              prim.normals[i + 2]!,
            ]),
          );
        }
      } else {
        haveNormals = false;
      }
      const count = (prim.positions.length / 3) | 0;
      if (prim.indices) for (const index of prim.indices) indices.push(base + index);
      else for (let i = 0; i < count; i++) indices.push(base + i);
    }
  }

  if (positions.length === 0 || indices.length === 0) return null;
  // Normals are all-or-nothing: a partial array would not line up with the positions.
  return haveNormals && normals.length === positions.length
    ? { positions, normals, indices }
    : { positions, indices };
}

export type { PrimitiveMesh };
