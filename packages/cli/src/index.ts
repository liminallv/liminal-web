// @liminal-lv/cli — the Node-side half of a Liminal integration.
//
// Everything here needs a filesystem, which is exactly why it is not in `@liminal-lv/core`:
// the core package has to stay loadable in a browser bundle and on a game server, and
// writing a Blender workspace is neither of those jobs.
//
// The usual shape of a project's sync script:
//
//   import { syncWorkspace } from '@liminal-lv/cli';
//   import { box } from '@liminal-lv/core/glb-write';
//   import { REGISTRY, MATERIALS } from './my-game/entities.ts';
//
//   syncWorkspace({
//     workspace: '_blender',
//     registry: REGISTRY,
//     materials: MATERIALS,
//     definitionsDir: '_entities',
//     models: { door: box(1, 2, 0.2) },
//   });
//
// Then point the Blender addon's project directory at `_blender` and hit Reload Manifest.

export {
  buildManifestBody,
  nextRevision,
  serializeManifest,
  type ManifestBody,
} from './manifest.ts';

export {
  buildMaterialLibrary,
  buildMaterialPreviews,
  buildModels,
  buildThumbnailAtlas,
  previewFromDefinition,
  THUMBNAIL_SIZE,
  type BuildMaterialLibraryOptions,
  type BuildMaterialPreviewsOptions,
  type BuildModelsOptions,
  type GeneratedModel,
  type MaterialPreview,
  type PreviewGeometry,
  type TextureResolver,
  type ThumbnailAtlas,
} from './assets.ts';

export {
  loadDefinitionsFromDisk,
  syncWorkspace,
  type PreviewModel,
  type SyncWorkspaceOptions,
  type SyncWorkspaceResult,
} from './workspace.ts';

export {
  adoptIncomingMaterials,
  type AdoptedMaterial,
  type AdoptMaterialsOptions,
  type AdoptMaterialsResult,
} from './adopt.ts';

export {
  checkEntityFiles,
  type CheckEntityFilesOptions,
  type EntityFileDir,
} from './check.ts';
