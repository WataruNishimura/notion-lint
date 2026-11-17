import { describe, expect, it } from "vitest";
import type { ListResponse, NotionApi } from "../src/notion/api.js";
import { NotionApiError, NotionFetcher, type RawBlockTree } from "../src/notion/fetch.js";
import { FakeApiError, meetingNotes, replayFetcher } from "./notion-fake.js";

const list = (results: unknown[], next: string | null): ListResponse => ({
  object: "list",
  results,
  next_cursor: next,
  has_more: next !== null,
});

const block = (id: string, type: string, hasChildren = false, extra: object = {}) => ({
  object: "block",
  id,
  type,
  has_children: hasChildren,
  [type]: { rich_text: [], ...extra },
});

const unused = async (): Promise<never> => {
  throw new Error("not used");
};

/** A clock that only moves when the fetcher sleeps. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

const ids = (trees: RawBlockTree[]): unknown[] =>
  trees.map((t) => (t.children.length === 0 ? t.block.id : [t.block.id, ids(t.children)]));

describe("NotionFetcher", () => {
  it("follows next_cursor until has_more is false", async () => {
    const cursors: (string | undefined)[] = [];
    const pages: Record<string, ListResponse> = {
      start: list([block("a", "paragraph"), block("b", "paragraph")], "c"),
      c: list([block("c", "paragraph")], "d"),
      d: list([block("d", "paragraph")], null),
    };
    const api: NotionApi = {
      retrievePage: unused,
      retrieveBlock: unused,
      queryDataSource: unused,
      listBlockChildren: async ({ start_cursor, page_size }) => {
        expect(page_size).toBe(100);
        cursors.push(start_cursor);
        return pages[start_cursor ?? "start"] as ListResponse;
      },
    };
    const trees = await new NotionFetcher(api, { minIntervalMs: 0 }).blocks("page");
    expect(ids(trees)).toEqual(["a", "b", "c", "d"]);
    expect(cursors).toEqual([undefined, "c", "d"]);
  });

  it("fetches children recursively, follows synced blocks, and skips child pages", async () => {
    const children: Record<string, ListResponse> = {
      page: list(
        [
          block("toggle", "toggle", true),
          block("sub", "child_page", true, { title: "Sub page" }),
          block("copy", "synced_block", true, { synced_from: { block_id: "original" } }),
        ],
        null,
      ),
      toggle: list([block("inner", "paragraph")], null),
      original: list([block("synced-text", "paragraph")], null),
    };
    const requested: string[] = [];
    const api: NotionApi = {
      retrievePage: unused,
      retrieveBlock: unused,
      queryDataSource: unused,
      listBlockChildren: async ({ block_id }) => {
        requested.push(block_id);
        return children[block_id] as ListResponse;
      },
    };
    const trees = await new NotionFetcher(api, { minIntervalMs: 0 }).blocks("page");
    expect(ids(trees)).toEqual([["toggle", ["inner"]], "sub", ["copy", ["synced-text"]]]);
    expect(requested).toEqual(["page", "toggle", "original"]);
  });

  it("paginates a data source query and keeps only pages", async () => {
    const api: NotionApi = {
      retrievePage: unused,
      retrieveBlock: unused,
      listBlockChildren: unused,
      queryDataSource: async ({ start_cursor }) =>
        start_cursor === undefined
          ? list(
              [
                { object: "page", id: "p1" },
                { object: "data_source", id: "ds" },
              ],
              "p2",
            )
          : list([{ object: "page", id: "p2" }], null),
    };
    const pages = await new NotionFetcher(api, { minIntervalMs: 0 }).dataSourcePages("ds");
    expect(pages.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("retries 429 responses after the Retry-After delay", async () => {
    const clock = fakeClock();
    let calls = 0;
    const api: NotionApi = {
      listBlockChildren: unused,
      queryDataSource: unused,
      retrieveBlock: unused,
      retrievePage: async () => {
        calls++;
        if (calls <= 2) throw new FakeApiError(429, "rate_limited", { "Retry-After": "2" });
        return { object: "page", id: "p" };
      },
    };
    const fetcher = new NotionFetcher(api, { minIntervalMs: 0, ...clock });
    await expect(fetcher.page("p")).resolves.toMatchObject({ id: "p" });
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([2000, 2000]);
  });

  it("backs off exponentially without Retry-After, and gives up after maxRetries", async () => {
    const clock = fakeClock();
    let calls = 0;
    const api: NotionApi = {
      listBlockChildren: unused,
      queryDataSource: unused,
      retrieveBlock: unused,
      retrievePage: async () => {
        calls++;
        throw new FakeApiError(429, "rate_limited");
      },
    };
    const fetcher = new NotionFetcher(api, {
      minIntervalMs: 0,
      maxRetries: 3,
      retryBaseMs: 100,
      ...clock,
    });
    const error = await fetcher.page("p").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionApiError);
    expect(error).toMatchObject({ status: 429, code: "rate_limited" });
    expect(calls).toBe(4);
    expect(clock.sleeps).toEqual([100, 200, 400]);
  });

  it("does not retry other errors, and explains a page the integration cannot see", async () => {
    let calls = 0;
    const api: NotionApi = {
      listBlockChildren: unused,
      queryDataSource: unused,
      retrieveBlock: unused,
      retrievePage: async () => {
        calls++;
        throw new FakeApiError(404, "object_not_found");
      },
    };
    const error = await new NotionFetcher(api, { minIntervalMs: 0 })
      .page("p")
      .catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as Error).message).toContain("page p");
    expect((error as Error).message).toContain("Connections");
  });

  it("keeps about 3 requests per second", async () => {
    const clock = fakeClock();
    const api: NotionApi = {
      listBlockChildren: unused,
      queryDataSource: unused,
      retrieveBlock: unused,
      retrievePage: async ({ page_id }) => ({ object: "page", id: page_id }),
    };
    const fetcher = new NotionFetcher(api, clock);
    for (const id of ["a", "b", "c", "d"]) await fetcher.page(id);
    expect(clock.sleeps).toEqual([334, 334, 334]);
  });

  it("reads a recorded page whose blocks span two result pages", async () => {
    const calls: string[] = [];
    const trees = await replayFetcher(meetingNotes, calls).blocks(meetingNotes.ids.pageOk);
    expect(trees).toHaveLength(10);
    expect(calls.filter((c) => c.includes("start_cursor"))).toHaveLength(1);
  });
});
