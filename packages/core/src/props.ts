import type { LiminalPropType } from './contract.ts';
import type { EntityDescriptor } from './registry.ts';
import type { LiminalMesh } from './definition.ts';
import type { PlacedEntity, PropValue } from './scene.ts';

export type ColorValue = readonly [r: number, g: number, b: number, a: number];
export type Vector2Value = readonly [x: number, y: number];
export type Vector3Value = readonly [x: number, y: number, z: number];
export type Vector4Value = readonly [x: number, y: number, z: number, w: number];

type ChoiceValue<D, K extends string> = D extends { readonly openTypes: readonly (infer O)[] }
  ? K extends O
    ? string
    : DeclaredChoiceValue<D, K>
  : DeclaredChoiceValue<D, K>;

type DeclaredChoiceValue<D, K extends string> = D extends { readonly types: infer T }
  ? K extends keyof T
    ? T[K][keyof T[K]]
    : string | number
  : string | number;

export type PropValueOf<T extends LiminalPropType, D = unknown> = T extends `$${infer K}[]`
  ? readonly ChoiceValue<D, K>[]
  : T extends `$${infer K}`
    ? ChoiceValue<D, K>
    : T extends 'bool'
      ? boolean
      : T extends 'int' | 'float'
        ? number
        : T extends 'Color'
          ? ColorValue
          : T extends 'Vector2'
            ? Vector2Value
            : T extends 'Vector3'
              ? Vector3Value
              : T extends 'Vector4'
                ? Vector4Value
                : string;

type PropDefOf<D> = D extends { readonly props: readonly (infer P)[] } ? P : never;

type PropNameOf<P> = P extends { readonly name: infer N extends string } ? N : never;

type PropTypeOf<P> = P extends { readonly type: infer T extends LiminalPropType } ? T : never;

export type PropsOf<D> = [PropDefOf<D>] extends [never]
  ? Record<never, never>
  : string extends PropNameOf<PropDefOf<D>>
    ? Readonly<Record<string, PropValue>>
    : { readonly [P in PropDefOf<D> as PropNameOf<P>]: PropValueOf<PropTypeOf<P>, D> };

export type MeshOf<D> = D extends { readonly metadata: { readonly volume: true } } ? LiminalMesh : LiminalMesh | null;

export type PlacedOf<T extends Record<string, EntityDescriptor>> = {
  [C in keyof T & string]: PlacedEntity<C, PropsOf<T[C]>, MeshOf<T[C]>>;
}[keyof T & string];
