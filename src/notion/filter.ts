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
 * The filter for the conditions of `where` that can be translated, or undefined when none can
 * (or there is no schema). Several conditions are combined with `and`.
 */
export function buildFilter(
  types: PropertyTypes | undefined,
  where: Record<string, WhereValue> | undefined,
): Record<string, unknown> | undefined {
  if (types === undefined) return undefined;
  const conditions: Record<string, unknown>[] = [];
  for (const [name, expected] of Object.entries(where ?? {})) {
    const type = types.get(name);
    if (type === undefined) continue;
    const condition = translate(name, type, expected);
    if (condition !== undefined) conditions.push(condition);
  }
  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : { and: conditions };
}

function translate(
  property: string,
  type: string,
  expected: WhereValue,
): Record<string, unknown> | undefined {
  const text = String(expected);
  switch (type) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number":
      return { property, [type]: { equals: text } };
    case "select":
    case "status":
      return { property, [type]: { equals: text } };
    case "multi_select":
      return { property, multi_select: { contains: text } };
    case "number": {
      const number = Number(expected);
      return Number.isNaN(number) ? undefined : { property, number: { equals: number } };
    }
    case "checkbox":
      return { property, checkbox: { equals: expected === true || expected === "true" } };
    case "date":
      // Only a date or a date-time; anything else is left to the local comparison.
      return typeof expected === "string" && /^\d{4}-\d{2}-\d{2}/.test(expected)
        ? { property, date: { equals: expected } }
        : undefined;
    case "people":
    case "relation": {
      // `contains` takes an ID; a name or anything else cannot be translated.
      const id = typeof expected === "string" ? parseNotionId(expected) : undefined;
      return id === undefined ? undefined : { property, [type]: { contains: id } };
    }
    default:
      return undefined;
  }
}
