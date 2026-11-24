// Entity wiring — the signal graph a designer draws in Blender.
//
// The model is deliberately NOT a direct-reference graph:
//
//   • a `source` prop holds an entity's own connection NAME;
//   • a `destination` prop holds the name it signals;
//   • dispatch is string equality on that name, one-to-many.
//
// Names rather than ids is what makes the Blender side work at all. A designer types a name
// into a `destination` field (or picks one from the popup, or draws it in the node graph)
// and the viewport draws an arrow — ids do not exist until import.
//
// **Wiring is discovered by prop TYPE, never by prop NAME.** `target`/`targetname` are a
// convention inherited from Quake-lineage editors, not a contract: the reference integration
// already ships an entity with two differently-named `destination` props, and every piece of
// Blender tooling (the wire operator, the lint pass, the arrow overlay, the node graph)
// discovers by type. Keying off names here would quietly diverge from all of it.

import type { EntityLookup } from './registry.ts';
import type { PlacedEntity, PropValue } from './scene.ts';

/**
 * Signal ids from the reference integration.
 *
 * These are the two the shipped Godot addon defines; a game is free to use any numeric id.
 * Note that the reference `trigger_volume` sends **ACTIVATE on both edges** and distinguishes
 * them by a field in the payload — it never sends DEACTIVATE. Receivers should key off the
 * payload rather than assume the id tells them everything.
 */
export const LIMINAL_SIGNALS = { ACTIVATE: 0, DEACTIVATE: 1 } as const;

export type LiminalSignalId = (typeof LIMINAL_SIGNALS)[keyof typeof LIMINAL_SIGNALS];

/**
 * Fold a wiring name to its canonical form: trimmed and lowercased.
 *
 * Not cosmetic. The Blender viewport lowercases both ends before pairing them, so
 * `Door1 → door1` **draws as a connection**; an exact-match runtime would then silently not
 * fire it. Normalizing here means the arrows a designer sees are exactly the signals that
 * get sent. Trimming is the same argument for a trailing space nobody can see.
 */
export function normalizeWireName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** One wired prop found on a placed entity. */
export interface Wire {
  readonly entityId: string;
  readonly classname: string;
  /** The prop's declared name — documentation only; matching never uses it. */
  readonly prop: string;
  readonly kind: 'source' | 'destination';
  /** The normalized connection name. */
  readonly name: string;
}

/**
 * Every wired `source`/`destination` prop across a set of placed entities, in entity order.
 * A blank value is not wired — that is the default, and not an error.
 */
export function collectWires(
  entities: readonly PlacedEntity[],
  registry: EntityLookup,
): Wire[] {
  const out: Wire[] = [];
  for (const entity of entities) {
    for (const prop of registry.find(entity.classname)?.props ?? []) {
      if (prop.type !== 'source' && prop.type !== 'destination') continue;
      const name = normalizeWireName(entity.properties[prop.name] as PropValue | undefined);
      if (!name) continue;
      out.push({
        entityId: entity.id,
        classname: entity.classname,
        prop: prop.name,
        kind: prop.type,
        name,
      });
    }
  }
  return out;
}

/** One delivery: a sender reached one receiver. A `send` to N receivers yields N of these. */
export interface SignalMessage<P = unknown> {
  /** The normalized connection name that matched. */
  readonly name: string;
  readonly sig: number;
  readonly payload: P;
  readonly senderId: string;
  readonly receiverId: string;
  /** The receiver's `source` prop that answers to `name`. */
  readonly input: string;
}

/**
 * The name → entity index for one level.
 *
 * `send` dispatches in entity order. The order means nothing, but it is deterministic, so two
 * hosts parsing the same bytes agree on who is signalled first when one name answers for
 * several entities.
 *
 * Generic over your payload type. This package takes no view on what a signal carries
 * beyond one strong recommendation: **make it an object with named keys**, never a bare
 * number or string. A payload outlives the entity that introduced it, and `true` tells a
 * reader nothing about what it meant.
 */
