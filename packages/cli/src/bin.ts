#!/usr/bin/env node
// The `liminal` command.
//
// Everything it does is available as a library function; the bin exists so that a project
// which only needs the standard behaviour does not have to write a script for it. A project
// that needs more than the standard behaviour should write the script — importing
// `@liminal-lv/cli` directly is a first-class way to use this package, not a fallback.
//
// Configuration comes from a `liminal.config.ts` (or `.js`/`.mjs`) beside your
// `package.json`, default-exporting a `LiminalConfig`. It is loaded with a plain dynamic
// `import()`, so a `.ts` config needs a runtime that can execute TypeScript — Node 22.18+
// and 24 can, natively; `tsx liminal ...` always can.

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { lintWiring, parseScene, type RegistryView } from '@liminal-lv/core';

import { loadDefinitionsFromDisk, syncWorkspace } from './workspace.ts';
import { checkEntityFiles, type EntityFileDir } from './check.ts';
import type { PreviewModel } from './workspace.ts';

export interface LiminalConfig {
  readonly registry: RegistryView;
  /** The directory the Blender addon points at. Defaults to `_blender`. */
  readonly workspace?: string;
  /** Where the addon writes levels. Defaults to `<workspace>/levels`. */
  readonly levelsDir?: string;
  /** Authored entity definitions (`<classname>.lm`). Defaults to `_entities`. */
  readonly definitionsDir?: string;
  readonly materials?: Parameters<typeof syncWorkspace>[0]['materials'];
  /** Where texture locators resolve from, for material previews and gizmo textures. */
  readonly textureDir?: string;
  readonly models?: Readonly<Record<string, PreviewModel>>;
  readonly openTypes?: Parameters<typeof syncWorkspace>[0]['openTypes'];
  /** Directories checked against the registry by `liminal check`. */
  readonly entityDirs?: readonly EntityFileDir[];
}

const USAGE = `liminal — Liminal Editor workspace tools

  liminal sync             write the Blender workspace from your entity registry
  liminal verify [level]   parse every level (or one) and report what it contains
  liminal wiring [level]   print a level's signal graph
  liminal check            compare your entity files against the registry

Reads ./liminal.config.ts (or .js / .mjs), which must default-export a LiminalConfig.
Every command is also a plain function — import '@liminal-lv/cli' if you need more control.`;

async function loadConfig(): Promise<LiminalConfig> {
  for (const name of ['liminal.config.ts', 'liminal.config.js', 'liminal.config.mjs']) {
    const path = resolve(process.cwd(), name);
    if (!existsSync(path)) continue;
    const module = (await import(pathToFileURL(path).href)) as { default?: LiminalConfig };
    if (!module.default) throw new Error(`${name} has no default export`);
    return module.default;
  }
  throw new Error(
    'no liminal.config.ts found in this directory. See the README for what goes in it.',
  );
}

const workspaceOf = (config: LiminalConfig) => resolve(config.workspace ?? '_blender');
const levelsOf = (config: LiminalConfig) =>
  resolve(config.levelsDir ?? join(workspaceOf(config), 'levels'));

async function levelPaths(config: LiminalConfig, requested: string | undefined): Promise<string[]> {
  const dir = levelsOf(config);
  if (requested) {
    const path = join(dir, `${basename(requested).replace(/\.lm$/, '')}.lm`);
    if (!existsSync(path)) throw new Error(`no such level: ${path}`);
    return [path];
  }
  if (!existsSync(dir)) throw new Error(`no levels directory at ${dir}`);
  return (await readdir(dir)).filter((e) => e.endsWith('.lm')).map((e) => join(dir, e));
}

async function definitionsOf(config: LiminalConfig): Promise<Map<string, Uint8Array>> {
  const dir = resolve(config.definitionsDir ?? '_entities');
  return loadDefinitionsFromDisk(dir, config.registry, () => {});
}

async function cmdSync(config: LiminalConfig): Promise<void> {
  syncWorkspace({
    workspace: workspaceOf(config),
    registry: config.registry,
    ...(config.openTypes ? { openTypes: config.openTypes } : {}),
    ...(config.models ? { models: config.models } : {}),
    ...(config.materials ? { materials: config.materials } : {}),
    ...(config.textureDir ? { textureDir: resolve(config.textureDir) } : {}),
    definitionsDir: resolve(config.definitionsDir ?? '_entities'),
  });
}

async function cmdVerify(config: LiminalConfig, requested: string | undefined): Promise<number> {
  const definitions = await definitionsOf(config);
  let failures = 0;

  for (const path of await levelPaths(config, requested)) {
    const name = basename(path, '.lm');
    console.log(`\n=== ${name} ===`);
    try {
      const scene = parseScene(new Uint8Array(await readFile(path)), config.registry, {
        name,
        definitions,
      });
      const byClassname: Record<string, number> = {};
      for (const entity of scene.entities) {
        byClassname[entity.classname] = (byClassname[entity.classname] ?? 0) + 1;
      }
      console.log(
        JSON.stringify(
          {
            entities: scene.entities.length,
            geometry: scene.geometry.length,
            byClassname,
          },
          null,
          2,
        ),
      );
      for (const warning of scene.warnings) console.warn(`WARN  ${warning}`);
      for (const problem of lintWiring(scene.entities, config.registry)) {
        console.warn(`${problem.severity === 'error' ? 'FAIL' : 'WARN'}  ${problem.message}`);
        if (problem.severity === 'error') failures++;
      }
      if (failures === 0) console.log('OK');
    } catch (error) {
      failures++;
      console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

async function cmdWiring(config: LiminalConfig, requested: string | undefined): Promise<void> {
  const definitions = await definitionsOf(config);
  for (const path of await levelPaths(config, requested)) {
    const name = basename(path, '.lm');
    const scene = parseScene(new Uint8Array(await readFile(path)), config.registry, {
      name,
      definitions,
    });
    console.log(`\n=== ${name} ===`);
    const wires = scene.entities.flatMap((entity) =>
      (config.registry.find(entity.classname)?.props ?? [])
        .filter((prop) => prop.type === 'source' || prop.type === 'destination')
        .map((prop) => ({ entity, prop }))
        .filter(({ prop }) => String(entity.properties[prop.name] ?? '').trim() !== ''),
    );
    for (const { entity, prop } of wires) {
      const arrow = prop.type === 'destination' ? '→' : '←';
      console.log(`  ${entity.id}.${prop.name} ${arrow} ${String(entity.properties[prop.name])}`);
    }
    if (wires.length === 0) console.log('  (nothing wired)');
  }
}

function cmdCheck(config: LiminalConfig): number {
  const dirs = config.entityDirs ?? [];
  if (dirs.length === 0) {
    console.log('no entityDirs configured — nothing to check.');
    return 0;
  }
  const problems = checkEntityFiles({ registry: config.registry, dirs });
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  if (problems.length === 0) console.log('OK: entity files and the registry agree.');
  return problems.length;
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const config = await loadConfig();
  switch (command) {
    case 'sync':
      await cmdSync(config);
      return;
    case 'verify': {
      const failures = await cmdVerify(config, argument);
      if (failures > 0) process.exitCode = 1;
      return;
    }
    case 'wiring':
      await cmdWiring(config, argument);
      return;
    case 'check':
      if (cmdCheck(config) > 0) process.exitCode = 1;
      return;
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
