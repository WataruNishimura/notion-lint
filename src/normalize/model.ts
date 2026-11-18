/**
 * The internal representation of a page. The matching code only reads these shapes,
 * never the Notion API's JSON (which `normalize` converts from).
 */

export interface PageModel {
  id: string;
  url: string;
  title: string;
  properties: Record<string, PropertyValue>;
  /**
   * The body as a heading tree: the blocks under a heading (up to the next heading of the
   * same or a higher level) are that heading's children. Blocks before the first heading
   * stay at the top level.
   */
  body: BodyItem[];
}

export type TextPropertyType = "title" | "rich_text" | "url" | "email" | "phone_number";
export type CountPropertyType = "people" | "files" | "relation";

export type PropertyValue =
  | { type: TextPropertyType; text: string }
  | { type: "number"; value: number | null }
  | { type: "select" | "status"; value: string | null }
  | { type: "multi_select"; values: string[] }
  | { type: "date"; start: string | null; end: string | null }
  /**
   * `ids` (people and relation only) are the user / page IDs, hyphenated. `hasMore` is true
   * only for a page object whose list may be cut short (see `src/notion/long-values.ts`): it
   * holds 25 items at most, so `count` and `ids` are partial. `check` completes pages before
   * matching them.
   */
  | { type: CountPropertyType; count: number; hasMore: boolean; ids?: string[] }
  | { type: "checkbox"; checked: boolean }
  /** Property types that types cannot describe (formula, rollup, created_time, ...). */
  | { type: "unsupported"; apiType: string };

export interface HeadingItem {
  kind: "heading";
  id: string;
  level: number;
  /** Plain text, trimmed. */
  text: string;
  /** The heading's rich text as spans over `text` (absent when it has none). */
  rich?: TextSpan[][];
  children: BodyItem[];
}

export interface BlockItem {
  kind: "block";
  id: string;
  /** Notion block type (`paragraph`, `bulleted_list_item`, `to_do`, ...). */
  type: string;
  /**
   * Plain text of the block's own rich text, if it has any. For a table row, the cells
   * joined with newlines.
   */
  text: string;
  /**
   * The rich text as spans over `text`: one list for most blocks, one per cell for a table
   * row (absent for blocks without rich text). Used to tell prose from inline code and
   * mentions, and to find mentions in the text.
   */
  rich?: TextSpan[][];
  /** Child blocks (toggle contents, nested list items, ...), as a heading tree too. */
  children: BodyItem[];
  /** Links to Notion pages and blocks in the block's text (absent when there are none). */
  links?: NotionLink[];
}

/**
 * A link to a Notion page or block: a text link to a Notion URL, a page mention, or a
 * `link_to_page` block. Links to other websites are not kept.
 */
export interface NotionLink {
  /** `link` (text with a URL), `mention` (Notion keeps its text up to date), or `block` (`link_to_page`). */
  kind: "link" | "mention" | "block";
  /** The link text (for a mention, the title Notion shows; empty for `link_to_page`). */
  text: string;
  /** The linked page (or database), hyphenated. */
  pageId: string;
  /** The linked block within that page (the URL fragment), hyphenated; null for a page link. */
  blockId: string | null;
}

/**
 * A piece of rich text. Formatting that does not change what the text is (bold, italic,
 * colours, links) is not kept.
 */
export interface TextSpan {
  /** `text` (prose, including link text), `code` (inline code), `equation`, or `mention` (Notion writes its text). */
  kind: "text" | "code" | "equation" | "mention";
  /** The span's text, as it appears in the block's `text`. */
  text: string;
  /** Offset of the span in the block's `text`. */
  start: number;
  /** For a page or database mention: the page, hyphenated. */
  pageId?: string;
}

export type BodyItem = HeadingItem | BlockItem;
