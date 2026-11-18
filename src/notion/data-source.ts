import { NotionApiError, type PageFetcher } from "./fetch.js";

/**
 * A `dataSource` target can name a data source or, as people often copy from the address bar,
 * a database. Since API version 2025-09-03 they have different IDs and queries only accept a
 * data source ID. `DataSourceResolver` finds out which one it was given.
 *
 * Detection order: the ID is first used as a data source ID, which is what the config asks for,
 * so a data source ID costs no extra request. Only when Notion answers that no such data source
 * exists (404, or 400 for an ID of another object kind) is it read as a database
 * (`GET /v1/databases/{id}`): one data source means that one is used, several mean the user has
 * to pick and `DataSourceChoiceError` lists them. When the database cannot be read either, the
 * first error is thrown, because that is the one for the ID the user wrote.
 */

/** A data source of a database. */
export interface DataSourceChoice {
  id: string;
  name: string;
}

/** The ID names a database with several data sources, or with none. */
export class DataSourceChoiceError extends Error {
  constructor(
    readonly databaseId: string,
    readonly candidates: DataSourceChoice[],
  ) {
    super(
      candidates.length === 0
        ? `the database ${databaseId} has no data source that this integration can read`
        : `the database ${databaseId} has ${candidates.length} data sources. Set dataSource to the ID of one of them:\n${candidates
            .map((c) => `  - ${c.name === "" ? "(untitled)" : c.name}: ${c.id}`)
            .join("\n")}`,
    );
    this.name = "DataSourceChoiceError";
  }
}

export class DataSourceResolver {
  readonly #fetcher: PageFetcher;
  /** ID as written to the data source ID it stands for, for the whole run. */
  readonly #resolved = new Map<string, string>();

  constructor(fetcher: PageFetcher) {
    this.#fetcher = fetcher;
  }

  /**
   * Run `use` with the data source ID for `id`. Whatever `use` throws is passed on, except
   * a 404 / 400 on the first try, which sends the ID through the database lookup. `use` may
   * therefore run twice; it must not have effects that cannot be repeated.
   */
  async use<T>(id: string, use: (dataSourceId: string) => Promise<T>): Promise<T> {
    const known = this.#resolved.get(id);
    if (known !== undefined) return use(known);
    try {
      const result = await use(id);
      this.#resolved.set(id, id);
      return result;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const dataSourceId = await this.#fromDatabase(id, error);
      const result = await use(dataSourceId);
      this.#resolved.set(id, dataSourceId);
      return result;
    }
  }

  async #fromDatabase(id: string, original: NotionApiError): Promise<string> {
    let database: Record<string, unknown>;
    try {
      database = await this.#fetcher.database(id);
    } catch (error) {
      if (error instanceof NotionApiError) throw original;
      throw error;
    }
    const candidates = dataSourcesOf(database);
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only === undefined) throw new DataSourceChoiceError(id, candidates);
    return only.id;
  }
}

function isNotFound(error: unknown): error is NotionApiError {
  return error instanceof NotionApiError && (error.status === 404 || error.status === 400);
}

function dataSourcesOf(database: Record<string, unknown>): DataSourceChoice[] {
  const list = database.data_sources;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): DataSourceChoice[] => {
    const { id, name } = (item ?? {}) as { id?: unknown; name?: unknown };
    return typeof id === "string" ? [{ id, name: typeof name === "string" ? name : "" }] : [];
  });
}
