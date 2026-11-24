// Minimal glTF 2.0 binary writer.
//
// Everything you hand *to* Blender is a `.glb`: entity preview models, the material library,
// and — if you generate levels programmatically — `.lm` files themselves. A full exporter is
// a browser-oriented dependency for what is a few hundred lines of buffer packing, so this
// writes the container directly. It pairs with the reader in `../glb/read.ts`, and the two
// round-trip.
//
// Its own entry point (`@liminal-lv/core/glb-write`) because a game client only ever *reads*
// levels; there is no reason for a writer to end up in your bundle.

import type { Vec3, Vec4 } from '../math.ts';

// Re-exported here because writing a node's `rotation` is the reason anyone needs them, and
// a script that only writes `.lm` files should not have to import the whole package for it.
export { quatFromYRotation, quatFromZRotation } from '../math.ts';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

export type { Vec3, Vec4 };

export interface GlbMaterialInput {
  readonly name: string;
  readonly baseColorFactor: Vec4;
  readonly metallic: number;
  readonly roughness: number;
  readonly emissiveFactor?: Vec3;
  /** Texture slots, as indices into `GlbDocument.images`. */
  readonly textures?: GlbMaterialTextures;
  readonly doubleSided?: boolean;
}

/**
 * A material's texture slots when writing, each an index into `GlbDocument.images`.
 *
 * Indices name IMAGES, not glTF textures: the writer mints the `textures` array itself, one
 * entry per image against a single shared sampler. That is the only arrangement this writer
 * emits, and it keeps a caller from having to build two parallel arrays to say "this picture,
 * here".
 */
export interface GlbMaterialTextures {
  readonly baseColor?: number;
  readonly metallicRoughness?: number;
  readonly normal?: number;
  readonly occlusion?: number;
  readonly emissive?: number;
}

/** One embedded image. Bytes are the ENCODED file (PNG/JPEG) — the writer does not encode. */
export interface GlbImageInput {
  readonly name?: string;
  /** e.g. `image/png`. Written as-is; glTF only *requires* PNG and JPEG support. */
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface GlbMeshInput {
  readonly name: string;
  readonly positions: readonly Vec3[];
  readonly normals?: readonly Vec3[];
  readonly indices: readonly number[];
  readonly material?: number;
}

export interface GlbNodeInput {
  readonly name: string;
  readonly mesh?: number;
  readonly translation?: Vec3;
  /** Quaternion, xyzw. */
  readonly rotation?: Vec4;
  readonly scale?: Vec3;
  readonly children?: readonly number[];
  /** Node extensions — this is where `LM_entity` / `LM_geo` go when writing a `.lm`. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/**
 * One TRS channel, test-fixture shape — mirrors `../glb/read.ts`'s `AnimationTrackRaw` closely
 * enough that a round-trip test can build one of these and assert it reads back unchanged.
 * `values` rows must be Vec3 (`translation`/`scale`) or Vec4 (`rotation`, xyzw) matching `path`.
 * For `CUBICSPLINE`, supply 3 rows per keyframe (in-tangent, value, out-tangent) — the writer
 * does not know or care about tangent semantics, it just writes whatever rows it's given.
 */
export interface GlbAnimationChannelInput {
  readonly targetNode: number;
  readonly path: 'translation' | 'rotation' | 'scale' | 'weights';
  readonly times: readonly number[];
  readonly values: readonly (readonly number[])[];
  readonly interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

export interface GlbAnimationInput {
  readonly name: string;
  readonly channels: readonly GlbAnimationChannelInput[];
}

export interface GlbDocument {
  readonly nodes: readonly GlbNodeInput[];
  readonly meshes?: readonly GlbMeshInput[];
  readonly materials?: readonly GlbMaterialInput[];
  /** Images packed into the BIN chunk, referenced by `GlbMaterialInput.textures`. */
  readonly images?: readonly GlbImageInput[];
  readonly animations?: readonly GlbAnimationInput[];
  /** Indices into `nodes`. Defaults to every node that is not someone's child. */
  readonly roots?: readonly number[];
  readonly extensionsUsed?: readonly string[];
  readonly generator?: string;
}

interface PendingView {
  readonly bytes: Uint8Array;
  readonly target?: number;
}

class BufferBuilder {
  readonly bufferViews: Record<string, unknown>[] = [];
  private readonly views: PendingView[] = [];
  private offset = 0;

