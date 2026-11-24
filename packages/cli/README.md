# @liminal-lv/cli

Write the Blender workspace [Liminal Editor](https://liminal.lv) reads: `entities.json`,
entity preview models, and your material library.

```bash
npm install --save-dev @liminal-lv/cli
```

```ts
import { syncWorkspace } from '@liminal-lv/cli';
import { REGISTRY, MATERIALS } from './src/entities.ts';

syncWorkspace({
  workspace: '_blender',
  registry: REGISTRY,
  materials: MATERIALS,
  definitionsDir: '_entities',
});
```

Or, with a `liminal.config.ts` beside your `package.json`:

```
npx liminal sync      write the workspace
npx liminal verify    parse every level and report what it contains
npx liminal wiring    print a level's signal graph
npx liminal check     compare your entity files against the registry
```

Also exports `loadDefinitionsFromDisk`, `checkEntityFiles`, and the manifest primitives
(`buildManifestBody`, `nextRevision`, `serializeManifest`) if you need to drive it yourself.

Full documentation is in the
[repository README](https://github.com/liminal-editor/liminal-web#readme). MIT.
