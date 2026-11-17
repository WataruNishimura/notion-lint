import { createNotionApi } from "../notion/api.js";
import { NotionFetcher, type PageFetcher } from "../notion/fetch.js";
import type { Config } from "../schema/config.js";
import type { CheckResult, ErrorResult } from "../schema/result.js";
import { planCheck, runCheck, toErrorResult } from "./index.js";

export interface CheckDeps {
  /** Environment variables. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Builds the fetcher from the token. Defaults to the real Notion API. */
  createFetcher?: (token: string) => PageFetcher;
}

const defaultFetcher = (token: string): PageFetcher => new NotionFetcher(createNotionApi(token));

/**
 * Run `check` for a loaded config. Returns the check result, or an error result for a usage,
 * config, or Notion API error (exit code 2). The token is read from NOTION_TOKEN and is never
 * written to the output.
 */
export async function check(
  config: Config,
  pages: string[],
  deps: CheckDeps = {},
): Promise<CheckResult | ErrorResult> {
  try {
    const plans = planCheck(config, pages);
    const token = (deps.env ?? process.env).NOTION_TOKEN?.trim();
    if (token === undefined || token === "") {
      return {
        ok: false,
        error: {
          kind: "api",
          code: "missing_token",
          message:
            "NOTION_TOKEN is not set. Set it to the token of a Notion integration that is connected to the pages to check",
        },
      };
    }
    const fetcher = (deps.createFetcher ?? defaultFetcher)(token);
    return await runCheck(plans, fetcher);
  } catch (error) {
    const result = toErrorResult(error);
    if (result === undefined) throw error;
    return result;
  }
}
