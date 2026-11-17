import type { BodyItem } from "../normalize/model.js";

/**
 * Convert the body (the heading tree) to Markdown for textlint, and keep a source map from
 * Markdown lines back to the Notion blocks they came from.
 *
 * Only the plain text of each block is known, so the Markdown is built from block types:
 * headings, paragraphs, bulleted / numbered / to-do lists (nested), quotes, callouts and
 * toggles. Code, equations, dividers, tables and other blocks without prose are left out,
 * so that textlint does not lint them as text. Blocks inside them are still visited.
 */

export interface SourceLine {
  /** 1-based line in `markdown`. */
  line: number;
  /** The block whose text this line holds; null for blank lines. */
  blockId: string | null;
  /** Heading titles above the block, outermost first (empty before the first heading). */
  headings: string[];
}

export interface MarkdownDoc {
  markdown: string;
  /** One entry per line of `markdown`, in order. */
  lines: SourceLine[];
}

type Kind = "heading" | "paragraph" | "bullet" | "number" | "quote";

interface Out {
  text: string;
  blockId: string | null;
  headings: string[];
}

/** Types that render as a paragraph of their text. */
const PARAGRAPH_TYPES = new Set(["paragraph", "toggle"]);
const QUOTE_TYPES = new Set(["quote", "callout"]);
const NO_PROSE_TYPES = new Set(["code", "equation", "divider", "table_row", "table"]);

/** A leading character that Markdown would read as syntax is escaped, so the text stays text. */
function escapeLead(line: string): string {
  return line.replace(
    /^(\s*)(#{1,6}(?=\s|$)|[-+*>](?=\s|$)|\d+[.)](?=\s|$)|`{3,}|~{3,}|\|)/,
    "$1\\$2",
  );
}

export function toMarkdown(body: BodyItem[]): MarkdownDoc {
  const out: Out[] = [];
  renderItems(body, "", [], out);
  // Trim a trailing blank line.
  while (out.length > 0 && out[out.length - 1]?.blockId === null) out.pop();
  return {
    markdown: out.map((line) => line.text).join("\n"),
    lines: out.map((line, i) => ({
      line: i + 1,
      blockId: line.blockId,
      headings: line.headings,
    })),
  };
}

function renderItems(items: BodyItem[], indent: string, headings: string[], out: Out[]): void {
  let prev: Kind | undefined;
  let counter = 0;

  const blank = (): void => {
    if (out.length > 0 && out[out.length - 1]?.blockId !== null) {
      out.push({ text: indent.trimEnd(), blockId: null, headings });
    }
  };
  const emit = (kind: Kind, first: string, rest: string, text: string, id: string): void => {
    // Consecutive list items of one kind form a tight list; everything else is separated.
    const sameList = prev === kind && (kind === "bullet" || kind === "number");
    if (prev !== undefined && !sameList) blank();
    const parts = text.split(/\r?\n/);
    parts.forEach((part, i) => {
      const body = i === 0 ? first + escapeLead(part) : rest + escapeLead(part);
      out.push({ text: indent + body, blockId: id, headings });
    });
    prev = kind;
  };

  for (const item of items) {
    if (item.kind === "heading") {
      emit("heading", `${"#".repeat(item.level)} `, "", item.text, item.id);
      if (item.children.length > 0) blank();
      renderItems(item.children, indent, [...headings, item.text], out);
      prev = "heading";
      counter = 0;
      continue;
    }

    const { type, text } = item;
    let childIndent = indent;
    if (NO_PROSE_TYPES.has(type) || text === "") {
      // Nothing to lint, and a blank item would break a list in two.
    } else if (type === "bulleted_list_item" || type === "to_do") {
      emit("bullet", "- ", "  ", text, item.id);
      childIndent = `${indent}  `;
    } else if (type === "numbered_list_item") {
      counter = prev === "number" ? counter + 1 : 1;
      const marker = `${counter}. `;
      emit("number", marker, " ".repeat(marker.length), text, item.id);
      childIndent = indent + " ".repeat(marker.length);
    } else if (QUOTE_TYPES.has(type)) {
      emit("quote", "> ", "> ", text, item.id);
    } else if (PARAGRAPH_TYPES.has(type) || text !== "") {
      emit("paragraph", "", "", text, item.id);
    }

    if (item.children.length > 0) {
      const nested = childIndent !== indent;
      if (nested) {
        // Nested content stays inside the list item.
        const before = out.length;
        renderItems(item.children, childIndent, headings, out);
        if (out.length === before) continue;
      } else {
        renderItems(item.children, indent, headings, out);
        prev = "paragraph";
      }
    }
  }
}
