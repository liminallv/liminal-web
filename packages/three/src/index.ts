// @liminal-lv/three — level geometry → Three.js objects.
//
// Optional, and `three` is a **peer** dependency: this package never bundles a copy, so it
// cannot be the reason your app ends up with two Three instances (the classic cause of
// `instanceof` checks failing and materials refusing to apply).
//
// It is deliberately small. Building a `BufferGeometry` from a `LiminalMesh` and resolving
// a material name against your own registry are the two things every Three integration
// writes identically and gets subtly wrong the first time — normals dropped, a world matrix
// applied twice, materials shared between instances that then tint each other. Scene graph,
// lighting, culling and instancing are your app's decisions, and are not here.
//
// ## Coordinates
//
// A `.lm` is Y-up glTF, which is Three's own convention, so nothing needs converting. A
// world matrix goes straight into `Object3D.applyMatrix4`.

import {
  findMaterial,
  type GeometryNode,
  type LiminalMesh,
  type Mat4,
  type MaterialDescriptor,
  type MaterialTextureSet,
  type PrimitiveMaterial,
} from '@liminal-lv/core';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  type Material,
  type Texture,
} from 'three';

/**
 * A `LiminalMesh` as a `BufferGeometry`, in its own local frame.
 *
 * Normals are computed when the export did not carry them, rather than left absent: an
 * unlit surface in a lit scene reads as a bug in the level, and the designer has no way to
 * tell it apart from one.
 */
export function toBufferGeometry(mesh: LiminalMesh): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(mesh.positions), 3));
  if (mesh.uvs) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(mesh.uvs), 2));
  if (mesh.indices) geometry.setIndex([...mesh.indices]);

  if (mesh.normals && mesh.normals.length === mesh.positions.length) {
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(mesh.normals), 3));
  } else {
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingSphere();
  return geometry;
}

/** Apply a column-major `Mat4` from a `.lm` to an object. Three shares glTF's layout. */
export function applyWorldMatrix(object: { applyMatrix4(m: Matrix4): unknown }, world: Mat4): void {
  object.applyMatrix4(new Matrix4().fromArray([...world]));
}

/** The map slots `loadTexture` is asked for, named as on `MaterialTextureSet`. */
export type TextureSlot = keyof MaterialTextureSet;

export interface MaterialOptions {
  /**
   * Your own material library, by id. A mesh the designer assigned a library material to
   * carries that material's NAME on its exported primitive, and this is what resolves it.
   */
  readonly library?: readonly MaterialDescriptor[];
  /**
   * Turn a library material's texture LOCATOR into a Three texture — typically a
   * `TextureLoader().load(url)` over a URL your bundler produced for that locator.
   *
   * Omit it and a textured material draws as its factors alone, which for a texture-driven
   * material means flat white: glTF stores `[1,1,1,1]` as the multiplier over a base-colour
   * map, so the colour is genuinely not in the file.
   *
   * Return null for a locator you have no asset for. The loader is called once per distinct
   * locator per material, so a shared ORM image is fetched once and assigned to both slots.
   *
   * **Colour space and flip are set for you** afterwards — do not set them here, or the two
   * will fight. See `applyTextures`.
   */
  readonly loadTexture?: (locator: string, slot: TextureSlot) => Texture | null;
  /** Applied to every material this builds — a hook for `side`, `flatShading`, envMaps. */
  readonly configure?: (material: MeshStandardMaterial, source: PrimitiveMaterial | null) => void;
  /** Used when a primitive references no material at all. Defaults to mid grey. */
  readonly fallbackColor?: number;
}

/**
 * Hang a library material's texture maps on a Three material.
 *
 * Three needs three things right that glTF states implicitly, and each one is silent when
 * wrong rather than throwing:
 *
 * - **Colour space.** Base colour and emissive hold *colours* and are sRGB-encoded; normal,
 *   metallic-roughness and occlusion hold *numbers* and must stay linear. Decoding a normal map
 *   as sRGB bends every normal toward the surface and reads as bad lighting, not as a bug here.
 * - **`flipY`.** glTF's UV origin is the top-left, Three's texture default is the bottom-left.
 *   Every glTF texture is `flipY = false`; leaving the default upends the map.
 * - **Which UV set.** `texCoord` picks `TEXCOORD_n`, and Three expresses that per texture as
 *   `channel`. Occlusion on a second UV set is the common case that needs it.
 *
 * Exported so a caller building materials by hand gets the same treatment.
 */