export interface WiringIndex<P = unknown> {
  /** Every name this entity's `destination` props point at, in declaration order. */
  destinationsFor(entityId: string): readonly string[];
  /** Entities answering to this name, in entity order. */
  receiversOf(name: string): readonly string[];
  /** Every distinct connection name that some entity answers to. */
  readonly names: readonly string[];
  /**
   * Dispatch to every entity whose `source` name matches, returning one message per
   * receiver. Empty when the name is unwired, which is legal: a designer may leave a
   * destination blank, and a receiver may simply not exist yet.
   */
  send(senderId: string, name: string, sig: number, payload: P): SignalMessage<P>[];
}

export function createWiring<P = unknown>(
  entities: readonly PlacedEntity[],
  registry: EntityLookup,
): WiringIndex<P> {
  const receivers = new Map<string, { entityId: string; input: string }[]>();
  const destinations = new Map<string, string[]>();

  for (const wire of collectWires(entities, registry)) {
    if (wire.kind === 'source') {
      const receiver = { entityId: wire.entityId, input: wire.prop };
      const list = receivers.get(wire.name);
      if (list) list.push(receiver);
      else receivers.set(wire.name, [receiver]);
    } else {
      const list = destinations.get(wire.entityId);
      if (list) list.push(wire.name);
      else destinations.set(wire.entityId, [wire.name]);
    }
  }

  return {
    destinationsFor: (entityId) => destinations.get(entityId) ?? [],
    receiversOf: (name) => [...new Set((receivers.get(normalizeWireName(name)) ?? []).map((r) => r.entityId))],
    names: [...receivers.keys()],
    send(senderId, name, sig, payload) {
      const normalized = normalizeWireName(name);
      const targets = receivers.get(normalized);
      if (!targets) return [];
      return targets.map(({ entityId, input }) => ({
        name: normalized,
        sig,
        payload,
        senderId,
        receiverId: entityId,
        input,
      }));
    },
  };
}

// ── Lint ─────────────────────────────────────────────────────────────────────

export interface WiringProblem {
  readonly severity: 'error' | 'warning';
  readonly entityId: string;
  readonly classname: string;
  readonly prop: string;
  readonly name: string;
  readonly message: string;
}

/**
 * Find wires that cannot do anything.
 *
 * A **dangling destination** (nothing answers to the name) is an error: it is almost always
 * a typo or an entity that was deleted, and the failure is otherwise completely silent —
 * the signal fires into nothing and the designer sees a level that just does not react.
 *
 * An **unreferenced source** is only a warning. Plenty of entities are named so that
 * something can be wired to them *later*, and a game may also signal a name from code that
 * no placed entity declares as a destination.
 *
 * Note what this does NOT tell you: that a wire which resolves actually *does* anything. A
 * signal can be dispatched, be visibly delivered, and land on a receiver whose own props
 * make it a no-op. That check needs game knowledge, so it belongs in your project.
 */
export function lintWiring(
  entities: readonly PlacedEntity[],
  registry: EntityLookup,
): WiringProblem[] {
  const wires = collectWires(entities, registry);
  const sources = new Set(wires.filter((w) => w.kind === 'source').map((w) => w.name));
  const destinations = new Set(wires.filter((w) => w.kind === 'destination').map((w) => w.name));

  const problems: WiringProblem[] = [];
  for (const wire of wires) {
    if (wire.kind === 'destination' && !sources.has(wire.name)) {
      problems.push({
        severity: 'error',
        entityId: wire.entityId,
        classname: wire.classname,
        prop: wire.prop,
        name: wire.name,
        message: `${wire.classname} "${wire.entityId}".${wire.prop} signals "${wire.name}", which no entity answers to`,
      });
    }
    if (wire.kind === 'source' && !destinations.has(wire.name)) {
      problems.push({
        severity: 'warning',
        entityId: wire.entityId,
        classname: wire.classname,
        prop: wire.prop,
        name: wire.name,
        message: `${wire.classname} "${wire.entityId}".${wire.prop} is named "${wire.name}", which nothing signals`,
      });
    }
  }
  return problems;
}
