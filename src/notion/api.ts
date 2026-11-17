// @notionhq/client is CommonJS. Node 22 cannot see its named exports from ESM, so take the
// whole module.exports object as the default import.
import notionClient from "@notionhq/client";

/**
 * The Notion API version notion-lint is written against. From 2025-09-03, databases are
 * split into data sources and queries go to a data source ID.
 */
export const NOTION_VERSION = "2025-09-03";

/** One page of a paginated list endpoint, as the API returns it. */
export interface ListResponse {
  object: "list";
  results: unknown[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * The few Notion API calls notion-lint makes. Each method is exactly one HTTP request.
 * This is the seam for tests: they pass a fake that replays recorded responses, so no
 * network is needed. Pagination, rate limiting, and retries live above it, in `NotionFetcher`.
 */
export interface NotionApi {
  /** `GET /v1/pages/{page_id}` */
  retrievePage(args: { page_id: string }): Promise<unknown>;
  /** `GET /v1/blocks/{block_id}/children` */
  listBlockChildren(args: {
    block_id: string;
    start_cursor?: string;
    page_size?: number;
  }): Promise<ListResponse>;
  /** `POST /v1/data_sources/{data_source_id}/query` */
  queryDataSource(args: {
    data_source_id: string;
    start_cursor?: string;
    page_size?: number;
  }): Promise<ListResponse>;
}

/**
 * A `NotionApi` backed by `@notionhq/client`. The client's own retries are turned off
 * because `NotionFetcher` retries (with a bound and Retry-After) and rate-limits itself.
 */
export function createNotionApi(token: string): NotionApi {
  const client = new notionClient.Client({
    auth: token,
    notionVersion: NOTION_VERSION,
    retry: false,
    // Failures are reported by notion-lint itself, as JSON or text; the client's logs would repeat them.
    logger: () => {},
  });
  return {
    retrievePage: (args) => client.pages.retrieve(args),
    listBlockChildren: (args) =>
      client.blocks.children.list(args) as unknown as Promise<ListResponse>,
    queryDataSource: (args) => client.dataSources.query(args) as unknown as Promise<ListResponse>,
  };
}
