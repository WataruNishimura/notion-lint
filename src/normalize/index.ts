import type { RawBlockTree } from "../notion/fetch.js";
import { parseNotionId } from "../notion/id.js";
import { mayBeTruncated, PAGE_OBJECT_LIMIT } from "../notion/long-values.js";
import type {
  BodyItem,
  HeadingItem,
  NotionLink,
  PageModel,
  PropertyValue,
  TextSpan,
} from "./model.js";

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
    case "relation":
      return {
        type,
        count: array(value).length,
        hasMore: mayBeTruncated(raw),
        ids: array(value)
          .map((item) => str(record(item).id))
          .filter((id): id is string => id !== null)
          .map((id) => parseNotionId(id) ?? id),
      };
    case "files":
      return {
        type,
        count: array(value).length,
        hasMore: mayBeTruncated(raw),
        names: array(value)
          .map((item) => str(record(item).name))
          .filter((name): name is string => name !== null),
      };
    case "formula":
      return normalizeFormula(record(value));
    case "rollup":
      return normalizeRollup(record(value));
    case "checkbox":
      return { type, checked: value === true };
    default:
      return { type: "unsupported", apiType: type };
  }
}

function normalizeFormula(formula: Json): PropertyValue {
  const result = str(formula.type);
  switch (result) {
    case "string":
      return { type: "formula", result, value: str(formula.string) };
    case "number":
      return {
        type: "formula",
        result,
        value: typeof formula.number === "number" ? formula.number : null,
      };
    case "boolean":
      return {
        type: "formula",
        result,
        value: typeof formula.boolean === "boolean" ? formula.boolean : null,
      };
    case "date":
      return { type: "formula", result, value: str(record(formula.date).start) };
    default:
      return { type: "formula", result: null, value: null };
  }
}

function normalizeRollup(rollup: Json): PropertyValue {
  switch (str(rollup.type)) {
    case "number":
      return {
        type: "rollup",
        result: "number",
        value: typeof rollup.number === "number" ? rollup.number : null,
      };
    case "date":
      return { type: "rollup", result: "date", value: str(record(rollup.date).start) };
    case "array": {
      const items = array(rollup.array);
      return {
        type: "rollup",
        result: "array",
        items: items.map((item) => normalizeProperty(record(item))),
        hasMore: items.length >= PAGE_OBJECT_LIMIT,
      };
    }
    default:
      return { type: "rollup", result: "incomplete" };
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
      const { text, rich } = richTexts([content.rich_text]);
      // A toggle heading's own children come first in its section.
      out.push({
        kind: "heading",
        id,
        level: Number(level),
        text,
        ...(rich.some((cell) => cell.length > 0) ? { rich } : {}),
        children,
      });
      continue;
    }
    // A table row has cells (one rich text array each) instead of rich_text.
    const texts = type === "table_row" ? array(content.cells) : [content.rich_text];
    const { text, rich } = richTexts(texts);
    const links = texts.flatMap(notionLinks);
    if (type === "link_to_page") {
      const target = str(content.page_id) ?? str(content.database_id);
      const pageId = target === null ? undefined : parseNotionId(target);
      if (pageId !== undefined) links.push({ kind: "block", text: "", pageId, blockId: null });
    }
    out.push({
      kind: "block",
      id,
      type,
      text,
      ...(type === "table_row" || rich.some((cell) => cell.length > 0) ? { rich } : {}),
      children,
      ...(links.length > 0 ? { links } : {}),
    });
  }
  return out;
}

/**
 * The text of one or more rich text arrays (table cells), each trimmed and joined with
 * newlines, and their spans with offsets into that text.
 */
export function richTexts(texts: unknown[]): { text: string; rich: TextSpan[][] } {
  const cells = texts.map((richText) => {
    const spans = textSpans(richText);
    const raw = spans.map((span) => span.text).join("");
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    return { text, spans: clip(spans, lead, lead + text.length) };
  });
  const joined = cells.map((cell) => cell.text).join("\n");
  // The whole text is trimmed too (empty leading cells); move the offsets with it.
  let at = -(joined.length - joined.trimStart().length);
  const rich = cells.map((cell) => {
    const spans = cell.spans.map((span) => ({ ...span, start: span.start + at }));
    at += cell.text.length + 1;
    return spans;
  });
  return { text: joined.trim(), rich };
}

/** Spans of a rich text array, with offsets into its plain text. */
function textSpans(richText: unknown): TextSpan[] {
  const spans: TextSpan[] = [];
  let at = 0;
  for (const raw of array(richText)) {
    const item = record(raw);
    const text = str(item.plain_text) ?? "";
    if (text === "") continue;
    let span: TextSpan;
    if (item.type === "mention") {
      const mention = record(item.mention);
      const target = str(record(mention[str(mention.type) ?? ""]).id);
      const pageId =
        (mention.type === "page" || mention.type === "database") && target !== null
          ? parseNotionId(target)
          : undefined;
      span = { kind: "mention", text, start: at, ...(pageId === undefined ? {} : { pageId }) };
    } else if (item.type === "equation") {
      span = { kind: "equation", text, start: at };
    } else if (record(item.annotations).code === true) {
      span = { kind: "code", text, start: at };
    } else {
      span = { kind: "text", text, start: at };
    }
    at += text.length;
    // Notion splits text where formatting changes; neighbouring pieces of one kind are one span.
    const last = spans.at(-1);
    if (last !== undefined && span.kind !== "mention" && last.kind === span.kind) {
      last.text += span.text;
    } else {
      spans.push(span);
    }
  }
  return spans;
}

/** Spans cut to the range from `from` to `to`, with offsets relative to `from`. */
function clip(spans: TextSpan[], from: number, to: number): TextSpan[] {
  const out: TextSpan[] = [];
  for (const span of spans) {
    const start = Math.max(span.start, from);
    const end = Math.min(span.start + span.text.length, to);
    if (end <= start) continue;
    out.push({
      ...span,
      text: span.text.slice(start - span.start, end - span.start),
      start: start - from,
    });
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
export function notionTarget(url: string): { pageId: string; blockId: string | null } | undefined {
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
