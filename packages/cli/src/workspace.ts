// Write the Blender workspace.
//
// The layout is fixed by the addon (`library.py`, `export.py`, `materials.py`), and the
// designer points its "project directory" setting at `<workspace>`:
//
//   <workspace>/.lmworkspace               empty marker; the addon refuses a folder without it
//   <workspace>/entities.json              entity definitions, choice types, geometry tags
//   <workspace>/models/<classname>.glb     preview meshes referenced by `metadata.model`
//   <workspace>/gizmo_textures/<key>.png   every image a gizmo `texture` names
//   <workspace>/materials/materials.json   the material index — the only file the addon reads
//   <workspace>/materials/previews/<id>.*  one palette image per material
//   <workspace>/materials/previews/_thumbs.png  every thumbnail in one sheet
//   <workspace>/materials/incoming_*.glb   ← the addon writes these; adopted here, see adopt.ts
//   <workspace>/levels/<name>.lm           ← the addon writes these; your game reads them
//
// `levels/` is created but never written to: it belongs to the designer.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  gizmoTextureKey,
  type LiminalChoiceSet,
  type MaterialDescriptor,
  type RegistryView,
} from '@liminal-lv/core';

import { adoptIncomingMaterials, type AdoptedMaterial } from './adopt.ts';
import {
  buildMaterialPreviews,
  buildModels,
  buildThumbnailAtlas,
  previewFromDefinition,
  type MaterialPreview,
  type PreviewGeometry,
  type TextureResolver,
} from './assets.ts';
import { buildManifestBody, nextRevision, serializeManifest } from './manifest.ts';

export type PreviewModel = PreviewGeometry | string;

export interface SyncWorkspaceOptions {
  /** The directory the Blender addon is pointed at. Created if it does not exist. */
  readonly workspace: string;
  readonly registry: RegistryView;
  /**
   * Members of the registry's OPEN choice sets, enumerated from disk by you. This is where
   * a `$Game.MusicTrack` set becomes a real dropdown of the tracks that actually exist,
   * rather than a string a designer has to remember and spell.
   */
  readonly openTypes?: Readonly<Record<string, LiminalChoiceSet>>;
  /** Preview model per classname: a path to a `.glb` your game already ships, or procedural geometry. */
  readonly models?: Readonly<Record<string, PreviewModel>>;
  /**
   * Directory of authored entity definitions (`<classname>.lm`). Each one becomes that
   * entity's preview model, so the designer places the real thing rather than a box.
   */
  readonly definitionsDir?: string;
  /** Your material library. Omit to skip writing `materials/`. */
  readonly materials?: readonly MaterialDescriptor[];
  /**
   * The directory your texture locators are relative to — where textures adopted out of
   * Blender are written, where a material's base-colour map is read from to become its
   * Blender preview, and where a gizmo's `texture` is read from to be published.
   *
   * Omit it and textures are skipped in both directions: every material previews as a flat tile
   * of its colour and an adopted material arrives without its maps. Point it somewhere your
   * renderer can also load from (a directory your bundler serves), because the SAME locator
   * string is what the browser resolves at runtime.
   */
  readonly textureDir?: string;
  /** Where progress goes. Defaults to `console.log`, prefixed. Pass `() => {}` to silence. */
  readonly log?: (message: string) => void;
}

export interface SyncWorkspaceResult {
  readonly workspace: string;
  /** The manifest revision now on disk. */
  readonly revision: number;
  /** False when the manifest was byte-for-byte unchanged and deliberately not rewritten. */
  readonly manifestWritten: boolean;
  readonly models: readonly string[];
  readonly removedModels: readonly string[];
  readonly materialsWritten: boolean;
  /** Keys of the gizmo textures now under `gizmo_textures/`. */
  readonly gizmoTextures: readonly string[];
  /**
   * Materials adopted from an `incoming_*.glb` this run that are still missing from
   * `options.materials` — i.e. not yet copied into your own material list. Print these
   * somewhere a developer will see them; until they land in source, the same materials keep
   * reappearing here on every future sync rather than vanishing.
   */
  readonly pendingMaterials: readonly AdoptedMaterial[];
}

