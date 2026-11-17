import type { PageModel } from "../normalize/model.js";
import { joinPath } from "../path.js";
import type { DocType } from "../schema/config.js";
import type { Note } from "../schema/result.js";
import { checkBody } from "./body.js";
import type { Finding } from "./finding.js";
import { checkProperties } from "./properties.js";

export type { Finding } from "./finding.js";

/** Match one normalized page against a type. Properties first, then the body. */
export function checkPage(page: PageModel, type: DocType): Finding[] {
  return [
    ...checkProperties(type.properties ?? {}, page.properties),
    ...checkBody(type.body, page.body, type.headings, type.numbering),
  ];
}

/** Whether matching needs the page's blocks (fetching them costs requests). */
export function needsBody(type: DocType): boolean {
  return (
    type.body !== undefined ||
    type.fromTemplate !== undefined ||
    type.headings?.noSkipLevel === true ||
    type.text?.textlint !== undefined
  );
}

/**
 * Parts of a type that this version does not check yet. They are skipped, not failed, and
 * reported once per type as an info note. `typePath` is where the type sits in the config
 * (`type`, `targets[0].type`).
 */
export function skippedParts(type: DocType, typePath: string): Note[] {
  const notes: Note[] = [];
  const skip = (key: keyof DocType, what: string) => {
    if (type[key] === undefined) return;
    notes.push({
      rule: "skipped",
      path: joinPath(typePath, key),
      message: `${what} is not checked yet in this version (skipped)`,
    });
  };
  skip("numbering", "numbering (section numbers)");
  skip("references", "references (section references)");
  return notes;
}
