import type { Suggestion } from "../schema/result.js";

/**
 * One mismatch between a page and its type, before page-level details (page ID, URL,
 * severity) are added to make it a `Violation`.
 */
export interface Finding {
  /** Where in the type: `properties.<name>`, `body[1]`, `body[1].children[0]`, `headings.noSkipLevel`. */
  path: string;
  rule: string;
  message: string;
  suggestions: Suggestion[];
  /** The block the finding is about; null for properties and for missing blocks. */
  blockId: string | null;
  /** A block to link to when `blockId` is null (e.g. the heading a missing list belongs under). */
  nearBlockId?: string;
}
