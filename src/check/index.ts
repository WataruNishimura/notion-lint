import { normalizePage } from "../normalize/index.js";
import type { BodyItem, PageModel, PropertyValue } from "../normalize/model.js";
import { NotionApiError, type PageFetcher } from "../notion/fetch.js";
import { buildFilter, propertyTypes } from "../notion/filter.js";
import { parseNotionId } from "../notion/id.js";
import { withFullProperties } from "../notion/long-values.js";
import { joinPath } from "../path.js";
import type { Config, DocType } from "../schema/config.js";
import type {
  CheckResult,
  ErrorKind,
  ErrorResult,
  Note,
  PageResult,
  Violation,
} from "../schema/result.js";
import { type PreparedTextlint, prepareTextlint, TextlintSetupError } from "../text/textlint.js";
import { checkPage, type Finding, needsBody, skippedParts } from "../validate/index.js";
import { skeletonFromTemplate, withTemplateBody } from "../validate/template.js";
import { checkOutsideLinks, type LinkCache } from "./links.js";

/**
 * `check`: decide which pages to check, fetch them, normalize, match against their types,
 * and build the result. Fetching goes through `PageFetcher`, so tests run without network.
 */

export class CheckError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CheckError";
  }
}

/** What to check, decided from the arguments and the config before anything is fetched. */
export type Plan =
  | { kind: "page"; pageId: string; type: DocType; typePath: string }
  | {
      kind: "dataSource";
      dataSourceId: string;
      where: Record<string, string | number | boolean> | undefined;
      type: DocType;
      typePath: string;
      wherePath: string;
    };

/** Throws `CheckError` for a config that names nothing to check or an invalid ID. */
export function planCheck(config: Config, pages: string[]): Plan[] {
  if (pages.length > 0) {
    const type = config.type;
    if (type === undefined) {
      throw new CheckError(
        "usage",
        "Checking with --page requires a type (the type to apply to the page) in the config",
      );
    }
    return pages.map((pageId) => ({ kind: "page", pageId, type, typePath: "type" }));
  }
  if (config.targets === undefined) {
    throw new CheckError(
      "usage",
      "Nothing to check: pass --page <URL or ID>, or add targets to the config",
    );
  }
  return config.targets.map((target, i): Plan => {
    const base = joinPath("targets", i);
    const typePath = joinPath(base, "type");
    if ("page" in target) {
      const pageId = parseNotionId(target.page);
      if (pageId === undefined) {
        throw new CheckError(
          "config",
          `${joinPath(base, "page")} is not a Notion page URL or ID: ${target.page}`,
        );
      }
      return { kind: "page", pageId, type: target.type, typePath };
    }
    const dataSourceId = parseNotionId(target.dataSource);
    if (dataSourceId === undefined) {
      throw new CheckError(
        "config",
        `${joinPath(base, "dataSource")} is not a Notion data source URL or ID: ${target.dataSource}`,
      );
    }
    return {
      kind: "dataSource",
      dataSourceId,
      where: target.where,
      type: target.type,
      typePath,
      wherePath: joinPath(base, "where"),
    };
  });
}

export interface CheckOptions {
  /** Directory that textlint presets and prh paths resolve from: the config file's directory, or the current directory. */
  baseDir?: string;
}

