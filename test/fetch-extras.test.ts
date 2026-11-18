import { describe, expect, it } from "vitest";
import { CheckError, planCheck, runCheck } from "../src/check/index.js";
import { compareFiles, compareRollup } from "../src/check/where.js";
import { normalizeProperty } from "../src/normalize/index.js";
import type { PropertyValue } from "../src/normalize/model.js";
import type { NotionApi } from "../src/notion/api.js";
import { NotionApiError, NotionFetcher } from "../src/notion/fetch.js";
import { buildFilter, propertyTypes, resultShapes } from "../src/notion/filter.js";
import { parseNotionId } from "../src/notion/id.js";
import type { Config } from "../src/schema/config.js";
import type { CheckResult } from "../src/schema/result.js";
import { readFixtureJson, runCli } from "./helpers.js";
import {
  FakeApiError,
  type RecordedQuery,
  type Recording,
  replayApi,
  replayFetcher,
} from "./notion-fake.js";

type Where = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------------------------
// where on formula, rollup and files

const whereTypes = readFixtureJson("notion/where-types.json") as Recording & {
  ids: { dataSource: string; alpha: string; beta: string; gamma: string };
};
const { dataSource, alpha, beta, gamma } = whereTypes.ids;
const schema = whereTypes.responses[`GET /v1/data_sources/${dataSource}`] as Record<
  string,
  unknown
>;
const types = propertyTypes(schema);
const pages = whereTypes.responses[`POST /v1/data_sources/${dataSource}/query`] as {
  results: Record<string, unknown>[];
}[];
const samples = pages[0]?.results ?? [];

/** Every page that is in scope violates this type once, so in-scope pages show up with a violation. */
const strict = { properties: { Name: { type: "title", pattern: "^Z" } } };

async function check(
  where: Where | undefined,
  rec: Recording = whereTypes,
  fetcher = replayFetcher(rec, calls(), queries()),
) {
  const config = {
    targets: [{ dataSource, ...(where === undefined ? {} : { where }), type: strict }],
  } as unknown as Config;
  return runCheck(planCheck(config, []), fetcher);
}

// Small helpers so each test can read what was requested.
let recordedCalls: string[] = [];
let recordedQueries: RecordedQuery[] = [];
const calls = () => {
  recordedCalls = [];
  return recordedCalls;
};
const queries = () => {
  recordedQueries = [];
  return recordedQueries;
};

const ids = (result: CheckResult) => result.pages.map((p) => p.pageId);
const violations = (result: CheckResult) => result.pages.map((p) => p.violations.length);

/** A copy of the recording with its pages changed, for the fallback cases. */
function withPages(change: (page: Record<string, unknown>) => void): Recording {
  const copy = structuredClone(whereTypes);
  for (const [key, value] of Object.entries(copy.responses)) {
    if (!key.startsWith("POST ")) continue;
    for (const list of value as { results: Record<string, unknown>[] }[]) {
      for (const page of list.results) change(page);
    }
  }
  return copy;
}

const property = (page: Record<string, unknown>, name: string) =>
  (page.properties as Record<string, Record<string, unknown>>)[name] as Record<string, unknown>;

