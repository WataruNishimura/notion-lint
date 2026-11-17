import type { PageModel } from "../normalize/model.js";
import { NotionApiError, type PageFetcher } from "../notion/fetch.js";
import { joinPath } from "../path.js";
import type { DocType } from "../schema/config.js";
import type { Finding } from "../validate/index.js";
import { outsideLinks } from "../validate/references.js";

/**
 * With `references.notionLinks`, links to other pages (page mentions, links to pages or to
 * blocks on them, `link_to_page` blocks) must point to something that exists and that the
 * integration can read. Only existence is checked: the target's section numbers are not.
 */

/** Target ID -> why it cannot be read (undefined when it can). One request per target per run. */
export type LinkCache = Map<string, Promise<string | undefined>>;

/** API error codes that mean "this target is not there for us", not "the check failed". */
const UNREADABLE = new Set(["object_not_found", "restricted_resource", "validation_error"]);

export async function checkOutsideLinks(
  page: PageModel,
  type: DocType,
  fetcher: PageFetcher,
  cache: LinkCache,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const { link, blockId } of outsideLinks(type.references, page)) {
    const targetId = link.blockId ?? link.pageId;
    let problem = cache.get(targetId);
    if (problem === undefined) {
      problem = readProblem(fetcher, targetId);
      cache.set(targetId, problem);
    }
    const reason = await problem;
    if (reason === undefined) continue;
    const what = link.blockId === null ? "page" : "block on another page";
    const name = link.text.trim() === "" ? targetId : `"${link.text.trim()}"`;
    findings.push({
      path: joinPath("references", "notionLinks"),
      rule: "references.target",
      message: `link ${name} points to a ${what} that ${reason}`,
      suggestions: [
        {
          message:
            "Fix or remove the link, or connect the integration to the linked page (... > Connections)",
        },
      ],
      blockId,
    });
  }
  return findings;
}

async function readProblem(fetcher: PageFetcher, id: string): Promise<string | undefined> {
  try {
    const block = await fetcher.block(id);
    if (block.in_trash === true || block.archived === true) return "is in the trash";
    return undefined;
  } catch (error) {
    if (error instanceof NotionApiError && error.code !== undefined && UNREADABLE.has(error.code)) {
      return `cannot be read (${error.code}): it does not exist, or the integration is not connected to it`;
    }
    throw error;
  }
}
