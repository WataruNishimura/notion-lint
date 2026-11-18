import { parseNotionId } from "./id.js";

/**
 * Build a Notion data source query `filter` from a target's `where`, using the data
 * source's schema. The filter only narrows the query: `check` still applies `where` to
 * the pages it gets back, so a condition that cannot be translated is simply left out here
 * and stays a local check. A translated condition must never exclude a page that the local
 * comparison keeps, so each one is as loose as the local one or looser (see `compare` in
 * `src/check`).
 */

export type WhereValue = string | number | boolean;

/** Property name to Notion property type, from a data source object. */
export type PropertyTypes = Map<string, string>;

/** Read `properties` of a data source object (`GET /v1/data_sources/{id}`). */
export function propertyTypes(dataSource: Record<string, unknown>): PropertyTypes {
  const types: PropertyTypes = new Map();
  const properties = dataSource.properties;
  if (typeof properties !== "object" || properties === null) return types;
  for (const [name, config] of Object.entries(properties)) {
    const type = (config as { type?: unknown } | null)?.type;
    if (typeof type === "string") types.set(name, type);
  }
  return types;
}

/**
 * What a formula or rollup property yields, read from sample pages. The schema names the
 * property's type but not what it computes, and a filter must use the matching key
 * (`formula.string`, `rollup.number`, ...). A property with no entry is checked locally.
 */
export type ResultShape =
  | { kind: "formula"; result: "string" | "number" | "boolean" | "date" }
  | { kind: "rollup"; result: "number" | "date" }
  | { kind: "rollup"; result: "array"; item: string };

export type ResultShapes = Map<string, ResultShape>;

/** Whether `where` names a formula or rollup property of the schema, so shapes are needed. */
export function needsShapes(
  types: PropertyTypes,
  where: Record<string, WhereValue> | undefined,
): boolean {
  return Object.keys(where ?? {}).some((name) => {
    const type = types.get(name);
    return type === "formula" || type === "rollup";
  });
}

/**
 * The shape of each formula / rollup property named by `where`, from the first sample page
 * that shows it. A formula or rollup yields one type for every page, so one page is enough; a
 * rollup array needs a page whose array has an item, and an `incomplete` rollup shows nothing.
 */
export function resultShapes(
  types: PropertyTypes,
  where: Record<string, WhereValue> | undefined,
  samples: Record<string, unknown>[],
): ResultShapes {
  const shapes: ResultShapes = new Map();
  for (const name of Object.keys(where ?? {})) {
    const type = types.get(name);
    if (type !== "formula" && type !== "rollup") continue;
    for (const sample of samples) {
      const properties = sample.properties as Record<string, Record<string, unknown>> | undefined;
      const shape = shapeOf(type, properties?.[name]?.[type]);
      if (shape !== undefined) {
        shapes.set(name, shape);
        break;
      }
    }
  }
  return shapes;
}

function shapeOf(type: "formula" | "rollup", value: unknown): ResultShape | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result = (value as { type?: unknown }).type;
  if (type === "formula") {
    return result === "string" || result === "number" || result === "boolean" || result === "date"
      ? { kind: "formula", result }
      : undefined;
  }
  if (result === "number" || result === "date") return { kind: "rollup", result };
  if (result !== "array") return undefined;
  const items = (value as { array?: unknown }).array;
  const item = Array.isArray(items)
    ? (items[0] as { type?: unknown } | undefined)?.type
    : undefined;
  return typeof item === "string" ? { kind: "rollup", result: "array", item } : undefined;
}

/**
 * The filter for the conditions of `where` that can be translated, or undefined when none can
 * (or there is no schema). Several conditions are combined with `and`. `shapes` carries what
 * formula and rollup properties yield; without it those conditions stay local.
 */
export function buildFilter(
  types: PropertyTypes | undefined,
  where: Record<string, WhereValue> | undefined,
  shapes?: ResultShapes,
): Record<string, unknown> | undefined {
  if (types === undefined) return undefined;
  const conditions: Record<string, unknown>[] = [];
  for (const [name, expected] of Object.entries(where ?? {})) {
    const type = types.get(name);
    if (type === undefined) continue;
    const condition = typeCondition(type, expected, shapes?.get(name));
    if (condition !== undefined) conditions.push({ property: name, ...condition });
  }
  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : { and: conditions };
}