describe("where on formula, rollup and files: server filter and local result", () => {
  // [where, filter sent to the server, pages the check keeps]
  const cases: [string, Where, Record<string, unknown>, string[]][] = [
    [
      "formula number",
      { Cost: 12 },
      { property: "Cost", formula: { number: { equals: 12 } } },
      [alpha, gamma],
    ],
    [
      "formula number given as text",
      { Cost: "30" },
      { property: "Cost", formula: { number: { equals: 30 } } },
      [beta],
    ],
    [
      "formula string",
      { Label: "ready" },
      { property: "Label", formula: { string: { equals: "ready" } } },
      [alpha, gamma],
    ],
    [
      "formula boolean (the recorded server result also holds Gamma, which local drops)",
      { Shipped: true },
      { property: "Shipped", formula: { checkbox: { equals: true } } },
      [alpha],
    ],
    [
      "formula date",
      { Review: "2026-12-01" },
      { property: "Review", formula: { date: { equals: "2026-12-01" } } },
      [alpha, gamma],
    ],
    [
      "rollup number",
      { Hours: 8 },
      { property: "Hours", rollup: { number: { equals: 8 } } },
      [alpha, gamma],
    ],
    [
      "rollup date",
      { Milestone: "2026-12-24" },
      { property: "Milestone", rollup: { date: { equals: "2026-12-24" } } },
      [alpha],
    ],
    [
      "rollup array of select (any item equals)",
      { Tags: "api" },
      { property: "Tags", rollup: { any: { select: { equals: "api" } } } },
      [alpha, gamma],
    ],
    [
      "rollup array of select, no recorded server result (all pages come back)",
      { Tags: "ux" },
      { property: "Tags", rollup: { any: { select: { equals: "ux" } } } },
      [beta],
    ],
    [
      "rollup array of title (filtered as rich_text)",
      { Tasks: "Task A" },
      { property: "Tasks", rollup: { any: { rich_text: { equals: "Task A" } } } },
      [alpha, gamma],
    ],
    [
      "files true: has at least one file",
      { Attachments: true },
      { property: "Attachments", files: { is_not_empty: true } },
      [alpha, gamma],
    ],
    [
      "files false: is empty",
      { Attachments: false },
      { property: "Attachments", files: { is_empty: true } },
      [beta],
    ],
    [
      "files by name: the server narrows to non-empty, local matches the name",
      { Attachments: "notes.md" },
      { property: "Attachments", files: { is_not_empty: true } },
      [alpha],
    ],
  ];

  it.each(cases)("%s", async (_name, where, filter, kept) => {
    const result = await check(where);
    // Formulas and rollups first need a sample query to learn what they yield; files do not.
    const sampled = "files" in filter ? [] : [undefined];
    expect(recordedQueries.map((q) => q.filter)).toEqual([...sampled, filter]);
    expect(ids(result)).toEqual(kept);
    // In scope: the page violates the strict type. Out of scope: it is not reported at all.
    expect(violations(result)).toEqual(kept.map(() => 1));
  });

  it("builds the filters from the schema and the shape of the sample pages", () => {
    const shapes = resultShapes(types, { Cost: 1, Tags: "x", Hours: 1, Review: "d" }, samples);
    expect([...shapes.entries()]).toEqual([
      ["Cost", { kind: "formula", result: "number" }],
      ["Tags", { kind: "rollup", result: "array", item: "select" }],
      ["Hours", { kind: "rollup", result: "number" }],
      ["Review", { kind: "formula", result: "date" }],
    ]);
    expect(buildFilter(types, { Cost: 12, Attachments: true }, shapes)).toEqual({
      and: [
        { property: "Cost", formula: { number: { equals: 12 } } },
        { property: "Attachments", files: { is_not_empty: true } },
      ],
    });
  });

  it("reads the sample once per data source, across targets", async () => {
    const callList = calls();
    const config = {
      targets: [
        { dataSource, where: { Cost: 12 }, type: strict },
        { dataSource, where: { Label: "draft" }, type: strict },
      ],
    } as unknown as Config;
    await runCheck(planCheck(config, []), replayFetcher(whereTypes, callList, queries()));
    // One sample, then one filtered query per target.
    expect(recordedQueries.map((q) => q.filter)).toEqual([
      undefined,
      { property: "Cost", formula: { number: { equals: 12 } } },
      { property: "Label", formula: { string: { equals: "draft" } } },
    ]);
  });

  it("needs no sample for files, and none without a formula or rollup", async () => {
    await check({ Attachments: true });
    expect(recordedQueries.map((q) => q.filter)).toEqual([
      { property: "Attachments", files: { is_not_empty: true } },
    ]);
    await check(undefined);
    expect(recordedQueries).toEqual([{ dataSource, filter: undefined }]);
  });

  describe("fallbacks to the local check", () => {
    it("takes the shape from a later page when the first one shows none", async () => {
      // Alpha's array is empty, so Beta shows the item type.
      const rec = withPages((page) => {
        if (page.id === alpha) (property(page, "Tags").rollup as { array: unknown[] }).array = [];
      });
      const result = await check({ Tags: "ux" }, rec);
      expect(recordedQueries[1]?.filter).toEqual({
        property: "Tags",
        rollup: { any: { select: { equals: "ux" } } },
      });
      expect(ids(result)).toEqual([beta]);
    });

    it("filters locally when no sample page shows the item type", async () => {
      const rec = withPages((page) => {
        (property(page, "Tags").rollup as { array: unknown[] }).array = [];
      });
      const result = await check({ Tags: "api" }, rec);
      expect(recordedQueries.map((q) => q.filter)).toEqual([undefined, undefined]);
      expect(ids(result)).toEqual([]);
    });

    it("filters locally for a rollup that is incomplete", async () => {
      const rec = withPages((page) => {
        property(page, "Hours").rollup = { type: "incomplete", incomplete: {}, function: "sum" };
      });
      const result = await check({ Hours: 8 }, rec);
      expect(recordedQueries[1]?.filter).toBeUndefined();
      expect(ids(result)).toEqual([]);
    });

    it("filters locally for a value the result type cannot take", async () => {
      // Cost yields numbers and Review dates; "abc" and "soon" cannot be sent as such.
      const number = await check({ Cost: "abc" });
      expect(recordedQueries[1]?.filter).toBeUndefined();
      expect(ids(number)).toEqual([]);
      const date = await check({ Review: "soon" });
      expect(recordedQueries[1]?.filter).toBeUndefined();
      expect(ids(date)).toEqual([]);
    });

    it("sends the translatable conditions and keeps the rest local", async () => {
      // Label is translated; Review "soon" is not, and nothing equals it locally.
      const result = await check({ Label: "ready", Review: "soon" });
      expect(recordedQueries[1]?.filter).toEqual({
        property: "Label",
        formula: { string: { equals: "ready" } },
      });
      expect(ids(result)).toEqual([]);
    });

    it("repeats the query without the filter when Notion rejects it (400)", async () => {
      const callList = calls();
      const queryList = queries();
      const inner = replayApi(whereTypes, callList, queryList);
      const api: NotionApi = {
        ...inner,
        queryDataSource: async (args) => {
          if (args.filter !== undefined) throw new FakeApiError(400, "validation_error");
          return inner.queryDataSource(args);
        },
      };
      const result = await check(
        { Cost: 12 },
        whereTypes,
        new NotionFetcher(api, { minIntervalMs: 0 }),
      );
      expect(ids(result)).toEqual([alpha, gamma]);
    });
  });
});

