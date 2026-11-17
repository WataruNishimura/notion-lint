import type { RawBlockTree } from "../notion/fetch.js";
import type { BodyItem, HeadingItem, PageModel, PropertyValue } from "./model.js";

/**
 * Convert Notion API JSON (API version 2025-09-03) into the internal representation.
 * Reading is defensive: unknown or missing fields become empty values instead of throwing.
 */

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Plain text of a rich text array. */
export function plainText(richText: unknown): string {
  return array(richText)
    .map((item) => str(record(item).plain_text) ?? "")
    .join("");
}

export function normalizePage(page: Json, blocks: RawBlockTree[] = []): PageModel {
  const properties: Record<string, PropertyValue> = {};
  let title = "";
  for (const [name, raw] of Object.entries(record(page.properties))) {
    const value = normalizeProperty(record(raw));
    properties[name] = value;
    if (value.type === "title") title = value.text.trim();
  }
  return {
    id: str(page.id) ?? "",
    url: str(page.url) ?? "",
    title,
    properties,
    body: normalizeBlocks(blocks),
  };
}

export function normalizeProperty(raw: Json): PropertyValue {
  const type = str(raw.type) ?? "unknown";
  const value = raw[type];
  switch (type) {
    case "title":
    case "rich_text":
      return { type, text: plainText(value) };
    case "url":
    case "email":
    case "phone_number":
      return { type, text: str(value) ?? "" };
    case "number":
      return { type, value: typeof value === "number" ? value : null };
    case "select":
    case "status":
      return { type, value: str(record(value).name) };
    case "multi_select":
      return {
        type,
        values: array(value)
          .map((option) => str(record(option).name))
          .filter((name): name is string => name !== null),
      };
    case "date": {
      const date = record(value);
      return { type, start: str(date.start), end: str(date.end) };
    }
    case "people":
    case "files":
    case "relation":
      return { type, count: array(value).length, hasMore: raw.has_more === true };
    case "checkbox":
      return { type, checked: value === true };
    default:
      return { type: "unsupported", apiType: type };
  }
}

/** Blocks that only group other blocks; their children take their place in the body. */
const TRANSPARENT = new Set(["synced_block", "column_list", "column"]);

/** Turn a flat list of raw blocks into a heading tree. */
export function normalizeBlocks(trees: RawBlockTree[]): BodyItem[] {
  return sectionize(flatten(trees));
}

function flatten(trees: RawBlockTree[]): BodyItem[] {
  const out: BodyItem[] = [];
  for (const tree of trees) {
    const type = str(tree.block.type) ?? "unsupported";
    if (TRANSPARENT.has(type)) {
      out.push(...flatten(tree.children));
      continue;
    }
    const id = str(tree.block.id) ?? "";
    const content = record(tree.block[type]);
    const text = plainText(content.rich_text).trim();
    const children = normalizeBlocks(tree.children);
    const level = /^heading_(\d)$/.exec(type)?.[1];
    if (level !== undefined) {
      // A toggle heading's own children come first in its section.
      out.push({ kind: "heading", id, level: Number(level), text, children });
    } else {
      out.push({ kind: "block", id, type, text, children });
    }
  }
  return out;
}

function sectionize(flat: BodyItem[]): BodyItem[] {
  const root: BodyItem[] = [];
  const stack: HeadingItem[] = [];
  for (const item of flat) {
    if (item.kind === "heading") {
      while (stack.length > 0 && (stack.at(-1) as HeadingItem).level >= item.level) stack.pop();
      (stack.at(-1)?.children ?? root).push(item);
      stack.push(item);
    } else {
      (stack.at(-1)?.children ?? root).push(item);
    }
  }
  return root;
}
