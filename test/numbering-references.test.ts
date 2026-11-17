import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { resultJsonSchema } from "../src/index.js";
import type { CheckResult } from "../src/schema/result.js";
import { fixture, readFixtureJson, runCli } from "./helpers.js";
import { type Recording, replayFetcher } from "./notion-fake.js";

const spec = readFixtureJson("notion/spec.json") as Recording & {
  ids: Record<"pageOk" | "pageBad" | "linkedPage" | "trashedPage" | "missingPage", string>;
};
const { pageOk, pageBad, linkedPage, trashedPage, missingPage } = spec.ids;

const type = {
  name: "Spec",
  body: [
    { heading: 1, title: "Overview" },
    { heading: 1, title: "Requirements" },
    { heading: 1, title: "Design" },
  ],
  numbering: { format: { h1: "{n}. {title}", h2: "{n}.{n} {title}" }, sequential: true },
  references: {
    patterns: ["see chapter {n}", "see section {n}", '{n} "{title}"', 'see "{title}"'],
    notionLinks: true,
    ignore: [{ pattern: "RFC \\d+, see chapter \\d+" }],
  },
};

const env = { NOTION_TOKEN: "secret_test_token_value" };
const validateResult = new Ajv({ strictTypes: false }).compile(resultJsonSchema());

async function checkSpec(pages: string[], config: unknown = { type }) {
  const calls: string[] = [];
  const result = await runCli(
    [
      "--config-json",
      JSON.stringify(config),
      ...pages.flatMap((p) => ["--page", p]),
      "--format",
      "json",
    ],
    { env, createFetcher: () => replayFetcher(spec, calls) },
  );
  const output = JSON.parse(result.stdout) as unknown;
  expect(validateResult(output), JSON.stringify(validateResult.errors)).toBe(true);
  return { ...result, output: output as CheckResult, calls };
}

describe("check with numbering and references", () => {
  it("passes a page whose numbers, references, and links agree with its headings", async () => {
    const result = await checkSpec([pageOk]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({
      ok: true,
      pages: [{ pageId: pageOk, title: "Export spec", violations: [] }],
      notes: [],
    });
    // The page mention is checked once, by retrieving its block.
    expect(result.calls.filter((c) => !c.endsWith("/children"))).toEqual([
      `GET /v1/pages/${pageOk}`,
      `GET /v1/blocks/${linkedPage}`,
    ]);
  });

  it("reports numbering and reference violations with the block that holds them", async () => {
    const result = await checkSpec([pageBad]);
    expect(result.code).toBe(1);
    const page = result.output.pages[0];
    expect(page?.violations.map((v) => [v.path, v.rule, v.message])).toEqual([
      ["numbering.sequential", "numbering.sequence", 'heading "2.4 Constraints" skips 2.3'],
      [
        "numbering.format.h2",
        "numbering.format",
        'heading "Scope" does not match the H2 format "{n}.{n} {title}"',
      ],
      [
        "numbering",
        "numbering.hierarchy",
        'heading "4.1 Data model" is under "3. Design", so its number should start with 3',
      ],
      ["references.patterns[0]", "references.number", '"See chapter 4": there is no section 4'],
      [
        "references.patterns[2]",
        "references.mismatch",
        '"2.1 "Background"": 2.1 is "Purpose"; "Background" is 2.2',
      ],
      [
        "references.patterns[3]",
        "references.title",
        '"see "Context"": there is no heading "Context"',
      ],
      [
        "references.notionLinks",
        "references.link",
        'link "2.1 Background" points to the heading "2.2 Background"',
      ],
      [
        "references.notionLinks",
        "references.target",
        `link "Untitled" points to a page that cannot be read (object_not_found): it does not exist, or the integration is not connected to it`,
      ],
      [
        "references.notionLinks",
        "references.target",
        'link "old design" points to a page that is in the trash',
      ],
    ]);

    const byRule = (rule: string) => page?.violations.find((v) => v.rule === rule);
    expect(byRule("numbering.format")?.suggestions).toEqual([
      { message: 'Write it as "2.5 Scope"', replacement: "2.5 Scope" },
    ]);
    expect(byRule("numbering.hierarchy")?.suggestions).toEqual([
      { message: 'Renumber it to "3.1 Data model"', replacement: "3.1 Data model" },
    ]);
    expect(byRule("references.mismatch")?.suggestions).toEqual([
      { message: "Change the number to 2.2", replacement: '2.2 "Background"' },
      { message: 'Change the title to "Purpose"', replacement: '2.1 "Purpose"' },
    ]);
    // Every violation names a block and links to it.
    for (const violation of page?.violations ?? []) {
      expect(violation.blockId).toMatch(/^[0-9a-f-]{36}$/);
      expect(violation.url).toBe(
        `https://www.notion.so/Import-spec-${pageBad.replace(/-/g, "")}#${violation.blockId?.replace(/-/g, "")}`,
      );
    }
    expect(result.calls).toContain(`GET /v1/blocks/${missingPage}`);
    expect(result.calls).toContain(`GET /v1/blocks/${trashedPage}`);
  });

  it("retrieves each linked page once per run", async () => {
    const result = await checkSpec([pageOk, pageOk, pageBad]);
    expect(result.code).toBe(1);
    expect(result.calls.filter((c) => c === `GET /v1/blocks/${linkedPage}`)).toHaveLength(1);
  });

  it("does not retrieve linked pages when notionLinks is off", async () => {
    const config = { type: { ...type, references: { ...type.references, notionLinks: false } } };
    const result = await checkSpec([pageBad], config);
    expect(result.output.pages[0]?.violations.map((v) => v.rule)).not.toContain("references.link");
    expect(
      result.calls.filter((c) => c.startsWith("GET /v1/blocks/") && !c.endsWith("/children")),
    ).toEqual([]);
  });

  it("keeps the fixture free of real tokens", () => {
    expect(readFileSync(fixture("notion/spec.json"), "utf8")).not.toMatch(/secret_|ntn_/);
  });
});