describe("normalized formula, rollup and files values", () => {
  const norm = (value: Record<string, unknown>) => normalizeProperty({ id: "x", ...value });

  it("reads each formula result type", () => {
    expect(norm({ type: "formula", formula: { type: "string", string: "a" } })).toEqual({
      type: "formula",
      result: "string",
      value: "a",
    });
    expect(norm({ type: "formula", formula: { type: "number", number: null } })).toEqual({
      type: "formula",
      result: "number",
      value: null,
    });
    expect(norm({ type: "formula", formula: { type: "boolean", boolean: true } })).toEqual({
      type: "formula",
      result: "boolean",
      value: true,
    });
    expect(
      norm({
        type: "formula",
        formula: { type: "date", date: { start: "2026-12-01", end: null } },
      }),
    ).toEqual({ type: "formula", result: "date", value: "2026-12-01" });
  });

  it("reads rollup numbers, dates, arrays of values, and incomplete results", () => {
    expect(norm({ type: "rollup", rollup: { type: "number", number: 3 } })).toEqual({
      type: "rollup",
      result: "number",
      value: 3,
    });
    expect(
      norm({ type: "rollup", rollup: { type: "date", date: { start: "2026-12-24", end: null } } }),
    ).toEqual({ type: "rollup", result: "date", value: "2026-12-24" });
    expect(
      norm({
        type: "rollup",
        rollup: { type: "array", array: [{ type: "select", select: { name: "api" } }] },
      }),
    ).toEqual({
      type: "rollup",
      result: "array",
      items: [{ type: "select", value: "api" }],
      hasMore: false,
    });
    expect(norm({ type: "rollup", rollup: { type: "incomplete", incomplete: {} } })).toEqual({
      type: "rollup",
      result: "incomplete",
    });
  });

  it("keeps file names", () => {
    expect(norm({ type: "files", files: [{ name: "a.pdf" }, { name: "b.md" }] })).toEqual({
      type: "files",
      count: 2,
      hasMore: false,
      names: ["a.pdf", "b.md"],
    });
  });
});