export function syncWorkspace(options: SyncWorkspaceOptions): SyncWorkspaceResult {
  const { workspace, registry } = options;
  const log = options.log ?? ((message: string) => console.log(`[liminal] ${message}`));

  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, 'levels'), { recursive: true });
  const marker = join(workspace, WORKSPACE_MARKER);
  if (!existsSync(marker)) writeFileSync(marker, '');

  const models = syncModels(workspace, registry, options, log);
  const modelled = new Set(models.models.map((filename) => filename.slice(0, -'.glb'.length)));
  const manifest = syncManifest(workspace, registry, options.openTypes ?? {}, modelled, log);
  const gizmoTextures = syncGizmoTextures(workspace, registry, options.textureDir, log);
  const { materials, pendingMaterials } = syncAdoptedMaterials(workspace, options, log);
  const materialsWritten = syncMaterials(workspace, materials, options.textureDir, log);

  log(`workspace ready: ${workspace}`);
  return { workspace, ...manifest, ...models, gizmoTextures, materialsWritten, pendingMaterials };
}

/**
 * The file the addon's Workspace Folder setting checks for before it will reload or export,
 * so a designer cannot point it at a project root by mistake. Written once and never touched
 * again, exactly as the Godot plugin does; its contents are nothing.
 */
const WORKSPACE_MARKER = '.lmworkspace';

const GIZMO_TEXTURE_DIR = 'gizmo_textures';

/**
 * Publish every image a gizmo `texture` names, as `gizmo_textures/<key>.png`, and drop PNGs
 * no gizmo references any more. The addon reads these straight off disk by key, so a locator
 * has to be a PNG already: unlike Godot, which decodes any Texture2D, there is no image
 * pipeline here to convert one.
 */
function syncGizmoTextures(
  workspace: string,
  registry: RegistryView,
  textureDir: string | undefined,
  log: (message: string) => void,
): string[] {
  const locators = new Map<string, string>();
  for (const entity of registry.list) {
    for (const gizmo of entity.metadata?.gizmos ?? []) {
      if (gizmo.texture) locators.set(gizmo.texture, gizmoTextureKey(gizmo.texture));
    }
  }
  if (locators.size === 0) return [];

  if (!textureDir) {
    log(
      `${locators.size} gizmo texture(s) are referenced but no textureDir is set — ` +
        'the addon will draw those gizmos untextured.',
    );
    return [];
  }

  const dir = join(workspace, GIZMO_TEXTURE_DIR);
  mkdirSync(dir, { recursive: true });
  const resolve = fileTextureResolver(textureDir);
  const written: string[] = [];
  for (const [locator, key] of locators) {
    const image = resolve(locator);
    if (!image) {
      log(`gizmo texture "${locator}" not found under ${textureDir} — skipped.`);
      continue;
    }
    if (image.mimeType !== 'image/png') {
      log(`gizmo texture "${locator}" is not a PNG — the addon only reads PNG; skipped.`);
      continue;
    }
    writeIfChanged(join(dir, `${key}.png`), image.bytes);
    written.push(key);
  }

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.png') || written.includes(entry.slice(0, -4))) continue;
    rmSync(join(dir, entry));
    log(`removed stale gizmo texture ${entry}`);
  }

  log(`${GIZMO_TEXTURE_DIR}/ → ${written.length} texture(s).`);
  return written;
}

/**
 * Fold any pending `incoming_*.glb` packs in on top of `options.materials`, so this run's index
 * publishes both your own library and anything still awaiting adoption — see `adopt.ts` for why
 * an unpersisted pack has to keep riding along rather than being published once and forgotten.
 */
function syncAdoptedMaterials(
  workspace: string,
  options: SyncWorkspaceOptions,
  log: (message: string) => void,
): { materials: MaterialDescriptor[]; pendingMaterials: AdoptedMaterial[] } {
  const base = options.materials ?? [];
  const known = new Set(base.map((material) => material.id));
  const { adopted, cleanedPacks, textures } = adoptIncomingMaterials(workspace, known, {
    ...(options.textureDir ? { textureDir: options.textureDir } : {}),
    log,
  });
  if (cleanedPacks.length > 0) {
    log(`materials/ → ${cleanedPacks.length} pack(s) fully adopted and removed: ${cleanedPacks.join(', ')}.`);
  }
  if (textures.length > 0) {
    log(`materials/ → ${textures.length} texture file(s) extracted to ${options.textureDir}.`);
  }

  const materials = [...base];
  const pendingMaterials: AdoptedMaterial[] = [];
  for (const material of adopted) {
    if (known.has(material.descriptor.id)) continue; // your own list already wins
    known.add(material.descriptor.id);
    materials.push(material.descriptor);
    pendingMaterials.push(material);
  }

  return { materials, pendingMaterials };
}

