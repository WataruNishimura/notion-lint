import type { PageFetcher } from "./fetch.js";

/**
 * Page objects cut list-valued properties short: `people`, `files`, `relation`, and the
 * rich text of `title` / `rich_text` hold at most 25 items. The rest is only available from
 * the page property item endpoint (`pages.properties.retrieve`). This module replaces a
 * truncated value with the full one, in the page object's own shape, so `normalize` and
 * the matching code need no special case.
 */

const LIST_TYPES = new Set(["title", "rich_text", "people", "files", "relation"]);

/** The most items a page object holds for one property. */
export const PAGE_OBJECT_LIMIT = 25;

type Json = Record<string, unknown>;

/** True when a property value in a page object may be missing items. */
export function mayBeTruncated(property: Json): boolean {
  const type = property.type;
  if (typeof type !== "string" || !LIST_TYPES.has(type)) return false;
  // The API states `has_more` for relation; once a value is complete it is false (see below).
  // Other lists carry no flag, so a list as long as the limit may have been cut.
  if (typeof property.has_more === "boolean") return property.has_more;
  const items = property[type];
  return Array.isArray(items) && items.length >= PAGE_OBJECT_LIMIT;
}

/**
 * The page object with the full value of every possibly truncated list property in
 * `names` (and of the title, which names the page). Properties that are complete are not
 * requested again. Returns the same object when nothing was truncated.
 */
export async function withFullProperties(
  page: Json,
  names: Iterable<string>,
  fetcher: Pick<PageFetcher, "propertyItems">,
): Promise<Json> {
  const properties = page.properties;
  const pageId = page.id;
  if (typeof properties !== "object" || properties === null || typeof pageId !== "string") {
    return page;
  }
  const wanted = new Set(names);
  const full: Record<string, unknown> = { ...properties };
  let changed = false;
  for (const [name, value] of Object.entries(properties)) {
    const property = value as Json;
    if (!(wanted.has(name) || property.type === "title") || !mayBeTruncated(property)) continue;
    if (typeof property.id !== "string") continue;
    const type = property.type as string;
    const items = await fetcher.propertyItems(pageId, property.id);
    // A property item is `{ object: "property_item", type, [type]: value }`; the page
    // object holds just the values.
    full[name] = {
      ...property,
      [type]: items.map((item) => item[type]),
      has_more: false,
    };
    changed = true;
  }
  return changed ? { ...page, properties: full } : page;
}