describe("local comparison of files and rollup", () => {
  const files = (names: string[], hasMore = false): PropertyValue => ({
    type: "files",
    count: names.length,
    hasMore,
    names,
  });
  const countValue = (value: PropertyValue) => value as Extract<PropertyValue, { count: number }>;

  it("compares files as empty / not empty, or by name", () => {
    const some = countValue(files(["a.pdf"]));
    const none = countValue(files([]));
    expect(compareFiles(some, true)).toBe(true);
    expect(compareFiles(some, false)).toBe(false);
    expect(compareFiles(none, true)).toBe(false);
    expect(compareFiles(none, false)).toBe(true);
    expect(compareFiles(some, "a.pdf")).toBe(true);
    expect(compareFiles(some, "b.pdf")).toBe(false);
    // A name list that may be cut short keeps the page until its full value is read.
    expect(compareFiles(countValue(files(["a.pdf"], true)), "z.pdf")).toBe(true);
  });

  it("keeps a rollup array that may be cut short, and never matches an incomplete rollup", () => {
    const item = (): ((v: PropertyValue, e: string | number | boolean) => boolean) => () => false;
    const array = (hasMore: boolean): PropertyValue => ({
      type: "rollup",
      result: "array",
      items: [],
      hasMore,
    });
    expect(compareRollup(array(true) as never, "x", item())).toBe(true);
    expect(compareRollup(array(false) as never, "x", item())).toBe(false);
    expect(compareRollup({ type: "rollup", result: "incomplete" }, "x", item())).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// database URL or ID to data source ID

const databases = readFixtureJson("notion/database-targets.json") as Recording & {
  ids: Record<
    "db" | "ds" | "multiDb" | "multiDsA" | "multiDsB" | "emptyDb" | "one" | "two",
    string
  >;
};
const t = databases.ids;
const hex = (id: string) => id.replace(/-/g, "");
const view = "0123456789abcdef0123456789abcdef";

async function checkTargets(
  targets: { dataSource: string; where?: Where }[],
  callList: string[] = [],
  queryList: RecordedQuery[] = [],
) {
  const config = {
    targets: targets.map((target) => ({ ...target, type: { name: "task" } })),
  } as unknown as Config;
  return runCheck(planCheck(config, []), replayFetcher(databases, callList, queryList));
}

describe("database URL or ID as a data source target", () => {
  it("uses a data source ID as it is, without a database lookup", async () => {
    const callList: string[] = [];
    const result = await checkTargets([{ dataSource: t.ds }], callList);
    expect(ids(result)).toEqual([t.one, t.two]);
    expect(callList).toEqual([`POST /v1/data_sources/${t.ds}/query`]);
  });

  it("resolves a database ID with one data source", async () => {
    const callList: string[] = [];
    const result = await checkTargets([{ dataSource: t.db }], callList);
    expect(ids(result)).toEqual([t.one, t.two]);
    // First as a data source (404), then as a database, then the data source's query.
    expect(callList).toEqual([
      `POST /v1/data_sources/${t.db}/query`,
      `GET /v1/databases/${t.db}`,
      `POST /v1/data_sources/${t.ds}/query`,
    ]);
  });

  it.each([
    [
      "with a workspace slug, a title prefix and a view parameter",
      `https://www.notion.so/my-team/Tasks-${hex(t.db)}?v=${view}&pvs=4`,
    ],
    ["without dashes and without a slug", `https://www.notion.so/${hex(t.db)}?v=${view}`],
    ["with dashes", `https://www.notion.so/${t.db}`],
    ["on notion.site", `https://my-team.notion.site/Tasks-${hex(t.db)}?v=${view}`],
    [
      "with a peeked row (?p= is not the database)",
      `https://www.notion.so/Tasks-${hex(t.db)}?v=${view}&p=${hex(t.one)}&pm=s`,
    ],
    ["as a bare ID without dashes", hex(t.db)],
  ])("accepts a database URL %s", async (_name, input) => {
    const result = await checkTargets([{ dataSource: input }]);
    expect(ids(result)).toEqual([t.one, t.two]);
  });

  it("accepts a data source URL too, without a database lookup", async () => {
    const callList: string[] = [];
    await checkTargets(
      [{ dataSource: `https://www.notion.so/team/Tasks-${hex(t.ds)}?v=${view}` }],
      callList,
    );
    expect(callList.some((c) => c.startsWith("GET /v1/databases/"))).toBe(false);
  });

  it("resolves once per run, however many targets name the database", async () => {
    const callList: string[] = [];
    const result = await checkTargets(
      [{ dataSource: t.db }, { dataSource: `https://www.notion.so/Tasks-${hex(t.db)}?v=${view}` }],
      callList,
    );
    expect(ids(result)).toEqual([t.one, t.two, t.one, t.two]);
    expect(callList.filter((c) => c === `GET /v1/databases/${t.db}`)).toHaveLength(1);
    expect(callList.filter((c) => c === `POST /v1/data_sources/${t.db}/query`)).toHaveLength(1);
  });

  it("sends where to the resolved data source", async () => {
    const queryList: RecordedQuery[] = [];
    const result = await checkTargets(
      [{ dataSource: t.db, where: { Status: "Final" } }],
      [],
      queryList,
    );
    expect(ids(result)).toEqual([t.one]);
    expect(queryList.at(-1)).toEqual({
      dataSource: t.ds,
      filter: { property: "Status", status: { equals: "Final" } },
    });
  });

  it("fails with the candidates when the database has several data sources", async () => {
    const error = await checkTargets([{ dataSource: t.multiDb }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckError);
    const { kind, code, message } = error as CheckError;
    expect([kind, code]).toEqual(["config", "ambiguous_database"]);
    expect(message).toContain("targets[0].dataSource:");
    expect(message).toContain(`Backlog: ${t.multiDsA}`);
    expect(message).toContain(`Archive: ${t.multiDsB}`);
  });

  it("exits with code 2 and lists the data sources on the command line", async () => {
    const config = JSON.stringify({
      targets: [
        { dataSource: t.ds, type: { name: "task" } },
        {
          dataSource: `https://www.notion.so/Planning-${hex(t.multiDb)}?v=${view}`,
          type: { name: "task" },
        },
      ],
    });
    const result = await runCli(["--config-json", config, "--format", "json"], {
      env: { NOTION_TOKEN: "secret_test_token_value" },
      createFetcher: () => replayFetcher(databases),
    });
    expect(result.code).toBe(2);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { kind: string; code: string; message: string };
    };
    expect(output.ok).toBe(false);
    expect(output.error).toMatchObject({ kind: "config", code: "ambiguous_database" });
    expect(output.error.message).toContain("targets[1].dataSource:");
    expect(output.error.message).toContain(`Backlog: ${t.multiDsA}`);
    expect(output.error.message).toContain(`Archive: ${t.multiDsB}`);
  });

  it("fails when the database has no data source", async () => {
    const error = await checkTargets([{ dataSource: t.emptyDb }]).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "config", code: "no_data_source" });
  });

  it("reports the first error when the ID is neither a data source nor a database", async () => {
    const unknown = "9a8b7c6d-5e4f-8a1b-b2c3-0000000000ff";
    const error = await checkTargets([{ dataSource: unknown }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).message).toContain(`data source ${unknown}`);
    expect((error as NotionApiError).code).toBe("object_not_found");
  });
});

describe("parseNotionId for databases", () => {
  it("ignores the view parameter, and the peeked page when peek is false", () => {
    const url = `https://www.notion.so/my-team/Tasks-${hex(t.db)}?v=${view}&p=${hex(t.one)}`;
    expect(parseNotionId(url, { peek: false })).toBe(t.db);
    expect(parseNotionId(url)).toBe(t.one);
    expect(parseNotionId(`https://www.notion.so/${hex(t.db)}?v=${view}`)).toBe(t.db);
  });
});