function syncManifest(
  workspace: string,
  registry: RegistryView,
  openTypes: Readonly<Record<string, LiminalChoiceSet>>,
  modelled: ReadonlySet<string>,
  log: (message: string) => void,
): { revision: number; manifestWritten: boolean } {
  const path = join(workspace, 'entities.json');
  const body = buildManifestBody(registry, openTypes, modelled);
  for (const entity of body.entities) {
    const model = entity.metadata?.model;
    if (model && !modelled.has(model)) {
      log(`${entity.classname}: metadata.model '${model}' has no preview model; Blender will show none.`);
    }
  }

  let previous: unknown = null;
  if (existsSync(path)) {
    try {
      previous = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      log('existing entities.json is unreadable — rewriting from scratch.');
    }
  }

  const revision = nextRevision(previous, body);
  if (revision === null) {
    const current =
      previous && typeof previous === 'object'
        ? Number((previous as Record<string, unknown>)['revision']) || 0
        : 0;
    log(`entities.json unchanged — skipped (${body.entities.length} entities).`);
    return { revision: current, manifestWritten: false };
  }

  writeFileSync(path, serializeManifest(body, revision), 'utf8');
  log(
    `entities.json → revision ${revision} (${body.entities.length} entities, ` +
      `${Object.keys(body.types).length} choice set(s)).`,
  );
  return { revision, manifestWritten: true };
}

function syncModels(
  workspace: string,
  registry: RegistryView,
  options: SyncWorkspaceOptions,
  log: (message: string) => void,
): { models: string[]; removedModels: string[] } {
  const dir = join(workspace, 'models');
  mkdirSync(dir, { recursive: true });

  const authored = options.definitionsDir
    ? loadPreviews(options.definitionsDir, registry, log)
    : new Map<string, PreviewGeometry>();

  const procedural: Record<string, PreviewGeometry> = {};
  const files = new Map<string, string>();
  for (const [classname, model] of Object.entries(options.models ?? {})) {
    if (typeof model === 'string') files.set(classname, model);
    else procedural[classname] = model;
  }

  const built = buildModels({ procedural, authored });
  for (const [classname, file] of files) {
    if (authored.has(classname)) continue;
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 4).toString('latin1') !== 'glTF') {
      throw new Error(`models.${classname}: ${file} is not a binary glTF (.glb)`);
    }
    built.push({ classname, filename: `${classname}.glb`, bytes, authored: false });
  }
  built.sort((a, b) => a.classname.localeCompare(b.classname));
  const expected = new Set(built.map((model) => model.filename));
  for (const model of built) writeFileSync(join(dir, model.filename), model.bytes);

  // The addon drops model collections that leave the manifest, so a stale `.glb` left on
  // disk is only ever confusing. Clear them out.
  const removed: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.glb') && !expected.has(entry)) {
      rmSync(join(dir, entry));
      removed.push(entry);
      log(`removed stale model ${entry}`);
    }
  }

  const authoredCount = built.filter((model) => model.authored).length;
  log(`models/ → ${built.length} preview model(s), ${authoredCount} from authored .lm.`);
  return { models: built.map((model) => model.filename), removedModels: removed };
}

const PREVIEW_DIR = 'previews';
const INDEX_FILE = 'materials.json';
const THUMBS_FILE = '_thumbs.png';
const INDEX_VERSION = 3;

/**
 * Publish the material library: one preview image per material, a thumbnail sheet, and the
 * `materials.json` index the addon reconciles its `.blend` against.
 *
 * That reconciliation is destructive — anything Liminal-owned and absent from the index is
 * REMOVED from the designer's file — which is why an empty material list skips `materials/`
 * altogether rather than writing an index that says "there are none".
 *
 * Previews are only written when their bytes actually changed. The addon skips a material whose
 * preview mtime matches what it stamped last time, so rewriting an identical file is not merely
 * wasted I/O: it forces a full rebuild and a full thumbnail pass on every reload in Blender.
 */
