// Writes the Blender workspace the demo fixtures are authored against, from
// test/fixtures/demo-entities.json, through the same sync a game project runs. Called by
// gen-demo-fixtures.py; not meant to be run by hand.
//
//   node scripts/sync-demo-workspace.ts <workspace> [definitionsDir]

import { readFileSync } from 'node:fs';

import { createRegistry, type EntityDescriptor, type LiminalManifest } from '../src/index.ts';
import { syncWorkspace } from '../../cli/src/index.ts';

const [workspace, definitionsDir] = process.argv.slice(2);
if (!workspace) throw new Error('usage: sync-demo-workspace.ts <workspace> [definitionsDir]');

const manifest = JSON.parse(
  readFileSync(new URL('../test/fixtures/demo-entities.json', import.meta.url), 'utf8'),
) as LiminalManifest;

const registry = createRegistry(
  Object.fromEntries(
    manifest.entities.map((entity) => [
      entity.classname,
      {
        ...entity,
        types: entity === manifest.entities[0] ? manifest.types : undefined,
      } satisfies EntityDescriptor,
    ]),
  ) as Record<string, EntityDescriptor>,
  { geoTags: manifest.geo_tags },
);

syncWorkspace({
  workspace,
  registry,
  ...(definitionsDir ? { definitionsDir } : {}),
});