  /** Append a view, 4-byte aligned as the spec requires, and return its index. */
  add(bytes: Uint8Array, target?: number): number {
    const padding = (4 - (this.offset % 4)) % 4;
    if (padding > 0) {
      this.views.push({ bytes: new Uint8Array(padding) });
      this.offset += padding;
    }
    const view: Record<string, unknown> = {
      buffer: 0,
      byteOffset: this.offset,
      byteLength: bytes.byteLength,
    };
    if (target !== undefined) view['target'] = target;
    this.bufferViews.push(view);
    this.views.push({ bytes, target });
    this.offset += bytes.byteLength;
    return this.bufferViews.length - 1;
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.offset);
    let cursor = 0;
    for (const view of this.views) {
      out.set(view.bytes, cursor);
      cursor += view.bytes.byteLength;
    }
    return out;
  }
}

function vec3Bytes(values: readonly Vec3[]): Uint8Array {
  const array = new Float32Array(values.length * 3);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!v) continue;
    array[i * 3] = v[0];
    array[i * 3 + 1] = v[1];
    array[i * 3 + 2] = v[2];
  }
  return new Uint8Array(array.buffer);
}

/** Flatten rows of equal width into a packed Float32 buffer, for a SCALAR/VEC3/VEC4 accessor. */
function floatRowBytes(rows: readonly (readonly number[])[], width: number): Uint8Array {
  const array = new Float32Array(rows.length * width);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (let c = 0; c < width; c++) array[i * width + c] = row?.[c] ?? 0;
  }
  return new Uint8Array(array.buffer);
}

const ACCESSOR_TYPE_FOR_WIDTH: Readonly<Record<number, string>> = { 1: 'SCALAR', 3: 'VEC3', 4: 'VEC4' };

function bounds(values: readonly Vec3[]): { min: number[]; max: number[] } {
  if (values.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of values) {
    for (let axis = 0; axis < 3; axis++) {
      const component = v[axis] ?? 0;
      if (component < (min[axis] ?? Infinity)) min[axis] = component;
      if (component > (max[axis] ?? -Infinity)) max[axis] = component;
    }
  }
  return { min, max };
}

