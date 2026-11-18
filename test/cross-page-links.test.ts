import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { resultJsonSchema } from "../src/index.js";
import type { CheckResult } from "../src/schema/result.js";
import { fixture, readFixtureJson, runCli } from "./helpers.js";
import { type Recording, replayFetcher } from "./notion-fake.js";

const cross = readFixtureJson("notion/cross-page.json") as Recording & {
  ids: Record<"guide" | "reference" | "notes", string>;
};
const { guide, reference, notes } = cross.ids;

const references = { patterns: ["see chapter {n}"], notionLinks: true };
// The Guide numbers its headings; the Reference has no numbering rule, so a heading that
// starts with "2.1 " still counts as section 2.1.
const guideType = {
  name: "Guide",
  numbering: { format: { h1: "{n}. {title}", h2: "{n}.{n} {title}" } },
  references,
};
const referenceType = { name: "Reference", references };

const env = { NOTION_TOKEN: "secret_test_token_value" };
const validateResult = new Ajv({ strictTypes: false }).compile(resultJsonSchema());

async function check(targets: { page: string; type: unknown }[]) {
  const calls: string[] = [];
  const result = await runCli(["--config-json", JSON.stringify({ targets }), "--format", "json"], {
    env,
    createFetcher: () => replayFetcher(cross, calls),
  });
  const output = JSON.parse(result.stdout) as unknown;
  expect(validateResult(output), JSON.stringify(validateResult.errors)).toBe(true);
  return { ...result, output: output as CheckResult, calls };
}

const summary = (page: CheckResult["pages"][number] | undefined) =>
  page?.violations.map((v) => [v.rule, v.message]);

describe("links between pages checked in the same run", () => {
  it("checks links to headings against the other page's headings, by its own type", async () => {
    const result = await check([
      { page: guide, type: guideType },
      { page: reference, type: referenceType },
    ]);
    expect(result.code).toBe(1);
    const [guidePage, referencePage] = result.output.pages;

    // "2.1 Rate limits" is correct, and so are the free link text and the page mention.
    expect(summary(guidePage)).toEqual([
      [
        "references.link",
        'link "2.1 Quotas" points to the heading "2.2 Quotas" on the page "API reference"',
      ],
      [
        "references.link",
        'link "3. Glossary" points to a block that is no longer on the page "API reference"',
      ],
    ]);
    expect(guidePage?.violations[0]?.suggestions).toEqual([
      { message: 'Change the link text to "2.2 Quotas"', replacement: "2.2 Quotas" },
    ]);
    expect(guidePage?.violations[0]?.path).toBe("references.notionLinks");
    expect(guidePage?.violations[0]?.blockId).toMatch(/^6e4f0a31-8c9d-8000-d001-/);

    // "1.1 Install" is correct; "1. Usage" is stale because the Guide numbers it 2.
    expect(summary(referencePage)).toEqual([
      ["references.link", 'link "1. Usage" points to the heading "2. Usage" on the page "Guide"'],
    ]);
    expect(referencePage?.violations[0]?.suggestions).toEqual([
      { message: 'Change the link text to "2. Usage"', replacement: "2. Usage" },
    ]);
  });

  it("does not fetch a checked page again, and does not read it as an existence check", async () => {
    const result = await check([
      { page: guide, type: guideType },
      { page: reference, type: referenceType },
    ]);
    const counts = new Map<string, number>();
    for (const call of result.calls) counts.set(call, (counts.get(call) ?? 0) + 1);
    expect([...counts.entries()].filter(([, n]) => n > 1)).toEqual([]);
    expect(result.calls.filter((c) => c.startsWith("GET /v1/pages/")).sort()).toEqual(
      [`GET /v1/pages/${guide}`, `GET /v1/pages/${reference}`].sort(),
    );
    // The only page read for existence is the one that is not checked.
    expect(
      result.calls.filter((c) => c.startsWith("GET /v1/blocks/") && !c.endsWith("/children")),
    ).toEqual([`GET /v1/blocks/${notes}`]);
  });

  it("only checks that a page and its blocks exist when the page is not checked in the run", async () => {
    const result = await check([{ page: guide, type: guideType }]);
    // The stale link text "2.1 Quotas" is not noticed, since the other page is not checked.
    // Only the block that is gone is reported, by the existence check.
    expect(result.output.pages[0]?.violations.map((v) => [v.rule, v.message])).toEqual([
      [
        "references.target",
        expect.stringContaining(
          'link "3. Glossary" points to a block on another page that cannot be read',
        ),
      ],
    ]);
    const blockCalls = result.calls.filter(
      (c) => c.startsWith("GET /v1/blocks/") && !c.endsWith("/children"),
    );
    // Each target is read once: the page mention, the two headings, the missing block, and the unchecked page.
    expect(blockCalls.sort()).toEqual(
      [
        `GET /v1/blocks/${reference}`,
        `GET /v1/blocks/${notes}`,
        "GET /v1/blocks/6e4f0a31-8c9d-8000-d001-000000000204",
        "GET /v1/blocks/6e4f0a31-8c9d-8000-d001-000000000205",
        "GET /v1/blocks/6e4f0a31-8c9d-8000-d001-000000000299",
      ].sort(),
    );
  });

  it("does not match link text when the linked page's type needs no body", async () => {
    const result = await check([
      { page: guide, type: guideType },
      { page: reference, type: { name: "Reference" } },
    ]);
    // Without a body, the Reference page has no headings to match: its block links fall
    // back to the existence check, so only the block that is gone is reported.
    expect(result.output.pages[0]?.violations.map((v) => v.rule)).toEqual(["references.target"]);
  });

  it("keeps the fixture free of real tokens", () => {
    expect(readFileSync(fixture("notion/cross-page.json"), "utf8")).not.toMatch(/secret_|ntn_/);
  });
});
