// Minimal glTF 2.0 binary reader — enough to walk a `.lm` file's node tree, read the LM_*
// extensions, and pull mesh geometry for rendering and collision.
//
// Plain `ArrayBuffer` + typed arrays: no DOM, no Node, no Three. The same code runs in a
// browser bundle, in a headless build script, and on an authoritative game server, which is
// the point — a level must resolve to the *same* geometry on every host that loads it.
//
// Deliberately partial: no skins, sparse accessors, or Draco/meshopt compression. A `.lm`
// produced by the Liminal exporter uses none of them. If you need a full-featured loader for
// your *rendering* assets, use one — this reader exists so that parsing a level never drags a
// renderer into your server build.
//
// Textures are read as far as it is useful to without a renderer: `readImage` hands back the
// ENCODED bytes (PNG/JPEG) of an embedded image, and materials carry which image fills which
// slot. Decoding pixels is the host's job — see `readImage`.
//
// Animation support is TRS-only (`readAnimations` below) — translation/rotation/scale node
// channels, named clips, no skinning and no morph-target (`weights`) channels.

import {
  IDENTITY_MAT4,
  composeTrs,
  multiplyMat4,
  transformPoint,
  type Mat4,
} from '../math.ts';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

export interface GltfJson {
  readonly asset?: { readonly version?: string; readonly generator?: string };
  readonly scene?: number;
  readonly scenes?: readonly { readonly nodes?: readonly number[] }[];
  readonly nodes?: readonly GltfNode[];
  readonly meshes?: readonly GltfMesh[];
  readonly materials?: readonly GltfMaterial[];
  readonly accessors?: readonly GltfAccessor[];
  readonly bufferViews?: readonly GltfBufferView[];
  readonly buffers?: readonly { readonly byteLength: number; readonly uri?: string }[];
  readonly extensionsUsed?: readonly string[];
  readonly animations?: readonly GltfAnimation[];
  readonly images?: readonly GltfImage[];
  readonly textures?: readonly GltfTexture[];
  readonly samplers?: readonly GltfSampler[];
}

/**
 * An image, either packed into the BIN chunk (`bufferView`) or pointed at a file (`uri`).
 *
 * Both forms occur in practice: Blender's glTF exporter embeds when writing a `.glb`, which is
 * what an `incoming_*.glb` material pack looks like. `readImage` only resolves the embedded
 * form and `data:` URIs — a file `uri` needs a filesystem, which this package deliberately does
 * not have.
 */
export interface GltfImage {
  readonly name?: string;
  readonly mimeType?: string;
  readonly bufferView?: number;
  readonly uri?: string;
}

export interface GltfTexture {
  readonly sampler?: number;
  readonly source?: number;
  readonly name?: string;
}

/** Filter and wrap modes, as raw GL enums. `undefined` means "the implementation picks". */
export interface GltfSampler {
  readonly magFilter?: number;
  readonly minFilter?: number;
  readonly wrapS?: number;
  readonly wrapT?: number;
}

/** One keyframe track: which accessor holds the times, which holds the values, and how to
 *  step between them. `output`'s row width depends on `channel.target.path` (3 for
 *  translation/scale, 4 for rotation) and, for `CUBICSPLINE`, is 3 rows per keyframe
 *  (in-tangent, value, out-tangent) — see `readAnimations`. */