export function buildGlb(doc: GlbDocument): Uint8Array {
  const builder = new BufferBuilder();
  const accessors: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];

  for (const mesh of doc.meshes ?? []) {
    const positionView = builder.add(vec3Bytes(mesh.positions), TARGET_ARRAY_BUFFER);
    const { min, max } = bounds(mesh.positions);
    accessors.push({
      bufferView: positionView,
      componentType: COMPONENT_FLOAT,
      count: mesh.positions.length,
      type: 'VEC3',
      min,
      max,
    });
    const positionAccessor = accessors.length - 1;

    let normalAccessor: number | undefined;
    if (mesh.normals && mesh.normals.length === mesh.positions.length) {
      const normalView = builder.add(vec3Bytes(mesh.normals), TARGET_ARRAY_BUFFER);
      accessors.push({
        bufferView: normalView,
        componentType: COMPONENT_FLOAT,
        count: mesh.normals.length,
        type: 'VEC3',
      });
      normalAccessor = accessors.length - 1;
    }

    const indexView = builder.add(
      new Uint8Array(Uint32Array.from(mesh.indices).buffer),
      TARGET_ELEMENT_ARRAY_BUFFER,
    );
    accessors.push({
      bufferView: indexView,
      componentType: COMPONENT_UINT,
      count: mesh.indices.length,
      type: 'SCALAR',
    });
    const indexAccessor = accessors.length - 1;

    const attributes: Record<string, number> = { POSITION: positionAccessor };
    if (normalAccessor !== undefined) attributes['NORMAL'] = normalAccessor;
    const primitive: Record<string, unknown> = { attributes, indices: indexAccessor };
    if (mesh.material !== undefined) primitive['material'] = mesh.material;
    meshes.push({ name: mesh.name, primitives: [primitive] });
  }

  const childIndices = new Set<number>();
  for (const node of doc.nodes) {
    for (const child of node.children ?? []) childIndices.add(child);
  }
  const roots = doc.roots ?? doc.nodes.map((_, i) => i).filter((i) => !childIndices.has(i));

  const nodes = doc.nodes.map((node) => {
    const out: Record<string, unknown> = { name: node.name };
    if (node.mesh !== undefined) out['mesh'] = node.mesh;
    if (node.translation) out['translation'] = [...node.translation];
    if (node.rotation) out['rotation'] = [...node.rotation];
    if (node.scale) out['scale'] = [...node.scale];
    if (node.children && node.children.length > 0) out['children'] = [...node.children];
    if (node.extensions) out['extensions'] = node.extensions;
    return out;
  });

  // Images go into the BIN chunk like any other view. Deliberately NOT given a `target`:
  // that is for vertex/index data, and a validator rejects it on an image view.
  const images = (doc.images ?? []).map((image) => {
    const view = builder.add(image.bytes);
    const out: Record<string, unknown> = { bufferView: view, mimeType: image.mimeType };
    if (image.name) out['name'] = image.name;
    return out;
  });

  // One texture per image, all sharing a single sampler. Linear filtering with mipmaps and
  // repeat wrapping is what Blender's own exporter emits by default, and it is the right
  // default for a surface map; a caller needing per-texture sampling is better served by
  // writing the glTF itself than by an option nobody would set.
  const textures = images.map((_, index) => ({ sampler: 0, source: index }));
  const samplers = textures.length > 0
    ? [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]
    : [];

  const materials = (doc.materials ?? []).map((material) => {
    const pbr: Record<string, unknown> = {
      baseColorFactor: [...material.baseColorFactor],
      metallicFactor: material.metallic,
      roughnessFactor: material.roughness,
    };
    const out: Record<string, unknown> = { name: material.name, pbrMetallicRoughness: pbr };
    if (material.emissiveFactor) out['emissiveFactor'] = [...material.emissiveFactor];
    if (material.doubleSided) out['doubleSided'] = true;

    const slots = material.textures;
    if (slots) {
      // An index that names no image is dropped rather than written: a dangling texture
      // reference makes the whole file invalid, which is a far worse failure than a material
      // that comes out untextured.
      const ref = (index: number | undefined): { index: number } | null =>
        index !== undefined && index >= 0 && index < textures.length ? { index } : null;

      const baseColor = ref(slots.baseColor);
      if (baseColor) pbr['baseColorTexture'] = baseColor;
      const metallicRoughness = ref(slots.metallicRoughness);
      if (metallicRoughness) pbr['metallicRoughnessTexture'] = metallicRoughness;
      const normal = ref(slots.normal);
      if (normal) out['normalTexture'] = normal;
      const occlusion = ref(slots.occlusion);
      if (occlusion) out['occlusionTexture'] = occlusion;
      const emissive = ref(slots.emissive);
      if (emissive) {
        out['emissiveTexture'] = emissive;
        // glTF multiplies the emissive texture by `emissiveFactor`, which DEFAULTS TO BLACK —
        // so an emissive map with no factor written renders as nothing at all. Default it to
        // white here, and let an explicit factor above win.
        if (!material.emissiveFactor) out['emissiveFactor'] = [1, 1, 1];
      }
    }
    return out;
  });

  const animations = (doc.animations ?? []).map((anim) => {
    const samplers: Record<string, unknown>[] = [];
    const channels: Record<string, unknown>[] = [];
    for (const ch of anim.channels) {
      const timesView = builder.add(floatRowBytes(ch.times.map((t) => [t]), 1));
      accessors.push({
        bufferView: timesView,
        componentType: COMPONENT_FLOAT,
        count: ch.times.length,
        type: 'SCALAR',
        min: [Math.min(...ch.times)],
        max: [Math.max(...ch.times)],
      });
      const timesAccessor = accessors.length - 1;

      const width = ch.path === 'rotation' ? 4 : 3;
      const valuesView = builder.add(floatRowBytes(ch.values, width));
      accessors.push({
        bufferView: valuesView,
        componentType: COMPONENT_FLOAT,
        count: ch.values.length,
        type: ACCESSOR_TYPE_FOR_WIDTH[width],
      });
      const valuesAccessor = accessors.length - 1;

      const samplerIndex = samplers.length;
      samplers.push({
        input: timesAccessor,
        output: valuesAccessor,
        ...(ch.interpolation ? { interpolation: ch.interpolation } : {}),
      });
      channels.push({ sampler: samplerIndex, target: { node: ch.targetNode, path: ch.path } });
    }
    return { name: anim.name, channels, samplers };
  });

  const bin = builder.concat();
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: doc.generator ?? '@liminal-lv/core' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: roots }],
    nodes,
  };
  if (meshes.length > 0) json['meshes'] = meshes;
  if (materials.length > 0) json['materials'] = materials;
  if (images.length > 0) {
    json['images'] = images;
    json['textures'] = textures;
    json['samplers'] = samplers;
  }
  if (animations.length > 0) json['animations'] = animations;
  if (accessors.length > 0) json['accessors'] = accessors;
  if (builder.bufferViews.length > 0) json['bufferViews'] = builder.bufferViews;
  if (bin.byteLength > 0) json['buffers'] = [{ byteLength: bin.byteLength }];
  if (doc.extensionsUsed && doc.extensionsUsed.length > 0) {
    json['extensionsUsed'] = [...doc.extensionsUsed];
  }

  return packGlb(new TextEncoder().encode(JSON.stringify(json)), bin);
}

