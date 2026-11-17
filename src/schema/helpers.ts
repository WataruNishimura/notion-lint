import {
  Kind,
  type SchemaOptions,
  type Static,
  type TObject,
  type TSchema,
  type TUnsafe,
  Type,
} from "@sinclair/typebox";

/**
 * Helpers that build JSON Schema fragments while keeping a precise static type.
 *
 * TypeBox's own `Type.Union` emits `anyOf`, and Ajv then reports an error for every
 * branch, which makes "which field is wrong" hard to read. The unions here emit
 * `if` / `then` instead, so only the branch the input chose reports errors.
 */

/** A string that must be one of `values`. Emits `enum` (one error instead of one per literal). */
export function StringEnum<const T extends readonly string[]>(
  values: T,
  options: SchemaOptions = {},
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ ...options, type: "string", enum: [...values] });
}

/** An integer that must be one of `values`. */
export function IntegerEnum<const T extends readonly number[]>(
  values: T,
  options: SchemaOptions = {},
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ ...options, type: "integer", enum: [...values] });
}

/** A reference to a schema placed in the root `definitions` with the same `$id`. */
export function RefTo<T extends TSchema>(
  schema: T,
  options: SchemaOptions = {},
): TUnsafe<Static<T>> {
  if (typeof schema.$id !== "string") throw new Error("RefTo needs a schema with $id");
  return Type.Unsafe<Static<T>>({ ...options, $ref: schema.$id });
}

type UnionStatic<T extends TSchema[], P extends unknown[]> = {
  [K in keyof T]: T[K] extends TSchema ? Static<T[K], P> : never;
}[number];

/**
 * A union of objects told apart by the value of one property (`type` for properties).
 * Custom kind so that `Static` passes recursion parameters through, like TypeBox's own types.
 */
export interface TTaggedUnion<T extends TObject[]> extends TSchema {
  [Kind]: "NotionLint:TaggedUnion";
  static: UnionStatic<T, this["params"]>;
}

export function TaggedUnion<T extends TObject[]>(
  tag: string,
  variants: [...T],
  options: SchemaOptions = {},
): TTaggedUnion<T> {
  const tags = variants.map((variant) => {
    const value = (variant.properties[tag] as { const?: unknown } | undefined)?.const;
    if (typeof value !== "string") throw new Error(`variant is missing a const "${tag}"`);
    return value;
  });
  return {
    ...options,
    [Kind]: "NotionLint:TaggedUnion",
    type: "object",
    required: [tag],
    properties: { [tag]: { type: "string", enum: tags } },
    allOf: variants.map((variant, i) => ({
      if: { required: [tag], properties: { [tag]: { const: tags[i] } } },
      then: variant,
    })),
  } as unknown as TTaggedUnion<T>;
}

/**
 * A union of objects told apart by which key is present
 * (`{ "heading": 2, ... }` vs `{ "block": "to_do", ... }`).
 */
export interface TKeyedUnion<T extends TObject[]> extends TSchema {
  [Kind]: "NotionLint:KeyedUnion";
  static: UnionStatic<T, this["params"]>;
}

export function KeyedUnion<T extends TObject[]>(
  keys: { [K in keyof T]: string },
  variants: [...T],
  options: SchemaOptions = {},
): TKeyedUnion<T> {
  const keyList = keys as readonly string[];
  return {
    ...options,
    [Kind]: "NotionLint:KeyedUnion",
    type: "object",
    anyOf: keyList.map((key) => ({ required: [key] })),
    allOf: variants.map((variant, i) => ({ if: { required: [keyList[i]] }, then: variant })),
  } as unknown as TKeyedUnion<T>;
}

/** `{ "pattern": "<regex source>", "flags": "iu" }` */
export const Regex = Type.Object(
  {
    pattern: Type.String({
      format: "regex",
      description: "Regex source in JavaScript (without the surrounding slashes)",
    }),
    flags: Type.Optional(
      Type.String({ pattern: "^[dgimsuvy]*$", description: "Regex flags (e.g. iu)" }),
    ),
  },
  { additionalProperties: false },
);
export type Regex = Static<typeof Regex>;

/** A string, or a regular expression written as `{ "pattern": "..." }`. */
export function StringOrRegex(options: SchemaOptions = {}): TUnsafe<string | Regex> {
  return Type.Unsafe<string | Regex>({
    ...options,
    type: ["string", "object"],
    minLength: 1,
    if: { type: "object" },
    then: Regex,
  });
}
