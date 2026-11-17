import type { RawBlockTree } from "../notion/fetch.js";
import { parseNotionId } from "../notion/id.js";
import type { BodyItem, HeadingItem, NotionLink, PageModel, PropertyValue } from "./model.js";

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
    const children = normalizeBlocks(tree.children);
    const level = /^heading_(\d)$/.exec(type)?.[1];
    if (level !== undefined) {
      const text = plainText(content.rich_text).trim();
      // A toggle heading's own children come first in its section.
      out.push({ kind: "heading", id, level: Number(level), text, children });
      continue;
    }
    // A table row has cells (one rich text array each) instead of rich_text.
    const texts = type === "table_row" ? array(content.cells) : [content.rich_text];
    const text = texts
      .map((richText) => plainText(richText).trim())
      .join("\n")
      .trim();
    const links = texts.flatMap(notionLinks);
    if (type === "link_to_page") {
      const target = str(content.page_id) ?? str(content.database_id);
      const pageId = target === null ? undefined : parseNotionId(target);
      if (pageId !== undefined) links.push({ kind: "block", text: "", pageId, blockId: null });
    }
    out.push({ kind: "block", id, type, text, children, ...(links.length > 0 ? { links } : {}) });
  }
  return out;
}

/**
 * Links to Notion pages and blocks in a rich text array. Neighbouring items with the same
 * URL are one link that Notion split because of formatting (e.g. a bold word in it).
 */
export function notionLinks(richText: unknown): NotionLink[] {
  const links: NotionLink[] = [];
  let previousUrl: string | null = null;
  for (const raw of array(richText)) {
    const item = record(raw);
    const text = str(item.plain_text) ?? "";
    if (item.type === "mention") {
      previousUrl = null;
      const mention = record(item.mention);
      const target = str(record(mention[str(mention.type) ?? ""]).id);
      if (mention.type !== "page" && mention.type !== "database") continue;
      const pageId = target === null ? undefined : parseNotionId(target);
      if (pageId === undefined) continue;
      const blockId = notionTarget(str(item.href) ?? "")?.blockId ?? null;
      links.push({ kind: "mention", text, pageId, blockId });
      continue;
    }
    const url = str(record(record(item.text).link).url) ?? str(item.href);
    const target = url === null ? undefined : notionTarget(url);
    if (target === undefined) {
      previousUrl = null;
      continue;
    }
    const last = links.at(-1);
    if (url === previousUrl && last !== undefined) {
      last.text += text;
    } else {
      links.push({ kind: "link", text, ...target });
    }
    previousUrl = url;
  }
  return links;
}

const NOTION_HOSTS = /(^|\.)notion\.(so|site|com)$/i;

/**
 * The page and block a Notion URL points to: `https://www.notion.so/Title-<page id>#<block id>`,
 * or the relative form the API uses for links inside a workspace (`/<page id>#<block id>`).
 * Undefined for other URLs.
 */
export function notionTarget(
  url: string,
): { pageId: string; blockId: string | null } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, "https://www.notion.so");
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(parsed.protocol) || !NOTION_HOSTS.test(parsed.hostname)) return undefined;
  const pageId = parseNotionId(`https://www.notion.so${parsed.pathname}${parsed.search}`);
  if (pageId === undefined) return undefined;
  const fragment = parsed.hash.slice(1);
  const blockId = /^[0-9a-f-]{32,36}$/i.test(fragment) ? (parseNotionId(fragment) ?? null) : null;
  return { pageId, blockId };
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
