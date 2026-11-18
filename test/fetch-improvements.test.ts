import { describe, expect, it } from "vitest";
import { planCheck, runCheck } from "../src/check/index.js";
import { buildFilter, propertyTypes } from "../src/notion/filter.js";
import type { Config } from "../src/schema/config.js";
import type { CheckResult } from "../src/schema/result.js";
import { readFixtureJson } from "./helpers.js";
import { type RecordedQuery, type Recording, replayFetcher } from "./notion-fake.js";

const recording = readFixtureJson("notion/data-source-filter.json") as Recording & {
  ids: {
    dataSource: string;
    alpha: string;
    beta: string;
    gamma: string;
    propertyIds: Record<string, string>;
    ownerBeyond25: string;
  };
};
const { dataSource, alpha, beta, gamma, propertyIds, ownerBeyond25 } = recording.ids;
const schema = recording.responses[`GET /v1/data_sources/${dataSource}`] as Record<string, unknown>;
const types = propertyTypes(schema);

type Where = Record<string, string | number | boolean>;

async function check(
  type: Record<string, unknown>,
  where?: Where,
  rec: Recording = recording,
): Promise<{ result: CheckResult; calls: string[]; queries: RecordedQuery[] }> {
  const calls: string[] = [];
  const queries: RecordedQuery[] = [];
  const config = {
    targets: [{ dataSource, ...(where === undefined ? {} : { where }), type }],
  } as unknown as Config;
  const result = await runCheck(planCheck(config, []), replayFetcher(rec, calls, queries));
  return { result, calls, queries };
}

const ids = (result: CheckResult) => result.pages.map((p) => p.pageId);

describe("buildFilter", () => {
  it("builds a condition for each supported property type", () => {
    const filter = (where: Where) => buildFilter(types, where);
    expect(filter({ Status: "Final" })).toEqual({
      property: "Status",
      status: { equals: "Final" },
    });
    expect(filter({ Kind: "RFC" })).toEqual({ property: "Kind", select: { equals: "RFC" } });
    expect(filter({ Tags: "api" })).toEqual({
      property: "Tags",
      multi_select: { contains: "api" },
    });
    expect(filter({ Done: true })).toEqual({ property: "Done", checkbox: { equals: true } });
    expect(filter({ Done: "false" })).toEqual({ property: "Done", checkbox: { equals: false } });
    expect(filter({ Name: "Alpha spec" })).toEqual({
      property: "Name",
      title: { equals: "Alpha spec" },
    });
    expect(filter({ Notes: "n" })).toEqual({ property: "Notes", rich_text: { equals: "n" } });
    expect(filter({ Points: 8 })).toEqual({ property: "Points", number: { equals: 8 } });
    expect(filter({ Points: "8" })).toEqual({ property: "Points", number: { equals: 8 } });
    expect(filter({ Due: "2026-11-04" })).toEqual({
      property: "Due",
      date: { equals: "2026-11-04" },
    });
    expect(filter({ Owners: ownerBeyond25 })).toEqual({
      property: "Owners",
      people: { contains: ownerBeyond25 },
    });
    expect(filter({ Related: "6e4a1c3d0000400080000000000000a1" })).toEqual({
      property: "Related",
      relation: { contains: "6e4a1c3d-0000-4000-8000-0000000000a1" },
    });
  });

  it("combines several conditions with and", () => {
    expect(buildFilter(types, { Status: "Final", Done: true })).toEqual({
      and: [
        { property: "Status", status: { equals: "Final" } },
        { property: "Done", checkbox: { equals: true } },
      ],
    });
  });

  it("leaves out conditions it cannot translate", () => {
    // Unknown property, a formula without a known result type, and values of the wrong shape.
    expect(buildFilter(types, { Missing: "x" })).toBeUndefined();
    expect(buildFilter(types, { Score: 1 })).toBeUndefined();
    expect(buildFilter(types, { Points: "n/a" })).toBeUndefined();
    expect(buildFilter(types, { Due: "next week" })).toBeUndefined();
    expect(buildFilter(types, { Owners: "Aki" })).toBeUndefined();
    expect(buildFilter(types, undefined)).toBeUndefined();
    expect(buildFilter(undefined, { Status: "Final" })).toBeUndefined();
    // The translatable part stays.
    expect(buildFilter(types, { Status: "Final", Points: "n/a", Missing: 1 })).toEqual({
      property: "Status",
      status: { equals: "Final" },
    });
  });
});