function packGlb(jsonBytes: Uint8Array, binBytes: Uint8Array): Uint8Array {
  // JSON pads with spaces, BIN pads with zeroes — required by the spec.
  const jsonPadding = (4 - (jsonBytes.byteLength % 4)) % 4;
  const binPadding = (4 - (binBytes.byteLength % 4)) % 4;
  const jsonLength = jsonBytes.byteLength + jsonPadding;
  const binLength = binBytes.byteLength + binPadding;
  const hasBin = binBytes.byteLength > 0;

  const total = 12 + 8 + jsonLength + (hasBin ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);

  if (hasBin) {
    const binChunkStart = 20 + jsonLength;
    view.setUint32(binChunkStart, binLength, true);
    view.setUint32(binChunkStart + 4, CHUNK_BIN, true);
    out.set(binBytes, binChunkStart + 8);
  }

  return out;
}

// ── Primitive builders ───────────────────────────────────────────────────────
//
// Authored in glTF space (Y-up). Blender's importer converts to Z-up, so a shape built
// "upright" here lands upright in Blender's FRONT view — which is the plane a 2D game's
// levels are authored in. See the coordinate-space note in `contract.ts`.

export interface PrimitiveMesh {
  positions: Vec3[];
  normals: Vec3[];
  indices: number[];
}

/** An axis-aligned box of the given FULL extents, centred on the origin. */
export function box(sx: number, sy: number, sz: number): PrimitiveMesh {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const faces: { normal: Vec3; corners: [Vec3, Vec3, Vec3, Vec3] }[] = [
    { normal: [0, 0, 1], corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { normal: [0, 0, -1], corners: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { normal: [1, 0, 0], corners: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { normal: [-1, 0, 0], corners: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { normal: [0, 1, 0], corners: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { normal: [0, -1, 0], corners: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
  ];

  const positions: Vec3[] = [];
  const normals: Vec3[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const base = positions.length;
    for (const corner of face.corners) {
      positions.push(corner);
      normals.push(face.normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

/** A cone with its apex at +Y, i.e. pointing along glTF "up". */
export function cone(radius: number, height: number, segments = 12): PrimitiveMesh {
  const positions: Vec3[] = [];
  const normals: Vec3[] = [];
  const indices: number[] = [];
  const apex: Vec3 = [0, height / 2, 0];
  const baseY = -height / 2;

  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0: Vec3 = [Math.cos(a0) * radius, baseY, Math.sin(a0) * radius];
    const p1: Vec3 = [Math.cos(a1) * radius, baseY, Math.sin(a1) * radius];

    const mid = (a0 + a1) / 2;
    const slope = radius / height;
    const side: Vec3 = normalize([Math.cos(mid), slope, Math.sin(mid)]);
    const base = positions.length;
    positions.push(apex, p0, p1);
    normals.push(side, side, side);
    indices.push(base, base + 1, base + 2);

    const capBase = positions.length;
    positions.push([0, baseY, 0], p1, p0);
    normals.push([0, -1, 0], [0, -1, 0], [0, -1, 0]);
    indices.push(capBase, capBase + 1, capBase + 2);
  }
  return { positions, normals, indices };
}

/** A UV sphere centred on the origin. */
export function sphere(radius: number, segments = 16, rings = 8): PrimitiveMesh {
  const positions: Vec3[] = [];
  const normals: Vec3[] = [];
  const indices: number[] = [];

  for (let ring = 0; ring <= rings; ring++) {
    const phi = (ring / rings) * Math.PI;
    for (let seg = 0; seg <= segments; seg++) {
      const theta = (seg / segments) * Math.PI * 2;
      const n: Vec3 = [
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ];
      normals.push(n);
      positions.push([n[0] * radius, n[1] * radius, n[2] * radius]);
    }
  }
  const stride = segments + 1;
  for (let ring = 0; ring < rings; ring++) {
    for (let seg = 0; seg < segments; seg++) {
      const a = ring * stride + seg;
      const b = a + stride;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { positions, normals, indices };
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
