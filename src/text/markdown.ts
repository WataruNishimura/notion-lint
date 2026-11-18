import type { BlockItem, BodyItem, TextSpan } from "../normalize/model.js";

/**
 * Convert the body (the heading tree) to Markdown for textlint, and keep a source map from
 * Markdown lines back to the Notion blocks they came from.
 *
 * The Markdown is built from block types: headings, paragraphs, bulleted / numbered / to-do
 * lists (nested), quotes, callouts, toggles, and tables (a GFM table, one line per row). Code
 * blocks, equations, dividers and other blocks without prose are left out, so that textlint
 * does not lint them as text. Blocks inside them are still visited.
 *
 * Inside a block, the rich text decides what is prose:
 * - Text, bold, italic and other formatting are prose. Formatting is not written as Markdown
 *   (emphasis next to CJK punctuation does not parse, and rules do not need it); characters
 *   that Markdown would read as syntax are escaped.
 * - A text link is written as its text alone: the text is linted, the URL is not. It is not
 *   written as a Markdown link, because some rules (prh by default) skip link text.
 * - Inline code, inline equations and mentions become code spans, which textlint rules do not
 *   read as prose. Notion writes a mention's text (a page title, a name, a date), so it cannot
 *   be fixed in the block.
 */

export interface SourceLine {
  /** 1-based line in `markdown`. */
  line: number;
  /** The block whose text this line holds; null for blank lines. */
  blockId: string | null;
  /** Heading titles above the block, outermost first (empty before the first heading). */
  headings: string[];
  /** For a table row: its 1-based number in the table (the first row is 1). */
  row?: number;
  /** For a table row: where each cell's text is on the line (0-based columns, end exclusive). */
  cells?: { start: number; end: number }[];
}

export interface MarkdownDoc {
  markdown: string;
  /** One entry per line of `markdown`, in order. */
  lines: SourceLine[];
}

type Kind = "heading" | "paragraph" | "bullet" | "number" | "quote" | "table";

interface Out {
  text: string;
  blockId: string | null;
  headings: string[];
  row?: number;
  cells?: { start: number; end: number }[];
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

/** Characters that inline Markdown reads as syntax (and, in a table cell, the cell separator). */
const INLINE_SYNTAX = /[\\`*_[\]<&~]/g;
const CELL_SYNTAX = /[\\`*_[\]<&~|]/g;

const escapeInline = (text: string, table: boolean): string =>
  text.replace(table ? CELL_SYNTAX : INLINE_SYNTAX, "\\$&");

/** A code span that holds `text` as it is, whatever backticks it contains. */
function codeSpan(text: string, table: boolean): string {
  let body = text.replace(/\r?\n/g, " ");
  if (table) body = body.replace(/\|/g, "\\|");
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = body.startsWith("`") || body.endsWith("`") || /^ .*\S.* $/.test(body) ? " " : "";
  return `${fence}${pad}${body}${pad}${fence}`;
}

/** Markdown for one block's (or one cell's) rich text. */
function renderSpans(spans: TextSpan[], table: boolean): string {
  return spans
    .map((span) => {
      const text = table ? span.text.replace(/\r?\n/g, " ") : span.text;
      return span.kind === "text" ? escapeInline(text, table) : codeSpan(text, table);
    })
    .join("");
}

/** The block's text as inline Markdown (plain text when the block has no rich text). */
function inline(item: { text: string; rich?: TextSpan[][] }): string {
  const spans = item.rich?.[0];
  return spans === undefined ? escapeInline(item.text, false) : renderSpans(spans, false);
}

/** The cells of a table row, as spans. */
function rowCells(row: BlockItem): TextSpan[][] {
  return (
    row.rich ??
    row.text
      .split("\n")
      .map((text): TextSpan[] => (text === "" ? [] : [{ kind: "text", text, start: 0 }]))
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
      ...(line.row === undefined ? {} : { row: line.row, cells: line.cells }),
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
  /** A table as a GFM table: the first row is the header row, then the delimiter row. */
  const table = (item: BlockItem): void => {
    const rows = item.children.filter(
      (child): child is BlockItem => child.kind === "block" && child.type === "table_row",
    );
    const cells = rows.map(rowCells);
    const width = Math.max(0, ...cells.map((row) => row.length));
    if (width === 0) return;
    if (prev !== undefined) blank();
    rows.forEach((row, r) => {
      let line = `${indent}|`;
      const positions: { start: number; end: number }[] = [];
      for (let c = 0; c < width; c++) {
        line += " ";
        const start = line.length;
        line += renderSpans(cells[r]?.[c] ?? [], true);
        positions.push({ start, end: line.length });
        line += " |";
      }
      out.push({ text: line, blockId: row.id, headings, row: r + 1, cells: positions });
      if (r === 0) {
        out.push({ text: `${indent}|${" --- |".repeat(width)}`, blockId: row.id, headings });
      }
    });
    prev = "table";
  };

  for (const item of items) {
    if (item.kind === "heading") {
      emit("heading", `${"#".repeat(item.level)} `, "", inline(item), item.id);
      if (item.children.length > 0) blank();
      renderItems(item.children, indent, [...headings, item.text], out);
      prev = "heading";
      counter = 0;
      continue;
    }

    const { type, text } = item;
    if (type === "table") {
      table(item);
      continue;
    }
    let childIndent = indent;
    if (NO_PROSE_TYPES.has(type) || text === "") {
      // Nothing to lint, and a blank item would break a list in two.
    } else if (type === "bulleted_list_item" || type === "to_do") {
      emit("bullet", "- ", "  ", inline(item), item.id);
      childIndent = `${indent}  `;
    } else if (type === "numbered_list_item") {
      counter = prev === "number" ? counter + 1 : 1;
      const marker = `${counter}. `;
      emit("number", marker, " ".repeat(marker.length), inline(item), item.id);
      childIndent = indent + " ".repeat(marker.length);
    } else if (QUOTE_TYPES.has(type)) {
      emit("quote", "> ", "> ", inline(item), item.id);
    } else if (PARAGRAPH_TYPES.has(type) || text !== "") {
      emit("paragraph", "", "", inline(item), item.id);
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
