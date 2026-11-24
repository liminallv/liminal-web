import type { MeshOf, PropsOf } from './props.ts';
import type { EntityDescriptor } from './registry.ts';
import type { EntityNode, LevelNode, LiminalScene, PlacedEntity } from './scene.ts';
import { createWiring, type SignalMessage } from './wiring.ts';

type PlacedUnion = PlacedEntity<string, object>;

export type PlacedFrom<D extends EntityDescriptor> = PlacedEntity<D['classname'], PropsOf<D>, MeshOf<D>>;

type SourcePropOf<D extends EntityDescriptor> = Extract<NonNullable<D['props']>[number], { readonly type: 'source' }>['name'];

export type InputMessage<I extends string = string> = SignalMessage<unknown> & { readonly input: I };

export type SignalHandlers<D extends EntityDescriptor, R, X> = {
  readonly [I in SourcePropOf<D>]?: (result: R, message: InputMessage<I>, context: X) => void;
};

export interface SpawnSelf {
  readonly node: EntityNode;
  signal(name: string, sig: number, payload?: unknown): readonly InputMessage[];
}

export interface EntityRuntime<D extends EntityDescriptor = EntityDescriptor, R = unknown, X = unknown> {
  readonly def: D;
  readonly spawn: (placed: PlacedFrom<D>, self: SpawnSelf, context: X) => R;
  readonly signals: SignalHandlers<D, R, X>;
}

export function entityRuntime<const D extends EntityDescriptor, R, X = unknown>(
  def: D,
  runtime: {
    readonly spawn: (placed: PlacedFrom<D>, self: SpawnSelf, context: X) => R;
    readonly signals?: SignalHandlers<D, NoInfer<R>, X>;
  },
): EntityRuntime<D, R, X> {
  return { def, spawn: runtime.spawn, signals: runtime.signals ?? {} };
}

type Handler = (result: unknown, message: InputMessage, context: unknown) => void;

type AnyRuntime = EntityRuntime<any, any, any>;

type RuntimeFor<Rs, C> = Extract<Rs, { readonly def: { readonly classname: C } }>;

type ResultOf<Rs, E extends PlacedUnion> = [RuntimeFor<Rs, E['classname']>] extends [never]
  ? E
  : RuntimeFor<Rs, E['classname']> extends { readonly spawn: (...args: never[]) => infer R }
    ? R
    : never;

export type SpawnedEntity<E extends PlacedUnion, Rs> = E extends unknown
  ? { readonly classname: E['classname']; readonly placed: E; readonly result: ResultOf<Rs, E> }
  : never;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

type ContextOf<Rs> = UnionToIntersection<
  Rs extends { readonly spawn: (placed: never, self: never, context: infer X) => unknown } ? (unknown extends X ? never : X) : never
>;

export interface SpawnedLevel<E extends PlacedUnion, Rs> {
  readonly entities: readonly SpawnedEntity<E, Rs>[];
  get(entityId: string): SpawnedEntity<E, Rs> | undefined;
  resultsOf<C extends E['classname']>(classname: C): Extract<SpawnedEntity<E, Rs>, { readonly classname: C }>['result'][];
  signal(senderId: string, name: string, sig: number, payload?: unknown): readonly InputMessage[];
}

export function spawnLevel<
  E extends PlacedUnion,
  const Rs extends readonly { readonly def: { readonly classname: E['classname'] } }[],
>(
  scene: LiminalScene<E['classname'], E>,
  runtimes: Rs,
  ...[context]: unknown extends ContextOf<Rs[number]> ? [context?: ContextOf<Rs[number]>] : [context: ContextOf<Rs[number]>]
): SpawnedLevel<E, Rs[number]> {
  const byClassname = new Map<string, AnyRuntime>();
  for (const runtime of runtimes as unknown as readonly AnyRuntime[]) {
    if (byClassname.has(runtime.def.classname)) {
      throw new Error(`spawnLevel: two runtimes for '${runtime.def.classname}'`);
    }
    byClassname.set(runtime.def.classname, runtime);
  }

  const entities: SpawnedEntity<E, Rs[number]>[] = [];
  const byId = new Map<string, SpawnedEntity<E, Rs[number]>>();
  const wiring = createWiring<unknown>(scene.entities as readonly PlacedEntity[], scene.registry);
  let spawning = true;

  const signal = (senderId: string, name: string, sig: number, payload?: unknown): readonly InputMessage[] => {
    if (spawning) throw new Error(`spawnLevel: '${senderId}' sent '${name}' while the level was still spawning`);
    const messages = wiring.send(senderId, name, sig, payload);
    for (const message of messages) {
      const receiver = byId.get(message.receiverId);
      if (!receiver) continue;
      const signals = byClassname.get(receiver.classname)?.signals as Readonly<Record<string, Handler | undefined>> | undefined;
      const handler = signals?.[message.input];
      handler?.(receiver.result, message, context);
    }
    return messages;
  };

  const visit = (node: LevelNode<E>): void => {
    if (node.kind === 'entity') {
      const placed = node.entity;
      const runtime = byClassname.get(placed.classname);
      const self: SpawnSelf = {
        node: node as EntityNode,
        signal: (name, sig, payload) => signal(placed.id, name, sig, payload),
      };
      const result: unknown = runtime ? runtime.spawn(placed, self, context) : placed;
      const entry = { classname: placed.classname, placed, result } as SpawnedEntity<E, Rs[number]>;
      entities.push(entry);
      byId.set(placed.id, entry);
    }
    for (const child of node.children) visit(child);
  };
  for (const root of scene.roots) visit(root);
  spawning = false;

  return {
    entities,
    get: (entityId) => byId.get(entityId),
    resultsOf: (classname) => entities.filter((entry) => entry.classname === classname).map((entry) => entry.result) as never,
    signal,
  };
}