/** The part of a filter that follows `property`: `{ <type>: { <operator>: value } }`. */
function typeCondition(
  type: string,
  expected: WhereValue,
  shape?: ResultShape,
): Record<string, unknown> | undefined {
  const text = String(expected);
  switch (type) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number":
      return { [type]: { equals: text } };
    case "select":
    case "status":
      return { [type]: { equals: text } };
    case "multi_select":
      return { multi_select: { contains: text } };
    case "number": {
      const number = Number(expected);
      return Number.isNaN(number) ? undefined : { number: { equals: number } };
    }
    case "checkbox":
      return { checkbox: { equals: toBoolean(expected) } };
    case "date":
      // Only a date or a date-time; anything else is left to the local comparison.
      return isDate(expected) ? { date: { equals: expected } } : undefined;
    case "people":
    case "relation": {
      // `contains` takes an ID; a name or anything else cannot be translated.
      const id = typeof expected === "string" ? parseNotionId(expected) : undefined;
      return id === undefined ? undefined : { [type]: { contains: id } };
    }
    case "files":
      // A boolean asks whether the property has files. A name has no filter, but a page with
      // a file of that name has at least one file, which narrows the query.
      return {
        files: typeof expected === "boolean" ? emptiness(expected) : { is_not_empty: true },
      };
    case "formula":
      return shape?.kind === "formula" ? formulaCondition(shape.result, expected) : undefined;
    case "rollup":
      return shape?.kind === "rollup" ? rollupCondition(shape, expected) : undefined;
    default:
      return undefined;
  }
}

function emptiness(hasFiles: boolean): Record<string, true> {
  return hasFiles ? { is_not_empty: true } : { is_empty: true };
}

/** `formula.<result type>`, with the comparison the local check makes for that result. */
function formulaCondition(
  result: "string" | "number" | "boolean" | "date",
  expected: WhereValue,
): Record<string, unknown> | undefined {
  switch (result) {
    case "string":
      return { formula: { string: { equals: String(expected) } } };
    case "number": {
      const number = Number(expected);
      return Number.isNaN(number) ? undefined : { formula: { number: { equals: number } } };
    }
    case "boolean":
      return { formula: { checkbox: { equals: toBoolean(expected) } } };
    case "date":
      return isDate(expected) ? { formula: { date: { equals: expected } } } : undefined;
  }
}

/** Item types of a rollup array that `any` can compare. */
const ROLLUP_ITEM_TYPES = new Set([
  "title",
  "rich_text",
  "url",
  "email",
  "phone_number",
  "select",
  "status",
  "multi_select",
  "number",
  "checkbox",
  "date",
]);

/**
 * `rollup.number` / `rollup.date` for those results, and `rollup.any` for an array: some item
 * equals the value, as the local check reads it. A title item is filtered as `rich_text`.
 * (`every` and `none` have no `where` form.)
 */
function rollupCondition(
  shape: Extract<ResultShape, { kind: "rollup" }>,
  expected: WhereValue,
): Record<string, unknown> | undefined {
  switch (shape.result) {
    case "number": {
      const number = Number(expected);
      return Number.isNaN(number) ? undefined : { rollup: { number: { equals: number } } };
    }
    case "date":
      return isDate(expected) ? { rollup: { date: { equals: expected } } } : undefined;
    case "array": {
      if (!ROLLUP_ITEM_TYPES.has(shape.item)) return undefined;
      const item = typeCondition(shape.item === "title" ? "rich_text" : shape.item, expected);
      return item === undefined ? undefined : { rollup: { any: item } };
    }
  }
}

function isDate(expected: WhereValue): expected is string {
  return typeof expected === "string" && /^\d{4}-\d{2}-\d{2}/.test(expected);
}

/** A checkbox value in `where`: `true`, or the text "true". The local comparison reads it the same way. */
export function toBoolean(expected: WhereValue): boolean {
  return expected === true || expected === "true";
}
