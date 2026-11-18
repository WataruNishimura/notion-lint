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

/** A query a fake API received: the data source and the filter it was sent (if any). */
export interface RecordedQuery {
  dataSource: string;
  filter: unknown;
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
export function replayApi(
  recording: Recording,
  calls: string[] = [],
  queries: RecordedQuery[] = [],
): NotionApi {
  const one = (key: string): unknown => {
    calls.push(key);
    const response = recording.responses[key];
    if (response === undefined) throw new FakeApiError(404, "object_not_found");
    return structuredClone(response);
  };
  const list = (key: string, cursor: string | undefined, logKey = key): ListResponse => {
    calls.push(cursor === undefined ? logKey : `${logKey}?start_cursor=${cursor}`);
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
    retrieveBlock: async ({ block_id }) => one(`GET /v1/blocks/${block_id}`),
    listBlockChildren: async ({ block_id, start_cursor }) =>
      list(`GET /v1/blocks/${block_id}/children`, start_cursor),
    // A query with a filter replays `POST .../query <filter as JSON>` when the recording has
    // one (the pages the server would return), else the unfiltered result.
    queryDataSource: async ({ data_source_id, filter, start_cursor }) => {
      queries.push({ dataSource: data_source_id, filter });
      const base = `POST /v1/data_sources/${data_source_id}/query`;
      const filtered = `${base} ${JSON.stringify(filter)}`;
      return list(
        filter !== undefined && recording.responses[filtered] !== undefined ? filtered : base,
        start_cursor,
        base,
      );
    },
    retrieveDataSource: async ({ data_source_id }) => one(`GET /v1/data_sources/${data_source_id}`),
    retrieveDatabase: async ({ database_id }) => one(`GET /v1/databases/${database_id}`),
    // `GET /v1/pages/<id>/properties/<property id>` replays like any list endpoint.
    retrievePropertyItem: async ({ page_id, property_id, start_cursor }) =>
      list(`GET /v1/pages/${page_id}/properties/${property_id}`, start_cursor),
  };
}

/** A fetcher over a recording, without rate-limit waits. */
export function replayFetcher(
  recording: Recording = meetingNotes,
  calls: string[] = [],
  queries: RecordedQuery[] = [],
) {
  return new NotionFetcher(replayApi(recording, calls, queries), { minIntervalMs: 0 });
}