export interface GltfAnimationSampler {
  readonly input: number;
  readonly output: number;
  readonly interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

export interface GltfAnimationChannel {
  readonly sampler: number;
  readonly target: {
    readonly node?: number;
    readonly path: 'translation' | 'rotation' | 'scale' | 'weights';
  };
}

export interface GltfAnimation {
  readonly name?: string;
  readonly channels: readonly GltfAnimationChannel[];
  readonly samplers: readonly GltfAnimationSampler[];
}

/**
 * A glTF PBR material.
 *
 * The `name` is the contract with the material library: the designer assigns a library
 * material to a mesh in Blender, its name rides the exported primitive, and your importer
 * resolves it back to your own material by that name. The PBR factors are read too, so a
 * material your game does *not* know still draws with its authored colour rather than a
 * flat default.
 */
export interface GltfMaterial {
  readonly name?: string;
  readonly pbrMetallicRoughness?: {
    readonly baseColorFactor?: readonly number[];
    readonly metallicFactor?: number;
    readonly roughnessFactor?: number;
    readonly baseColorTexture?: GltfTextureInfo;
    readonly metallicRoughnessTexture?: GltfTextureInfo;
  };
  readonly emissiveFactor?: readonly number[];
  readonly doubleSided?: boolean;
  readonly normalTexture?: GltfTextureInfo & { readonly scale?: number };
  readonly occlusionTexture?: GltfTextureInfo & { readonly strength?: number };
  readonly emissiveTexture?: GltfTextureInfo;
}

export interface GltfTextureInfo {
  readonly index: number;
  readonly texCoord?: number;
}

export interface GltfNode {
  readonly name?: string;
  readonly children?: readonly number[];
  readonly mesh?: number;
  readonly matrix?: readonly number[]; // column-major 4x4
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[]; // quaternion xyzw
  readonly scale?: readonly number[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface GltfMesh {
  readonly name?: string;
  readonly primitives: readonly {
    readonly attributes: Readonly<Record<string, number>>;
    readonly indices?: number;
    readonly material?: number;
  }[];
}

export interface GltfAccessor {
  readonly bufferView?: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
  readonly normalized?: boolean;
}

export interface GltfBufferView {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
}

export class GlbError extends Error {}

export interface Glb {
  readonly json: GltfJson;
  readonly bin: Uint8Array | null;
}

/** Split a `.glb`/`.lm` container into its JSON and BIN chunks. */
export function parseGlb(data: ArrayBuffer | Uint8Array): Glb {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) throw new GlbError('not a glb: file is too short');
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new GlbError('not a glb: bad magic (a .lm file is a binary glTF)');
  }
  const version = view.getUint32(4, true);
  if (version !== 2) throw new GlbError(`unsupported glb version ${version}, expected 2`);

  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > bytes.byteLength) throw new GlbError('truncated glb chunk');
    if (chunkType === CHUNK_JSON) {
      json = JSON.parse(decodeUtf8(bytes.subarray(start, end))) as GltfJson;
    } else if (chunkType === CHUNK_BIN) {
      bin = bytes.subarray(start, end);
    }
    offset = end;
  }

  if (!json) throw new GlbError('glb has no JSON chunk');
  return { json, bin };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

// ── Accessors ────────────────────────────────────────────────────────────────

const COMPONENT_SIZE: Readonly<Record<number, number>> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/**
 * Read an accessor as numeric tuples, one array per element. Handles interleaved buffer
 * views via `byteStride`, which Blender's exporter does emit.
 */
export function readAccessor(glb: Glb, accessorIndex: number): number[][] {
  const accessor = glb.json.accessors?.[accessorIndex];
  if (!accessor) throw new GlbError(`accessor ${accessorIndex} not found`);
  const components = TYPE_COMPONENTS[accessor.type];
  const componentSize = COMPONENT_SIZE[accessor.componentType];
  if (!components || !componentSize) {
    throw new GlbError(`unsupported accessor (type ${accessor.type}/${accessor.componentType})`);
  }
  if (accessor.bufferView === undefined) {
    // Spec-legal: an accessor with no bufferView reads as all-zero.
    return Array.from({ length: accessor.count }, () => new Array<number>(components).fill(0));
  }
  const bufferView = glb.json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new GlbError(`bufferView ${accessor.bufferView} not found`);
  if (!glb.bin) throw new GlbError('accessor reads from BIN, but the glb has no BIN chunk');

  const elementSize = components * componentSize;
  const stride = bufferView.byteStride ?? elementSize;
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);

  const out: number[][] = [];
  for (let i = 0; i < accessor.count; i++) {
    const element: number[] = [];
    for (let c = 0; c < components; c++) {
      element.push(
        readComponent(view, base + i * stride + c * componentSize, accessor.componentType),
      );
    }
    out.push(element);
  }
  return out;
}

function readComponent(view: DataView, offset: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return view.getInt8(offset);
    case 5121:
      return view.getUint8(offset);
    case 5122:
      return view.getInt16(offset, true);
    case 5123:
      return view.getUint16(offset, true);
    case 5125:
      return view.getUint32(offset, true);
    case 5126:
      return view.getFloat32(offset, true);
    default:
      throw new GlbError(`unsupported componentType ${componentType}`);
  }
}

// ── Node hierarchy ───────────────────────────────────────────────────────────