function syncMaterials(
  workspace: string,
  materials: readonly MaterialDescriptor[] | undefined,
  textureDir: string | undefined,
  log: (message: string) => void,
): boolean {
  if (!materials || materials.length === 0) return false;
  const dir = join(workspace, 'materials');
  const previewsDir = join(dir, PREVIEW_DIR);
  mkdirSync(previewsDir, { recursive: true });

  const previews = buildMaterialPreviews(materials, {
    ...(textureDir ? { resolveTexture: fileTextureResolver(textureDir) } : {}),
    log,
  });

  const expected = new Set<string>();
  let rewritten = 0;
  for (const preview of previews) {
    expected.add(preview.filename);
    if (writeIfChanged(join(previewsDir, preview.filename), preview.bytes)) rewritten++;
  }

  const atlas = buildThumbnailAtlas(previews);
  if (atlas) {
    expected.add(THUMBS_FILE);
    writeIfChanged(join(previewsDir, THUMBS_FILE), atlas.bytes);
  }

  for (const entry of readdirSync(previewsDir)) {
    if (expected.has(entry)) continue;
    rmSync(join(previewsDir, entry), { recursive: true, force: true });
    log(`removed stale preview ${entry}`);
  }

  const index = {
    version: INDEX_VERSION,
    ...(atlas
      ? { thumbs: { file: `${PREVIEW_DIR}/${THUMBS_FILE}`, size: atlas.size, columns: atlas.columns } }
      : {}),
    materials: previews.map((preview, i) => materialEntry(preview, i, atlas !== null)),
  };
  writeIfChanged(join(dir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);

  // Workspaces synced before the loose-preview switch still carry the old monolithic bake, and
  // nothing reads it any more.
  const stale = join(dir, 'mat.glb');
  if (existsSync(stale)) {
    rmSync(stale);
    log('removed materials/mat.glb — the addon reads materials.json now.');
  }

  const textured = previews.filter((preview) => preview.textured).length;
  log(
    `materials/ → ${previews.length} material(s), ${textured} from a base-colour texture, ` +
      `${rewritten} preview(s) rewritten.`,
  );
  return true;
}

function materialEntry(
  preview: MaterialPreview,
  index: number,
  withThumb: boolean,
): Record<string, unknown> {
  return {
    name: preview.name,
    file: `${PREVIEW_DIR}/${preview.filename}`,
    ...(preview.source ? { source: preview.source } : {}),
    roughness: preview.roughness,
    metallic: preview.metallic,
    ...(withThumb ? { thumb: index } : {}),
  };
}

/** Write only when the content differs, and report whether it did. Returns true when written. */
function writeIfChanged(path: string, content: Uint8Array | string): boolean {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  if (existsSync(path) && readFileSync(path).equals(bytes)) return false;
  writeFileSync(path, bytes);
  return true;
}

/** Mime type per texture file extension. The two glTF requires, plus what Blender may emit. */
const MIME_FOR_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
};

/**
 * Read a texture locator as a file under `root`.
 *
 * A locator is a POSIX-separated path relative to `root` — the same string an adopted material
 * came back with, and the same one a browser appends to a base URL. A missing file returns null
 * rather than throwing, so one un-copied texture costs that material its map instead of failing
 * the whole sync.
 */
function fileTextureResolver(root: string): TextureResolver {
  return (locator) => {
    const path = join(root, ...locator.split('/'));
    if (!existsSync(path)) return null;
    const dot = locator.lastIndexOf('.');
    const extension = dot >= 0 ? locator.slice(dot).toLowerCase() : '';
    return {
      name: locator,
      mimeType: MIME_FOR_EXTENSION[extension] ?? 'application/octet-stream',
      bytes: new Uint8Array(readFileSync(path)),
    };
  };
}

// ── Reading authored definitions off disk ────────────────────────────────────

/**
 * Every authored definition in a directory, by classname — `<classname>.lm`.
 *
 * A missing directory is not an error: it is what a project looks like before anyone has
 * authored an entity, and entities simply resolve as bare placements.
 *
 * Read this on **every** host that loads levels, and read the same bytes: a definition
 * produces colliders, so a host that skipped one is running different physics.
 */
export function loadDefinitionsFromDisk(
  dir: string,
  registry?: RegistryView,
  log: (message: string) => void = (message) => console.warn(`[liminal] ${message}`),
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  // Sorted, so the map's iteration order is the same on every machine.
  for (const file of files.sort()) {
    if (!file.endsWith('.lm')) continue;
    const classname = file.slice(0, -3);
    if (registry && !registry.has(classname)) {
      // A file named after nothing in the registry would be silently ignored by the
      // importer — almost always a rename that never reached the registry.
      log(`${file} matches no entity classname — ignored.`);
      continue;
    }
    out.set(classname, new Uint8Array(readFileSync(join(dir, file))));
  }
  return out;
}

function loadPreviews(
  dir: string,
  registry: RegistryView,
  log: (message: string) => void,
): Map<string, PreviewGeometry> {
  const out = new Map<string, PreviewGeometry>();
  for (const [classname, bytes] of loadDefinitionsFromDisk(dir, registry, log)) {
    try {
      const preview = previewFromDefinition(bytes);
      if (preview) out.set(classname, preview);
    } catch (error) {
      log(`could not read ${classname}.lm: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}
