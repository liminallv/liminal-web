# Liminal Web SDK

JavaScript and TypeScript integration for [Liminal Editor](https://liminal.lv), the Blender addon
that turns Blender into a level editor for your game.

It uses the same workspace contract as the Godot integration: your game describes its entities,
`liminal sync` publishes them to Blender as `entities.json`, the designer builds and exports a
`.lm` level, and your game reads it back with typed properties, placed geometry and the full
Blender hierarchy. The SDK is engine-agnostic; rendering and physics come from your engine, with
optional adapters for Three.js and for 2D and 3D collision.

> **Documentation:** the complete guide is the **Web SDK** section of the Liminal docs,
> [liminal.lv/docs/web/overview.html](https://liminal.lv/docs/web/overview.html)
> (source in this repository: [`docs/liminal_editor/web/`](../../docs/liminal_editor/web/overview.md)).
> It covers defining entities, reading levels, entity runtimes and signals, Three.js, collision
> and the CLI.

## Packages

| Package | What it is | Dependencies |
|---|---|---|
| `@liminal-lv/core` | Contract types, the `.lm` reader, the entity registry, entity runtimes, the wiring model. Runs in browsers, Node and game servers. | none |
| `@liminal-lv/core/glb-write` | A minimal glTF writer, for procedural preview models or generated levels. | none |
| `@liminal-lv/cli` | Writes the Blender workspace and provides the `liminal` command. | Node |
| `@liminal-lv/three` | Builds a Three.js scene graph, meshes and materials from a level. | `three` (peer) |
| `@liminal-lv/collision-2d` | Level geometry to 2D colliders. | none |
| `@liminal-lv/collision-3d` | Level geometry to 3D colliders. | none |

## Install

```bash
npm install @liminal-lv/core @liminal-lv/three three
npm install --save-dev @liminal-lv/cli
```

The `liminal` command loads a `liminal.config.ts`, which needs Node 22.18 or newer.

## Example

Define an entity and its runtime in `src/entities/light.ts`:

```ts
import { defineEntity, entityRuntime } from '@liminal-lv/core';
import { PointLight } from 'three';

export const env_light = defineEntity({
  classname: 'env_light',
  metadata: { gizmos: [{ type: 'sphere', bindings: { radius: 'range' } }] },
  props: [
    { name: 'tint', type: 'Color', default_value: [1, 1, 1, 1] },
    { name: 'range', type: 'float', default_value: 6 },
  ],
});

export const light = entityRuntime(env_light, {
  spawn: (placed) => {
    const [r, g, b] = placed.properties.tint;
    const result = new PointLight(0xffffff, 10, placed.properties.range);
    result.color.setRGB(r, g, b);
    return result;
  },
});
```

Collect the definitions in a registry in `src/entities/index.ts`:

```ts
import { createRegistry } from '@liminal-lv/core';

import { env_light, light } from './light.ts';

export const REGISTRY = createRegistry([env_light]);
export const RUNTIMES = [light] as const;
```

Point `liminal.config.ts` at it and write the workspace:

```ts
import { REGISTRY } from './src/entities/index.ts';

export default { registry: REGISTRY, workspace: '_blender' };
```

```bash
npx liminal sync
```

Set the addon's Workspace Folder to `_blender`, place an `env_light` in Blender and export the
level. Then load it:

```ts
import { parseScene, spawnLevel } from '@liminal-lv/core';
import { toObject3D } from '@liminal-lv/three';
import { Scene } from 'three';

import { REGISTRY, RUNTIMES } from './entities/index.ts';

const bytes = await fetch('/levels/hello.lm').then((response) => response.arrayBuffer());
const level = parseScene(bytes, REGISTRY, { name: 'hello' });
for (const warning of level.warnings) console.warn(warning);

const scene = new Scene();
scene.add(toObject3D(level, { spawned: spawnLevel(level, RUNTIMES) }));
```

`examples/alien-invasion/` is a complete top-down shooter built on these packages. Start it with
`pnpm dev` from that directory after `pnpm build` here.

## Development

```bash
pnpm install
pnpm build       # tsc -b across all packages
pnpm watch       # …in watch mode, for consuming projects linked with `link:`
pnpm test        # node --test over the source, no build needed
pnpm check       # typecheck (including the test suites) + test
```

Tests build their own `.lm` fixtures with the package's own writer, so reader and writer are
checked against each other on every run. Two real Blender exports sit in
`packages/core/test/fixtures/` so that "we agree with ourselves" is never the only thing
being tested. They are authored and exported by the addon itself, driven through the e2e
harness; regenerate them after a contract change with
`python scripts/gen-demo-fixtures.py` from `packages/core`.

The wire format is defined by the Blender addon under `blender/liminal_editor/`, and
`packages/core/src/contract.ts` transcribes it. Change those shapes only when the addon changes.

## Licence

MIT.