/** Local transform of a node, from either `matrix` or the TRS triple. */
export function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix && node.matrix.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return composeTrs(
    [tx ?? 0, ty ?? 0, tz ?? 0],
    [qx ?? 0, qy ?? 0, qz ?? 0, qw ?? 1],
    [sx ?? 1, sy ?? 1, sz ?? 1],
  );
}

export interface FlatNode {
  readonly index: number;
  readonly node: GltfNode;
  /** Accumulated parent transforms — the `.lm` scene graph mirrors Blender's hierarchy. */
  readonly world: Mat4;
  /** Relative to `parent`, or equal to `world` for a root. */
  readonly local: Mat4;
  /** The parent node's index, or null for a root. A skipped scene wrapper parents nothing. */
  readonly parent: number | null;
  /** True for the scene wrapper `isSceneWrapper` skips: it names nothing and is not part of the tree. */
  readonly wrapper: boolean;
  /**
   * Slash-joined ancestor names, e.g. `Mast/Strobe`. This is the address by which gameplay
   * code reaches a specific node inside an authored entity, so it follows the designer's
   * Blender outliner naming rather than any index. An unnamed node falls back to
   * `node-<index>`, so a path is always well-formed and unique.
   *
   * Blender's master collection is skipped — see `isSceneWrapper`.
   */
  readonly path: string;
}

/**
 * True for a scene root that exists only to wrap the file's contents, contributing no path
 * segment of its own.
 *
 * The addon exports with `export_hierarchy_full_collections=True`, so every Blender
 * collection becomes a glTF node — including the master collection every scene has whether
 * the designer made one or not. Left in, every authored address would begin
 * `Scene Collection/…`: a Blender implementation detail leaking into your gameplay API, and
 * one whose name is localized. Collections the designer *did* create stay in the path,
 * because those are structure worth addressing through.
 *
 * The test is narrow on purpose — an empty root carrying neither geometry nor an extension —
 * so a designer who genuinely places a mesh or an entity at the scene root keeps its name.
 */
function isSceneWrapper(node: GltfNode): boolean {
  // The export hook seeds `extensions` to `{}` on every node before deciding whether to
  // write one, so "has no extension" has to mean empty, not absent.
  return node.mesh === undefined && Object.keys(node.extensions ?? {}).length === 0;
}