export async function runCheck(
  plans: Plan[],
  fetcher: PageFetcher,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const results: PageResult[] = [];
  const notes = new Map<string, Note>();
  // Load textlint first: a missing preset or dictionary is a config error before any request.
  const textlints = plans.map((plan) => loadTextlint(plan, options.baseDir ?? process.cwd()));
  const templates = new Map<string, Promise<BodyItem[]>>();
  const linkTargets: LinkCache = new Map();

  for (const [planIndex, rawPlan] of plans.entries()) {
    const plan = { ...rawPlan, type: await resolveTemplate(rawPlan, fetcher, templates) };
    for (const note of skippedParts(plan.type, plan.typePath)) notes.set(note.path, note);
    const rawPages =
      plan.kind === "page"
        ? [await fetcher.page(plan.pageId)]
        : await dataSourcePages(plan, fetcher);
    // Property lists the type or `where` looks at are read in full (page objects stop at 25).
    const listed = [...Object.keys(plan.type.properties ?? {})];
    if (plan.kind === "dataSource") listed.push(...Object.keys(plan.where ?? {}));
    for (const listedRaw of rawPages) {
      const raw = await withFullProperties(listedRaw, listed, fetcher);
      // `where` again on the full values: the first pass keeps a page whose list was cut short.
      if (plan.kind === "dataSource" && raw !== listedRaw) {
        if (!whereMatches(normalizePage(raw), plan.where, plan.wherePath)) continue;
      }
      const id = typeof raw.id === "string" ? raw.id : "";
      const blocks = needsBody(plan.type) ? await fetcher.blocks(id) : [];
      const page = normalizePage(raw, blocks);
      const findings = checkPage(page, plan.type);
      findings.push(...(await checkOutsideLinks(page, plan.type, fetcher, linkTargets)));
      const textlint = textlints[planIndex];
      if (textlint !== undefined) findings.push(...(await textFindings(textlint, page)));
      results.push(pageResult(page, plan.type, findings));
    }
  }

  const violations = results.flatMap((page) => page.violations);
  const errors = violations.filter((v) => v.severity === "error").length;
  return {
    ok: violations.length === 0,
    summary: {
      pages: results.length,
      violations: violations.length,
      errors,
      warnings: violations.length - errors,
    },
    pages: results,
    notes: [...notes.values()],
  };
}

function loadTextlint(plan: Plan, baseDir: string): PreparedTextlint | undefined {
  const rule = plan.type.text?.textlint;
  if (rule === undefined) return undefined;
  try {
    return prepareTextlint(rule, baseDir, joinPath(joinPath(plan.typePath, "text"), "textlint"));
  } catch (error) {
    if (error instanceof TextlintSetupError) throw new CheckError("config", error.message);
    throw error;
  }
}

async function textFindings(textlint: PreparedTextlint, page: PageModel): Promise<Finding[]> {
  return (await textlint.lintBody(page.body)).map((found) => ({
    path: found.path,
    rule: found.rule,
    severity: found.severity,
    message: found.message,
    suggestions: found.suggestions,
    blockId: found.blockId,
  }));
}

/**
 * Apply `fromTemplate`: fetch the template page (once per run, however many targets use it)
 * and make its headings the type's `body`. A `body` written in the type wins, so the template
 * is not fetched then. A template that cannot be fetched is an API error.
 */
async function resolveTemplate(
  plan: Plan,
  fetcher: PageFetcher,
  cache: Map<string, Promise<BodyItem[]>>,
): Promise<DocType> {
  const { type, typePath } = plan;
  if (type.fromTemplate === undefined || type.body !== undefined) return type;
  const pageId = parseNotionId(type.fromTemplate.page);
  if (pageId === undefined) {
    throw new CheckError(
      "config",
      `${joinPath(typePath, "fromTemplate.page")} is not a Notion page URL or ID: ${type.fromTemplate.page}`,
    );
  }
  let items = cache.get(pageId);
  if (items === undefined) {
    items = (async () => {
      try {
        const raw = await fetcher.page(pageId);
        return normalizePage(raw, await fetcher.blocks(pageId)).body;
      } catch (error) {
        if (error instanceof NotionApiError) {
          throw new NotionApiError(
            `${joinPath(typePath, "fromTemplate")}: cannot read the template page ${pageId}: ${error.message}`,
            error.status,
            error.code,
          );
        }
        throw error;
      }
    })();
    cache.set(pageId, items);
  }
  return withTemplateBody(type, skeletonFromTemplate(await items, type.numbering));
}

/** Link to a block on a page: the page URL with the block ID (without hyphens) as the fragment. */
export function blockUrl(pageUrl: string, blockId: string): string {
  return `${pageUrl.replace(/#.*$/, "")}#${blockId.replace(/-/g, "")}`;
}

