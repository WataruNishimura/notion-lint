import type { PageModel } from "../normalize/model.js";
import { NotionApiError, type PageFetcher } from "../notion/fetch.js";
import { joinPath } from "../path.js";
import type { DocType } from "../schema/config.js";
import type { Finding } from "../validate/index.js";
import {
  checkBlockLink,
  type LinkTarget,
  linkTarget,
  type OtherPages,
  outsideLinks,
  pageTitleKey,
} from "../validate/references.js";

/**
 * With `references.notionLinks`, links to other pages (page mentions, links to pages or to
 * blocks on them, `link_to_page` blocks) must point to something that exists and that the
 * integration can read.
 *
 * When the target page is also checked in this run, it is not fetched again: it exists, and a
 * link to a block on it is matched against its headings, numbered by its own type, the way
 * links on the same page are (`references.link`). Page mentions and links to a page only need
 * the page to exist, and a checked page whose type needs no body has no headings to match.
 */

/** A page checked in this run, with the type it was checked against. */
export interface CheckedPage {
  page: PageModel;
  type: DocType;
  /** Whether the blocks were fetched (the type needs them). Without a body there are no headings to match. */
  hasBody: boolean;
  target?: LinkTarget;
}

/** Checked pages by ID (hyphens removed, lowercase). The first type given for a page wins. */
export type CheckedPages = Map<string, CheckedPage>;

export const checkedKey = (id: string): string => id.replace(/-/g, "").toLowerCase();

/** The page as a target of links and references (built once, on first use). */
function targetOf(checked: CheckedPage): LinkTarget {
  checked.target ??= linkTarget(checked.page, checked.type.numbering);
  return checked.target;
}

/**
 * The checked pages, for text references that name a page (`{page}` in `references.patterns`):
 * by ID (page mentions) and by title. Pages are not fetched again for it.
 */
export function checkedPageIndex(checked: CheckedPages): OtherPages {
  const pages = [...checked.values()];
  const withBody = pages.filter((page) => page.hasBody);
  return {
    titles: pages.map((page) => page.page.title),
    headingTitles: withBody.flatMap((page) => targetOf(page).headings.map((h) => h.title)),
    withTitle: (key) =>
      pages.filter((page) => pageTitleKey(page.page.title) === key).map((page) => page.page.id),
    target: (pageId) => {
      const page = checked.get(checkedKey(pageId));
      return page?.hasBody === true ? targetOf(page) : undefined;
    },
  };
}

/** Target ID -> why it cannot be read (undefined when it can). One request per target per run. */
export type LinkCache = Map<string, Promise<string | undefined>>;

/** API error codes that mean "this target is not there for us", not "the check failed". */
const UNREADABLE = new Set(["object_not_found", "restricted_resource", "validation_error"]);

export async function checkOutsideLinks(
  page: PageModel,
  type: DocType,
  fetcher: PageFetcher,
  cache: LinkCache,
  checked: CheckedPages = new Map(),
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const { link, blockId } of outsideLinks(type.references, page)) {
    const other = checked.get(checkedKey(link.pageId));
    if (other !== undefined && (other.hasBody || link.blockId === null)) {
      if (link.blockId !== null) {
        const finding = checkBlockLink(link, blockId, targetOf(other), true);
        if (finding !== undefined) findings.push(finding);
      }
      continue;
    }
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
