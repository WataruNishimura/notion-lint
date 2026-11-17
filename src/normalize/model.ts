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
  /** `hasMore`: the API truncated the list (more than 25 items), so `count` is a lower bound. */
  | { type: CountPropertyType; count: number; hasMore: boolean }
  | { type: "checkbox"; checked: boolean }
  /** Property types that types cannot describe (formula, rollup, created_time, ...). */
  | { type: "unsupported"; apiType: string };

export interface HeadingItem {
  kind: "heading";
  id: string;
  level: number;
  /** Plain text, trimmed. */
  text: string;
  children: BodyItem[];
}

export interface BlockItem {
  kind: "block";
  id: string;
  /** Notion block type (`paragraph`, `bulleted_list_item`, `to_do`, ...). */
  type: string;
  /** Plain text of the block's own rich text, if it has any. */
  text: string;
  /** Child blocks (toggle contents, nested list items, ...), as a heading tree too. */
  children: BodyItem[];
}

export type BodyItem = HeadingItem | BlockItem;
