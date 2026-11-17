import type { ListResponse, NotionApi } from "./api.js";

/**
 * Fetching pages from Notion: pagination, recursive child blocks, rate limiting, and retries.
 * The results are still raw API JSON; `normalize` turns them into the internal representation.
 */

/** A raw block with its children (fetched recursively) attached. */
export interface RawBlockTree {
  block: Record<string, unknown>;
  children: RawBlockTree[];
}

/** What `check` needs from Notion. Tests can replace it as a whole. */
export interface PageFetcher {
  /** The page object (properties, URL, ...). */
  page(pageId: string): Promise<Record<string, unknown>>;
  /** Every page in a data source (all result pages of the query). */
  dataSourcePages(dataSourceId: string): Promise<Record<string, unknown>[]>;
  /** The page's blocks, with children fetched recursively. */
  blocks(pageId: string): Promise<RawBlockTree[]>;
}

/** A Notion API failure that is not retried (or ran out of retries). Never contains the token. */
export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

export interface FetcherOptions {
  /**
   * Minimum time between the starts of two requests. Notion allows about 3 requests per
   * second on average, so the default is 334 ms.
   */
  minIntervalMs?: number;
  /** Retries for one request after a 429 or a 5xx response. Default 5. */
  maxRetries?: number;
  /** Back-off base when the response has no Retry-After header. Default 1000 ms (doubles). */
  retryBaseMs?: number;
  /** Upper bound on a single wait before a retry. Default 60 s. */
  maxRetryDelayMs?: number;
  /** Clock and timer, replaceable in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Block types whose children are separate pages, not part of this page's body. */
const OTHER_PAGES = new Set(["child_page", "child_database"]);

const PAGE_SIZE = 100;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class NotionFetcher implements PageFetcher {
  readonly #api: NotionApi;
  readonly #minIntervalMs: number;
  readonly #maxRetries: number;
  readonly #retryBaseMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #nextStart = Number.NEGATIVE_INFINITY;

  constructor(api: NotionApi, options: FetcherOptions = {}) {
    this.#api = api;
    this.#minIntervalMs = options.minIntervalMs ?? 334;
    this.#maxRetries = options.maxRetries ?? 5;
    this.#retryBaseMs = options.retryBaseMs ?? 1000;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async page(pageId: string): Promise<Record<string, unknown>> {
    const page = await this.#request(`page ${pageId}`, () =>
      this.#api.retrievePage({ page_id: pageId }),
    );
    return asRecord(page);
  }

  async dataSourcePages(dataSourceId: string): Promise<Record<string, unknown>[]> {
    const results = await this.#paginate(`data source ${dataSourceId}`, (start_cursor) =>
      this.#api.queryDataSource({
        data_source_id: dataSourceId,
        page_size: PAGE_SIZE,
        ...(start_cursor === undefined ? {} : { start_cursor }),
      }),
    );
    // A query can also return data sources (wiki-style databases); only pages are checked.
    return results.map(asRecord).filter((item) => item.object === "page");
  }

  async blocks(pageId: string): Promise<RawBlockTree[]> {
    return this.#children(pageId);
  }

  async #children(blockId: string): Promise<RawBlockTree[]> {
    const results = await this.#paginate(`blocks of ${blockId}`, (start_cursor) =>
      this.#api.listBlockChildren({
        block_id: blockId,
        page_size: PAGE_SIZE,
        ...(start_cursor === undefined ? {} : { start_cursor }),
      }),
    );
    const trees: RawBlockTree[] = [];
    for (const item of results) {
      const block = asRecord(item);
      trees.push({ block, children: await this.#childrenOf(block) });
    }
    return trees;
  }

  async #childrenOf(block: Record<string, unknown>): Promise<RawBlockTree[]> {
    const type = block.type;
    if (typeof type !== "string" || OTHER_PAGES.has(type)) return [];
    // A synced block copy has no children of its own; its content lives under the original.
    if (type === "synced_block") {
      const from = (block.synced_block as { synced_from?: { block_id?: unknown } } | undefined)
        ?.synced_from?.block_id;
      if (typeof from === "string") return this.#children(from);
    }
    if (block.has_children !== true || typeof block.id !== "string") return [];
    return this.#children(block.id);
  }

  async #paginate(
    what: string,
    call: (cursor: string | undefined) => Promise<ListResponse>,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.#request(what, () => call(cursor));
      results.push(...response.results);
      cursor =
        response.has_more && response.next_cursor !== null ? response.next_cursor : undefined;
    } while (cursor !== undefined);
    return results;
  }

  /** One request: wait for the rate limit, then retry 429 / 5xx a bounded number of times. */
  async #request<T>(what: string, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.#throttle();
      try {
        return await call();
      } catch (error) {
        const delay = this.#retryDelay(error, attempt);
        if (delay === undefined || attempt >= this.#maxRetries) throw toApiError(error, what);
        await this.#sleep(delay);
      }
    }
  }

  async #throttle(): Promise<void> {
    const now = this.#now();
    const wait = this.#nextStart - now;
    if (wait > 0) await this.#sleep(wait);
    this.#nextStart = Math.max(now, this.#nextStart) + this.#minIntervalMs;
  }

  #retryDelay(error: unknown, attempt: number): number | undefined {
    const status = statusOf(error);
    if (status === undefined) return undefined;
    if (status !== 429 && !(status >= 500 && status <= 599)) return undefined;
    const retryAfter = status === 429 ? retryAfterMs(error, this.#now()) : undefined;
    const delay = retryAfter ?? this.#retryBaseMs * 2 ** attempt;
    return Math.min(delay, this.#maxRetryDelayMs);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new NotionApiError("Unexpected response from the Notion API", undefined, undefined);
  }
  return value as Record<string, unknown>;
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null) return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value = (get as (n: string) => unknown).call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return undefined;
}

/** Retry-After as delta-seconds or an HTTP date, in milliseconds. */
export function retryAfterMs(error: unknown, now: number): number | undefined {
  const value = readHeader((error as { headers?: unknown } | null)?.headers, "retry-after");
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const HINTS: Record<string, string> = {
  object_not_found:
    "Check the ID, and that the integration is connected to the page or data source (... > Connections)",
  unauthorized: "Check that NOTION_TOKEN holds a valid integration token",
  restricted_resource: "The integration lacks the capability to read this content",
  rate_limited: "Rate limited by Notion; retries ran out. Try again later",
};

function toApiError(error: unknown, what: string): NotionApiError {
  if (error instanceof NotionApiError) return error;
  const status = statusOf(error);
  const code = codeOf(error);
  const detail = error instanceof Error ? error.message : String(error);
  const hint = code === undefined ? undefined : HINTS[code];
  const parts = [`Notion API error for ${what}: ${detail}`];
  if (code !== undefined || status !== undefined) {
    parts.push(`(${[code, status].filter((p) => p !== undefined).join(", ")})`);
  }
  if (hint !== undefined) parts.push(`- ${hint}`);
  return new NotionApiError(parts.join(" "), status, code);
}