/** Depth-first walk of the default scene, resolving every node's world transform. */
export function flattenScene(glb: Glb): FlatNode[] {
  const nodes = glb.json.nodes ?? [];
  const sceneIndex = glb.json.scene ?? 0;
  const roots = glb.json.scenes?.[sceneIndex]?.nodes ?? [];

  const out: FlatNode[] = [];
  const seen = new Set<number>();

  const visit = (index: number, parentWorld: Mat4, parentPath: string, parent: number | null, isRoot: boolean): void => {
    const node = nodes[index];
    if (!node || seen.has(index)) return; // cycles are malformed, but must not hang the importer
    seen.add(index);
    const world = multiplyMat4(parentWorld, localMatrix(node));
    const skip = isRoot && isSceneWrapper(node);
    const name = node.name ?? `node-${index}`;
    const path = skip ? parentPath : parentPath ? `${parentPath}/${name}` : name;
    // A skipped wrapper still contributes its transform, and is still emitted so callers
    // that walk by index see the whole file; it just does not name anything.
    out.push({ index, node, world, local: parent === null ? world : localMatrix(node), parent, wrapper: skip, path });
    for (const child of node.children ?? []) visit(child, world, path, skip ? null : index, false);
  };

  for (const root of roots) visit(root, IDENTITY_MAT4, '', null, true);
  return out;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * The material a primitive references, flattened. `name` is what you match against your own
 * material registry; the PBR factors are the embedded fallback for a material the registry
 * does not know. Colour is linear-space, as glTF specifies.
 */
export interface PrimitiveMaterial {
  readonly name: string | null;
  readonly color: readonly [number, number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  readonly emissive: readonly [number, number, number] | null;
  /**
   * The material's texture maps, or null when it is pure PBR factors.
   *
   * Read the pixels with `readImage(glb, ref.image)`. A textured material's FACTORS are
   * multipliers over its maps, not a substitute for them — Blender exports a texture-driven
   * material with `baseColorFactor` at `[1,1,1,1]`, so a reader that ignores this field draws
   * flat white and reports nothing wrong.
   */
  readonly textures: MaterialTextures | null;
}

/**
 * One texture binding on a material: which image, and which UV set samples it.
 *
 * `image` indexes the file's `images` array rather than carrying pixels, because several slots
 * routinely share one image — the standard ORM packing puts occlusion and metallic-roughness on
 * the same file, and a consumer that re-decoded per slot would pay for it twice.
 */
export interface MaterialTextureRef {
  readonly image: number;
  /** The `TEXCOORD_<n>` attribute this samples. Nearly always 0. */
  readonly texCoord: number;
  /** `normalTexture` only — the normal map's strength. */
  readonly scale?: number;
  /** `occlusionTexture` only — how far the map is allowed to darken. */
  readonly strength?: number;
}

/** The glTF metallic-roughness texture slots, named for what they mean rather than for glTF. */
export interface MaterialTextures {
  readonly baseColor?: MaterialTextureRef;
  /** Blue channel = metallic, green = roughness. One image, two maps — glTF packs them. */
  readonly metallicRoughness?: MaterialTextureRef;
  readonly normal?: MaterialTextureRef;
  /** Ambient occlusion, conventionally the red channel of the metallic-roughness image. */
  readonly occlusion?: MaterialTextureRef;
  readonly emissive?: MaterialTextureRef;
}

/** Image pixels as they sit in the file — still encoded as PNG/JPEG, not decoded. */
export interface GlbImage {
  /** The image's own name, when the exporter wrote one. */
  readonly name: string | null;
  /** e.g. `image/png`. Inferred from a `data:` URI when the image does not declare it. */
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/**
 * A single mesh primitive's raw geometry, in the mesh's LOCAL frame. `positions`/`normals`
 * are flat xyz triples, `uvs` flat uv pairs, `indices` the triangle index list (null for a
 * non-indexed draw).
 *
 * This is what a renderer needs and what a concave collider is built from — read once, used
 * for both, so the drawn surface and the collision surface can never drift apart.
 */
export interface PrimitiveGeometry {
  readonly positions: number[];
  readonly normals: number[] | null;
  readonly uvs: number[] | null;
  readonly indices: number[] | null;
  /** The primitive's resolved material, or null when it references none. */
  readonly material: PrimitiveMaterial | null;
}

/** Every primitive of a mesh as local geometry. Empty when the index names no mesh. */
export function readMeshPrimitives(glb: Glb, meshIndex: number): PrimitiveGeometry[] {
  const mesh = glb.json.meshes?.[meshIndex];
  if (!mesh) return [];
  const out: PrimitiveGeometry[] = [];
  for (const primitive of mesh.primitives) {
    const posAccessor = primitive.attributes['POSITION'];
    if (posAccessor === undefined) continue;
    const positions = flattenN(readAccessor(glb, posAccessor), 3);
    const normAccessor = primitive.attributes['NORMAL'];
    const normals = normAccessor === undefined ? null : flattenN(readAccessor(glb, normAccessor), 3);
    const uvAccessor = primitive.attributes['TEXCOORD_0'];
    const uvs = uvAccessor === undefined ? null : flattenN(readAccessor(glb, uvAccessor), 2);
    const indices =
      primitive.indices === undefined ? null : flattenN(readAccessor(glb, primitive.indices), 1);
    out.push({
      positions,
      normals,
      uvs,
      indices,
      material: resolveMaterial(glb, primitive.material),
    });
  }
  return out;
}

/** Resolve a primitive's `material` index into a flat PBR record, or null. */
function resolveMaterial(glb: Glb, index: number | undefined): PrimitiveMaterial | null {
  if (index === undefined) return null;
  const m = glb.json.materials?.[index];
  if (!m) return null;
  const pbr = m.pbrMetallicRoughness ?? {};
  const c = pbr.baseColorFactor ?? [1, 1, 1, 1];
  const e = m.emissiveFactor;
  return {
    name: m.name ?? null,
    color: [c[0] ?? 1, c[1] ?? 1, c[2] ?? 1, c[3] ?? 1],
    metallic: pbr.metallicFactor ?? 1,
    roughness: pbr.roughnessFactor ?? 1,
    emissive: e ? [e[0] ?? 0, e[1] ?? 0, e[2] ?? 0] : null,
    textures: resolveTextures(glb, m),
  };
}

/**
 * A material's texture slots, resolved from texture indices down to IMAGE indices.
 *
 * The `textures` array is an indirection glTF needs (a texture is an image plus a sampler, and
 * the same image can be sampled two ways) but that nothing downstream of here does — every
 * consumer wants "which picture", and samplers are a rendering detail read separately via
 * `readSampler`. Collapsing it here keeps that indirection out of every caller.
 *
 * Returns null when the material binds no textures at all, so the common flat-colour material
 * costs nothing and `textures === null` is a meaningful, cheap test.
 */
function resolveTextures(glb: Glb, material: GltfMaterial): MaterialTextures | null {
  const pbr = material.pbrMetallicRoughness ?? {};
  const out: {
    baseColor?: MaterialTextureRef;
    metallicRoughness?: MaterialTextureRef;
    normal?: MaterialTextureRef;
    occlusion?: MaterialTextureRef;
    emissive?: MaterialTextureRef;
  } = {};

  const baseColor = textureRef(glb, pbr.baseColorTexture);
  if (baseColor) out.baseColor = baseColor;
  const metallicRoughness = textureRef(glb, pbr.metallicRoughnessTexture);
  if (metallicRoughness) out.metallicRoughness = metallicRoughness;
  const normal = textureRef(glb, material.normalTexture);
  if (normal) out.normal = { ...normal, ...(material.normalTexture?.scale !== undefined ? { scale: material.normalTexture.scale } : {}) };
  const occlusion = textureRef(glb, material.occlusionTexture);
  if (occlusion) {
    out.occlusion = {
      ...occlusion,
      ...(material.occlusionTexture?.strength !== undefined
        ? { strength: material.occlusionTexture.strength }
        : {}),
    };
  }
  const emissive = textureRef(glb, material.emissiveTexture);
  if (emissive) out.emissive = emissive;

  return Object.keys(out).length > 0 ? out : null;
}

/** One `textureInfo` → the image it ultimately names, or null if it dangles. */
function textureRef(glb: Glb, info: GltfTextureInfo | undefined): MaterialTextureRef | null {
  if (!info) return null;
  const texture = glb.json.textures?.[info.index];
  // A texture with no `source` is spec-legal (an extension is meant to supply the image, e.g.
  // KHR_texture_basisu). We cannot read one, and a caller is better served by "no texture here"
  // than by a reference to an image that does not exist.
  if (!texture || texture.source === undefined) return null;
  return { image: texture.source, texCoord: info.texCoord ?? 0 };
}

/**
 * The encoded bytes of one image, or null when they are not in this file.
 *
 * Handles the two forms a self-contained `.glb` uses: a `bufferView` into the BIN chunk, and a
 * `data:` URI. An image pointing at a separate FILE returns null — resolving that needs a
 * filesystem, and this package runs in a browser bundle and on a game server where there is
 * none. The caller has the path (`glb.json.images[i].uri`) and can fetch it however it likes.
 *
 * Pixels are NOT decoded: this hands back the PNG/JPEG as stored. Decoding an image is the
 * host's job — `createImageBitmap` in a browser, a codec on a build machine — and dragging one
 * in here would put a decoder in every consumer's bundle.
 */
export function readImage(glb: Glb, imageIndex: number): GlbImage | null {
  const image = glb.json.images?.[imageIndex];
  if (!image) return null;
  const name = image.name ?? null;

  if (image.bufferView !== undefined) {
    const view = glb.json.bufferViews?.[image.bufferView];
    if (!view || !glb.bin) return null;
    const start = view.byteOffset ?? 0;
    return {
      name,
      mimeType: image.mimeType ?? 'application/octet-stream',
      // A subarray, not a copy: an image is routinely megabytes and most callers write it
      // straight back out. Do not mutate it.
      bytes: glb.bin.subarray(start, start + view.byteLength),
    };
  }

  if (image.uri?.startsWith('data:')) {
    const comma = image.uri.indexOf(',');
    const header = image.uri.slice(5, comma);
    if (!header.endsWith(';base64')) return null;
    return {
      name,
      mimeType: image.mimeType ?? header.slice(0, -';base64'.length) ?? 'application/octet-stream',
      bytes: decodeBase64(image.uri.slice(comma + 1)),
    };
  }

  return null; // an external file uri — the caller's to fetch
}

function decodeBase64(text: string): Uint8Array {
  // `atob` in a browser, `Buffer` under Node — neither is universal, so feature-detect rather
  // than importing anything. Keeps this module free of a Node dependency, as the header says.
  const globalAtob = (globalThis as { atob?: (data: string) => string }).atob;
  if (globalAtob) {
    const binary = globalAtob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const nodeBuffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(text, 'base64'));
  throw new GlbError('no base64 decoder available to read a data: image');
}

/** The sampler bound to a texture — filter and wrap modes as raw GL enums, or null. */
export function readSampler(glb: Glb, textureIndex: number): GltfSampler | null {
  const texture = glb.json.textures?.[textureIndex];
  if (!texture || texture.sampler === undefined) return null;
  return glb.json.samplers?.[texture.sampler] ?? null;
}

/**
 * Every material in the file's `materials` array, resolved to flat PBR records — independent
 * of whether any mesh primitive actually references them.
 *
 * A carrier-mesh material library (`buildMaterialLibrary`, or the Blender addon's own
 * `incoming_<pack>.glb`) binds exactly one primitive per material anyway, but tooling that
 * reads a material library cares about the materials array itself, not the throwaway meshes
 * carrying it — this is that read, without the detour through `readMeshPrimitives`.
 */
export function readMaterials(glb: Glb): PrimitiveMaterial[] {
  const count = glb.json.materials?.length ?? 0;
  const out: PrimitiveMaterial[] = [];
  for (let i = 0; i < count; i++) {
    const material = resolveMaterial(glb, i);
    if (material) out.push(material);
  }
  return out;
}

function flattenN(rows: number[][], n: number): number[] {
  const out: number[] = [];
  for (const r of rows) for (let i = 0; i < n; i++) out.push(r[i] ?? 0);
  return out;
}

/** Geometry merged from every primitive of one mesh. Attribute arrays stay index-aligned. */
export interface MergedGeometry {
  readonly positions: number[];
  readonly normals: number[] | null;
  readonly uvs: number[] | null;
  readonly indices: number[] | null;
  readonly material: PrimitiveMaterial | null;
}

/**
 * Concatenate a node's primitives into one geometry, offsetting each primitive's indices.
 *
 * Nearly always a single primitive; merging keeps a multi-material mesh in one collider and
 * one draw call without special-casing. Normals, UVs and indices drop to `null` if any
 * primitive lacks them, so a partially-attributed mesh degrades rather than desyncing its
 * arrays. The first primitive's material stands for the whole merged draw.
 */
export function mergePrimitives(prims: readonly PrimitiveGeometry[]): MergedGeometry {
  if (prims.length === 1) {
    const only = prims[0]!;
    return {
      positions: only.positions,
      normals: only.normals,
      uvs: only.uvs,
      indices: only.indices,
      material: only.material,
    };
  }
  const positions: number[] = [];
  let normals: number[] | null = [];
  let uvs: number[] | null = [];
  let indices: number[] | null = [];
  for (const p of prims) {
    const base = positions.length / 3;
    positions.push(...p.positions);
    if (normals && p.normals && p.normals.length === p.positions.length) normals.push(...p.normals);
    else normals = null;
    if (uvs && p.uvs && p.uvs.length === (p.positions.length / 3) * 2) uvs.push(...p.uvs);
    else uvs = null;
    if (indices && p.indices) for (const i of p.indices) indices.push(i + base);
    else indices = null;
  }
  return { positions, normals, uvs, indices, material: prims[0]?.material ?? null };
}

/**
 * Every primitive of a mesh, merged **per distinct material** rather than all into one.
 *
 * `mergePrimitives` collapses a multi-material mesh to its first primitive's material — right
 * for a collider (every primitive still contributes its geometry to the single hull), wrong
 * for a draw (every primitive but the first silently loses its material). This keeps each
 * material's faces as their own merged geometry instead, so a designer's material slots reach
 * the renderer. The overwhelmingly common case — one primitive, or several that already share
 * a material — still returns exactly one entry, byte-identical to `mergePrimitives`' result.
 *
 * Primitive order is preserved as material *first-seen* order, not sorted, so the result is
 * deterministic across identical exports without depending on glTF's material index order.
 */
export function mergePrimitivesByMaterial(prims: readonly PrimitiveGeometry[]): MergedGeometry[] {
  if (prims.length <= 1) return prims.length === 0 ? [] : [mergePrimitives(prims)];
  const groups = new Map<string, PrimitiveGeometry[]>();
  const order: string[] = [];
  for (const p of prims) {
    const key = p.material?.name ?? '';
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(p);
  }
  return order.map((key) => mergePrimitives(groups.get(key)!));
}

// ── Animation ────────────────────────────────────────────────────────────────

/**
 * One TRS channel, resolved to numeric keyframes. `values` is one row per `times` entry —
 * length 3 for `translation`/`scale`, 4 (quaternion xyzw) for `rotation`. `CUBICSPLINE` is
 * already downgraded to `LINEAR` here (see `readAnimations`), so this is the only shape a
 * caller ever has to handle.
 */
export interface AnimationTrackRaw {
  readonly nodeIndex: number;
  readonly path: 'translation' | 'rotation' | 'scale';
  readonly times: number[];
  readonly values: number[][];
  readonly interpolation: 'LINEAR' | 'STEP';
}

export interface AnimationRaw {
  readonly name: string;
  readonly tracks: readonly AnimationTrackRaw[];
}

/**
 * Every animation in the file, TRS channels only.
 *
 * A `weights` channel (morph target animation) or one with no `target.node` (a
 * `KHR_animation_pointer`-style channel targeting a material/light/camera property) is
 * skipped outright — both are out of scope for this reader's "basic TRS, named clips" pipeline
 * and silently dropping them here is what keeps every other caller from having to know they
 * exist.
 *
 * `CUBICSPLINE` is downgraded to `LINEAR` by keeping only the value row of each keyframe
 * triple (in-tangent, value, out-tangent) and discarding the tangents. This matters in
 * practice: Blender's default keyframe interpolation is Bezier, which its glTF exporter writes
 * as `CUBICSPLINE` — without this downgrade, ordinary Blender authoring (nobody sets Linear by
 * hand) would fail to import at all.
 */
export function readAnimations(glb: Glb, flat: readonly FlatNode[]): readonly AnimationRaw[] {
  const animations = glb.json.animations;
  if (!animations || animations.length === 0) return [];
  const known = new Set(flat.map((f) => f.index));

  return animations.map((anim, animIndex) => {
    const tracks: AnimationTrackRaw[] = [];
    for (const channel of anim.channels) {
      const nodeIndex = channel.target.node;
      if (nodeIndex === undefined || channel.target.path === 'weights') continue;
      // A channel may target a node that didn't survive `flattenScene` (e.g. unreachable from
      // the default scene's roots) — skip rather than throw, matching this reader's general
      // "malformed input degrades, it does not hang the importer" stance (see `flattenScene`).
      if (!known.has(nodeIndex)) continue;
      const sampler = anim.samplers[channel.sampler];
      if (!sampler) continue;

      const times = flattenN(readAccessor(glb, sampler.input), 1);
      const rowWidth = channel.target.path === 'rotation' ? 4 : 3;
      const outputRows = readAccessor(glb, sampler.output);

      let values: number[][];
      let interpolation: 'LINEAR' | 'STEP';
      if (sampler.interpolation === 'CUBICSPLINE') {
        // 3 rows per keyframe: in-tangent, value, out-tangent — keep only the middle row.
        values = times.map((_, k) => outputRows[3 * k + 1] ?? new Array(rowWidth).fill(0));
        interpolation = 'LINEAR';
      } else {
        values = outputRows;
        interpolation = sampler.interpolation === 'STEP' ? 'STEP' : 'LINEAR';
      }

      tracks.push({ nodeIndex, path: channel.target.path, times, values, interpolation });
    }
    return { name: anim.name ?? `animation-${animIndex}`, tracks };
  });
}

/** All POSITION values of a node's mesh, in world space. Empty when the node has no mesh. */
export function meshWorldPositions(glb: Glb, flat: FlatNode): [number, number, number][] {
  const meshIndex = flat.node.mesh;
  if (meshIndex === undefined) return [];
  const mesh = glb.json.meshes?.[meshIndex];
  if (!mesh) return [];

  const out: [number, number, number][] = [];
  for (const primitive of mesh.primitives) {
    const positionAccessor = primitive.attributes['POSITION'];
    if (positionAccessor === undefined) continue;
    for (const p of readAccessor(glb, positionAccessor)) {
      out.push(transformPoint(flat.world, [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]));
    }
  }
  return out;
}