describe("server-side where", () => {
  const type = { name: "spec" };

  it("sends the filter and reads the schema once", async () => {
    const { result, calls, queries } = await check(type, { Status: "Final" });
    expect(queries).toEqual([
      { dataSource, filter: { property: "Status", status: { equals: "Final" } } },
    ]);
    expect(ids(result)).toEqual([alpha, gamma]);
    expect(calls.filter((c) => c === `GET /v1/data_sources/${dataSource}`)).toHaveLength(1);
  });

  it("reads the schema once for several targets on the same data source", async () => {
    const calls: string[] = [];
    const config = {
      targets: [
        { dataSource, where: { Status: "Final" }, type },
        { dataSource, where: { Status: "Final", Done: true }, type },
      ],
    } as unknown as Config;
    await runCheck(planCheck(config, []), replayFetcher(recording, calls));
    expect(calls.filter((c) => c === `GET /v1/data_sources/${dataSource}`)).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(2);
  });

  it("still applies every condition to the pages the server returns", async () => {
    // The recorded server result for this filter holds Gamma, whose Done is false.
    const { result, queries } = await check(type, { Status: "Final", Done: true });
    expect(queries[0]?.filter).toEqual({
      and: [
        { property: "Status", status: { equals: "Final" } },
        { property: "Done", checkbox: { equals: true } },
      ],
    });
    expect(ids(result)).toEqual([alpha]);
  });

  it("queries without a filter or a schema request when there is no where", async () => {
    const { result, queries, calls } = await check(type);
    expect(queries).toEqual([{ dataSource, filter: undefined }]);
    expect(ids(result)).toEqual([alpha, beta, gamma]);
    expect(calls.some((c) => c.startsWith("GET /v1/data_sources/"))).toBe(false);
  });

  it("filters locally the conditions it cannot translate (mixed case)", async () => {
    // Points "n/a" cannot be sent; Status still narrows the query. Locally nothing equals "n/a".
    const { result, queries } = await check(type, { Status: "Final", Points: "n/a" });
    expect(queries[0]?.filter).toEqual({ property: "Status", status: { equals: "Final" } });
    expect(ids(result)).toEqual([]);
  });

  it("filters everything locally when no condition can be translated", async () => {
    const local = await check(type, { Due: "2026/11/04" });
    expect(local.queries[0]?.filter).toBeUndefined();
    expect(ids(local.result)).toEqual([]);
  });

  it("falls back to a local filter when the schema cannot be read", async () => {
    const { [`GET /v1/data_sources/${dataSource}`]: _schema, ...rest } = recording.responses;
    const { result, queries } = await check(type, { Status: "Final" }, { responses: rest });
    expect(queries[0]?.filter).toBeUndefined();
    expect(ids(result)).toEqual([alpha, gamma]);
  });

  it("keeps the config error for a property the data source lacks", async () => {
    await expect(check(type, { Missing: "x" })).rejects.toThrow(
      /targets\[0\]\.where\.Missing: the data source has no property/,
    );
  });

  it("compares people IDs locally too, beyond the first 25", async () => {
    // Owner 30 is in Alpha's full list only; the page object holds 25 people.
    const { result, queries } = await check(type, { Owners: ownerBeyond25 });
    expect(queries[0]?.filter).toEqual({
      property: "Owners",
      people: { contains: ownerBeyond25 },
    });
    expect(ids(result)).toEqual([alpha]);
  });
});

describe("long property lists", () => {
  const messages = (result: CheckResult) =>
    result.pages.flatMap((p) => p.violations.map((v) => `${p.pageId}: ${v.message}`));

  it("fetches the full value across pages, so min passes only with the full count", async () => {
    // Alpha has 42 owners: 25 in the page object, 30 + 12 in two property item pages.
    const { result, calls } = await check(
      { properties: { Owners: { type: "people", min: 40 } } },
      { Status: "Final" },
    );
    // Gamma has one owner and is not truncated, so it needs no request.
    expect(messages(result)).toEqual([`${gamma}: needs at least 40 people (1 found)`]);
    const ownerCalls = calls.filter((c) => c.includes(`/properties/${propertyIds.owners}`));
    expect(ownerCalls).toEqual([
      `GET /v1/pages/${alpha}/properties/${propertyIds.owners}`,
      `GET /v1/pages/${alpha}/properties/${propertyIds.owners}?start_cursor=cur-2`,
    ]);
  });

  it("reports a min that the full count still misses, and an exact max", async () => {
    const { result } = await check(
      { properties: { Owners: { type: "people", min: 50, max: 41 } } },
      { Status: "Final" },
    );
    expect(messages(result)).toEqual([
      `${alpha}: needs at least 50 people (42 found)`,
      `${alpha}: allows at most 41 people (42 found)`,
      `${gamma}: needs at least 50 people (1 found)`,
    ]);
  });

  it("uses has_more on a relation, and does not fetch what is complete", async () => {
    const { result, calls } = await check({
      properties: {
        Related: { type: "relation", min: 40 },
        Attachments: { type: "files", min: 3 },
      },
    });
    // Alpha: 40 related pages (25 + 15) pass; 3 files are complete in the page object.
    expect(messages(result)).toEqual([
      `${beta}: needs at least 40 related pages (2 found)`,
      `${beta}: needs at least 3 files (0 found)`,
      `${gamma}: needs at least 40 related pages (0 found)`,
      `${gamma}: needs at least 3 files (0 found)`,
    ]);
    expect(calls.filter((c) => c.includes("/properties/"))).toEqual([
      `GET /v1/pages/${alpha}/properties/${propertyIds.related}`,
      `GET /v1/pages/${alpha}/properties/${propertyIds.related}?start_cursor=cur-2`,
    ]);
  });

  it("does not request properties the type does not look at", async () => {
    const { calls } = await check({ properties: { Status: { type: "status" } } });
    expect(calls.filter((c) => c.includes("/properties/"))).toEqual([]);
  });
});
