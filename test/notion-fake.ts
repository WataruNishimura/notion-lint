import type { ListResponse, NotionApi } from "../src/notion/api.js";
import { NotionFetcher } from "../src/notion/fetch.js";
import { readFixtureJson } from "./helpers.js";

/**
 * A recording of Notion API responses: `"GET /v1/pages/<id>"` maps to one response,
 * list endpoints map to their result pages in order (chained by `next_cursor`).
 */
export interface Recording {
  responses: Record<string, unknown>;
}

export const meetingNotes = readFixtureJson("notion/meeting-notes.json") as Recording & {
  ids: { dataSource: string; pageOk: string; pageBad: string; pageOrder: string };
};

/** An API error shaped like `@notionhq/client`'s APIResponseError. */
export class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(`fake ${status} ${code}`);
  }
}

/** Replays a recording. Unknown requests fail like the real API does (404 object_not_found). */
export function replayApi(recording: Recording, calls: string[] = []): NotionApi {
  const one = (key: string): unknown => {
    calls.push(key);
    const response = recording.responses[key];
    if (response === undefined) throw new FakeApiError(404, "object_not_found");
    return structuredClone(response);
  };
  const list = (key: string, cursor: string | undefined): ListResponse => {
    calls.push(cursor === undefined ? key : `${key}?start_cursor=${cursor}`);
    const pages = recording.responses[key] as ListResponse[] | undefined;
    if (pages === undefined) throw new FakeApiError(404, "object_not_found");
    const index =
      cursor === undefined ? 0 : pages.findIndex((_, i) => pages[i - 1]?.next_cursor === cursor);
    const page = pages[index];
    if (page === undefined) throw new FakeApiError(400, "validation_error");
    return structuredClone(page);
  };
  return {
    retrievePage: async ({ page_id }) => one(`GET /v1/pages/${page_id}`),
    listBlockChildren: async ({ block_id, start_cursor }) =>
      list(`GET /v1/blocks/${block_id}/children`, start_cursor),
    queryDataSource: async ({ data_source_id, start_cursor }) =>
      list(`POST /v1/data_sources/${data_source_id}/query`, start_cursor),
  };
}

/** A fetcher over a recording, without rate-limit waits. */
export function replayFetcher(recording: Recording = meetingNotes, calls: string[] = []) {
  return new NotionFetcher(replayApi(recording, calls), { minIntervalMs: 0 });
}
