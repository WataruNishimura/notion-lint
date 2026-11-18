import type { PageModel } from "../normalize/model.js";
import type { DocType } from "../schema/config.js";
import type { Note } from "../schema/result.js";
import { checkBody } from "./body.js";
import type { Finding } from "./finding.js";
import { checkNumbering } from "./numbering.js";
import { checkProperties } from "./properties.js";
import { checkReferences, type OtherPages } from "./references.js";

export type { Finding } from "./finding.js";

/**
 * Match one normalized page against a type. Properties first, then the body, section
 * numbers, and references. Links to other pages are checked in `check` (they need the API).
 * `others` are the pages checked in the run, for references that name another page.
 */
export function checkPage(page: PageModel, type: DocType, others?: OtherPages): Finding[] {
  return [
    ...checkProperties(type.properties ?? {}, page.properties),
    ...checkBody(type.body, page.body, type.headings, type.numbering),
    ...(type.numbering === undefined ? [] : checkNumbering(type.numbering, page.body)),
    ...(type.references === undefined
      ? []
      : checkReferences(type.references, type.numbering, page, others)),
  ];
}

/** Whether matching needs the page's blocks (fetching them costs requests). */
export function needsBody(type: DocType): boolean {
  return (
    type.body !== undefined ||
    type.fromTemplate !== undefined ||
    type.headings?.noSkipLevel === true ||
    type.numbering !== undefined ||
    type.references !== undefined ||
    type.text?.textlint !== undefined
  );
}

/**
 * Parts of a type that this version does not check yet. They are skipped, not failed, and
 * reported once per type as an info note. `typePath` is where the type sits in the config
 * (`type`, `targets[0].type`). Every part of a type is checked now, so this returns no notes;
 * it stays as the place to report a part that a future version adds before checking it.
 */
export function skippedParts(_type: DocType, _typePath: string): Note[] {
  return [];
}
