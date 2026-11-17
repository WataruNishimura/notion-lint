import type { BodyItem, HeadingItem } from "../normalize/model.js";
import type { BodyNode, DocType, HeadingLevel, NumberingRule } from "../schema/config.js";
import { titleReader } from "./body.js";

/**
 * Build a `body` skeleton from the heading tree of a template page (`fromTemplate`).
 *
 * - Only headings become entries. Each is a required heading with the template's level and
 *   exact text (a section number in the `numbering` format is stripped, as for page headings).
 *   Paragraphs, lists, and other blocks in the template are placeholder content, so they
 *   produce no block entries.
 * - A heading gets `children` only when the template has sub-headings under it, so
 *   `headings.allowExtra: false` is enforced under such headings and nowhere else.
 * - Headings deeper than H3 (which the skeleton cannot express) and empty headings are
 *   ignored, as are headings nested inside other blocks (toggles, columns).
 */
export function skeletonFromTemplate(
  items: BodyItem[],
  numbering: NumberingRule | undefined,
): BodyNode[] {
  const titleOf = titleReader(numbering);
  const convert = (list: BodyItem[]): BodyNode[] =>
    list
      .filter((item): item is HeadingItem => item.kind === "heading")
      .flatMap((heading): BodyNode[] => {
        const title = titleOf(heading);
        if (title === "" || heading.level > 3) return [];
        const children = convert(heading.children);
        return [
          {
            heading: heading.level as HeadingLevel,
            title,
            ...(children.length === 0 ? {} : { children }),
          },
        ];
      });
  return convert(items);
}

/**
 * The type to match against: `body` written in the type wins over the template's (they are
 * not merged); otherwise the template skeleton is the body. Everything else in the type
 * (properties, headings, ...) applies as written.
 */
export function withTemplateBody(type: DocType, skeleton: BodyNode[] | undefined): DocType {
  if (type.body !== undefined || skeleton === undefined) return type;
  return { ...type, body: skeleton };
}