function pageResult(page: PageModel, type: DocType, findings: Finding[]): PageResult {
  const violations = findings.map((finding): Violation => {
    const linkTo = finding.blockId ?? finding.nearBlockId;
    return {
      pageId: page.id,
      blockId: finding.blockId,
      path: finding.path,
      rule: finding.rule,
      severity: finding.severity ?? "error",
      message: finding.message,
      suggestions: finding.suggestions,
      url: linkTo === undefined || page.url === "" ? page.url : blockUrl(page.url, linkTo),
    };
  });
  return {
    pageId: page.id,
    url: page.url,
    title: page.title,
    ...(type.name === undefined ? {} : { typeName: type.name }),
    violations,
  };
}

/**
 * The pages of a data source target. `where` is sent to Notion as a query filter as far as
 * the data source's schema allows. The filter only narrows the query: every condition is
 * also checked here on the pages that come back, so the result does not depend on it.
 */
async function dataSourcePages(
  plan: Extract<Plan, { kind: "dataSource" }>,
  fetcher: PageFetcher,
): Promise<Record<string, unknown>[]> {
  let filter: Record<string, unknown> | undefined;
  if (Object.keys(plan.where ?? {}).length > 0) {
    try {
      filter = buildFilter(propertyTypes(await fetcher.dataSource(plan.dataSourceId)), plan.where);
    } catch (error) {
      // Without a schema, query everything and filter here. A real access problem shows up
      // again as the query's own error.
      if (!(error instanceof NotionApiError)) throw error;
    }
  }
  const pages = await fetcher.dataSourcePages(plan.dataSourceId, filter);
  return pages.filter((raw) => whereMatches(normalizePage(raw), plan.where, plan.wherePath));
}

/**
 * `where` of a data source target, compared with the page's property values. Throws a
 * config error for a property the data source does not have, or one `where` cannot compare.
 */
function whereMatches(
  page: PageModel,
  where: Record<string, string | number | boolean> | undefined,
  wherePath: string,
): boolean {
  for (const [name, expected] of Object.entries(where ?? {})) {
    const value = page.properties[name];
    if (value === undefined) {
      throw new CheckError(
        "config",
        `${joinPath(wherePath, name)}: the data source has no property "${name}"`,
      );
    }
    const matches = compare(value, expected);
    if (matches === undefined) {
      const type = value.type === "unsupported" ? value.apiType : value.type;
      throw new CheckError(
        "config",
        `${joinPath(wherePath, name)}: where cannot compare a ${type} property`,
      );
    }
    if (!matches) return false;
  }
  return true;
}

function compare(value: PropertyValue, expected: string | number | boolean): boolean | undefined {
  const text = String(expected);
  switch (value.type) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number":
      return value.text === text;
    case "select":
    case "status":
      return value.value === text;
    case "multi_select":
      return value.values.includes(text);
    case "number":
      return value.value !== null && value.value === Number(expected);
    case "checkbox":
      return value.checked === (expected === true || expected === "true");
    case "date":
      return value.start === text;
    case "people":
    case "relation": {
      const id = parseNotionId(text);
      if (id === undefined) return undefined;
      // A cut-short list may hold the ID beyond its 25 items; keep the page until it is complete.
      return (value.ids ?? []).includes(id) || value.hasMore;
    }
    default:
      return undefined;
  }
}

/** Map a thrown error to the JSON error result (exit code 2). */
export function toErrorResult(error: unknown): ErrorResult | undefined {
  if (error instanceof CheckError) {
    return {
      ok: false,
      error: {
        kind: error.kind,
        message: error.message,
        ...(error.code === undefined ? {} : { code: error.code }),
      },
    };
  }
  if (error instanceof NotionApiError) {
    return {
      ok: false,
      error: {
        kind: "api",
        message: error.message,
        ...(error.code === undefined ? {} : { code: error.code }),
      },
    };
  }
  return undefined;
}
