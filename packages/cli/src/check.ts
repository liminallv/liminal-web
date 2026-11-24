// The one-entity-one-file convention, checked.
//
// A registry is a hand-written object literal, which is a deliberate trade: it is what keeps
// your classname union a *literal* type and what fixes manifest order. The cost is that the
// list can silently fall out of step with the directory beside it — a file written but never
// imported is an entity that does not exist, with nothing anywhere to say so.
//
// So the scan happens here, where there IS a filesystem, and it *compares* rather than
// discovers. Call it from your workspace-sync script: that is the command you run right
// after adding an entity (Blender cannot place one until the manifest is written), so the
// check lands exactly when the mistake would be made.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { RegistryView } from '@liminal-lv/core';

export interface EntityFileDir {
  /** Directory to scan. A directory that does not exist is skipped, not an error. */
  readonly path: string;
  /** File extension, with the dot. Defaults to `.ts`. */
  readonly extension?: string;
  /**
   * When true, every classname in the registry must have a file here. Use it for the
   * directory that *defines* your entities; leave it off for one that only implements some
   * of them (a sim half that not every entity needs, say).
   */
  readonly requireAll?: boolean;
  /** What a file in here is, for the error message. Defaults to `"entity"`. */
  readonly describes?: string;
}

export interface CheckEntityFilesOptions {
  readonly registry: RegistryView;
  readonly dirs: readonly EntityFileDir[];
  /**
   * Filenames to ignore, beyond the two that always are: a barrel (`index`) and anything
   * starting with `_`, which is the conventional mark for a helper that is not an entity.
   */
  readonly ignore?: readonly string[];
}

/**
 * Compare entity files against the registry, in both directions. Returns a list of
 * human-readable problems — empty when everything lines up.
 *
 * Both directions matter and they catch different mistakes. A file with no registry entry is
 * an entity someone wrote and forgot to register. A registry entry with no file is usually a
 * rename that only landed on one side.
 */
export function checkEntityFiles(options: CheckEntityFilesOptions): string[] {
  const { registry } = options;
  const ignore = new Set<string>(['index', ...(options.ignore ?? [])]);
  const problems: string[] = [];

  for (const dir of options.dirs) {
    const extension = dir.extension ?? '.ts';
    const describes = dir.describes ?? 'entity';
    const names = entityFilesIn(dir.path, extension, ignore);

    for (const name of names) {
      if (!registry.has(name)) {
        problems.push(
          `${dir.path}/${name}${extension} defines ${article(describes)} ${describes} that is not ` +
            'in the registry — add it to the registry, or prefix the file with "_" if it is a helper.',
        );
      }
    }

    if (!dir.requireAll) continue;
    const missing = registry.classnames.filter(
      (classname) => !existsSync(join(dir.path, `${classname}${extension}`)),
    );
    if (missing.length > 0) {
      problems.push(
        `${dir.path} is missing a file for: ${missing.join(', ')} ` +
          `(the registry lists them, but nothing there defines them).`,
      );
    }
  }

  return problems;
}

/** `describes` is caller-supplied prose, so the message has to agree with whatever they wrote. */
function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? 'an' : 'a';
}

function entityFilesIn(dir: string, extension: string, ignore: ReadonlySet<string>): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => entry.slice(0, -extension.length))
    .filter((name) => !name.startsWith('_') && !ignore.has(name));
}