export function applyTextures(
  material: MeshStandardMaterial,
  textures: MaterialTextureSet,
  loadTexture: (locator: string, slot: TextureSlot) => Texture | null,
): void {
  // One load per distinct locator: the standard ORM packing names one image from both the
  // occlusion and the metallic-roughness slot, and loading it twice would decode it twice and
  // leave two GPU uploads of identical pixels.
  const cache = new Map<string, Texture | null>();
  const get = (locator: string | undefined, slot: TextureSlot, srgb: boolean): Texture | null => {
    if (!locator) return null;
    let texture = cache.get(locator);
    if (texture === undefined) {
      texture = loadTexture(locator, slot);
      cache.set(locator, texture);
    }
    if (!texture) return null;
    texture.flipY = false;
    texture.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace;
    return texture;
  };

  const baseColor = get(textures.baseColor, 'baseColor', true);
  if (baseColor) material.map = baseColor;

  // One image, two maps — glTF packs roughness in green and metalness in blue, and Three reads
  // exactly those channels from whatever texture each slot points at.
  const metallicRoughness = get(textures.metallicRoughness, 'metallicRoughness', false);
  if (metallicRoughness) {
    material.metalnessMap = metallicRoughness;
    material.roughnessMap = metallicRoughness;
  }

  const normal = get(textures.normal, 'normal', false);
  if (normal) material.normalMap = normal;

  const occlusion = get(textures.occlusion, 'occlusion', false);
  if (occlusion) material.aoMap = occlusion;

  const emissive = get(textures.emissive, 'emissive', true);
  if (emissive) {
    material.emissiveMap = emissive;
    // Three multiplies `emissiveMap` by `emissive`, which starts BLACK — an emissive map on a
    // default material contributes nothing at all. Only lift it when the descriptor did not
    // ask for a specific emissive tint.
    if (material.emissive.r === 0 && material.emissive.g === 0 && material.emissive.b === 0) {
      material.emissive = new Color(1, 1, 1);
    }
  }
}

/**
 * Build a `MeshStandardMaterial` for one primitive.
 *
 * Resolution order: your library by name, then the PBR factors embedded in the `.lm`, then
 * the fallback colour. The middle step is the one worth having — it means a material a
 * designer added in Blender but that your game has never heard of still draws in its
 * authored colour, instead of turning into flat grey and looking like a broken asset.
 *
 * **A fresh material every call, deliberately.** Sharing one between placed instances means
 * tinting this landing pad's strobe also tints the pad next to it, which is a bug that only
 * shows up once there are two of something. Cache per level if the draw-call count matters
 * more than per-instance tinting.
 */
export function toMaterial(
  source: PrimitiveMaterial | null,
  options: MaterialOptions = {},
): MeshStandardMaterial {
  // `findMaterial`, not a plain id lookup: an adopted material reaches the renderer under its
  // RAW Blender name until the designer reloads Blender, and resolving only by id would render
  // it as bare factors — which for a texture-driven material is a white emissive blowout.
  const known = options.library ? findMaterial(options.library, source?.name) : undefined;

  const material = new MeshStandardMaterial();
  if (known) {
    material.color = new Color(known.color[0], known.color[1], known.color[2]);
    material.metalness = known.metallic;
    material.roughness = known.roughness;
    if (known.emissive) {
      material.emissive = new Color(known.emissive[0], known.emissive[1], known.emissive[2]);
    }
    // Textures come from the LIBRARY only. A `.lm` names its materials but does not carry their
    // pixels — the images live in your own asset tree — so an unrecognised
    // material falls through to the factors below, which is exactly the flat-but-truthful
    // fallback that path already promises.
    if (known.textures && options.loadTexture) {
      applyTextures(material, known.textures, options.loadTexture);
    }
  } else if (source) {
    material.color = new Color(source.color[0], source.color[1], source.color[2]);
    material.metalness = source.metallic;
    material.roughness = source.roughness;
    if (source.emissive) {
      material.emissive = new Color(source.emissive[0], source.emissive[1], source.emissive[2]);
    }
    if (source.color[3] < 1) {
      material.transparent = true;
      material.opacity = source.color[3];
    }
  } else {
    material.color = new Color(options.fallbackColor ?? 0x888888);
  }

  options.configure?.(material, source ?? null);
  return material;
}

export interface MeshOptions extends MaterialOptions {
  /**
   * Use this material instead of building one. Handy for a debug pass that wants every
   * collider drawn in wireframe regardless of what the designer assigned.
   */
  readonly material?: Material;
  /**
   * Leave the geometry in its local frame and put the placement on the object's transform
   * (the default). Set `false` to bake the world matrix into the vertices instead, which is
   * what you want if you are about to merge many meshes into one draw call.
   */
  readonly useObjectTransform?: boolean;
}

/**
 * One `GeometryNode` as a placed `Mesh`.
 *
 * `NONE` geometry is decoration — it never collides, but it very much still draws, and it
 * is usually most of what a level looks like. This function does not filter on collision
 * kind for exactly that reason.
 */
export function toMesh(node: GeometryNode, options: MeshOptions = {}): Mesh {
  const geometry = toBufferGeometry(node.mesh);
  const material = options.material ?? toMaterial(node.mesh.material, options);
  const mesh = new Mesh(geometry, material);
  mesh.name = node.id;

  if (options.useObjectTransform === false) {
    geometry.applyMatrix4(new Matrix4().fromArray([...node.world]));
    geometry.computeBoundingSphere();
  } else {
    applyWorldMatrix(mesh, node.world);
  }
  return mesh;
}

/**
 * A double-sided variant of `configure`, for level geometry authored as open surfaces.
 *
 * A brush shaped in Blender's edit mode is frequently not a closed solid, and back-face
 * culling then makes half of it vanish depending on where the camera is — which reads as
 * missing geometry rather than as a normals problem.
 */
export function doubleSided(material: MeshStandardMaterial): void {
  material.side = DoubleSide;
}
export * from './level.ts';
