import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { resultJsonSchema } from "../src/index.js";
import type { CheckResult } from "../src/schema/result.js";
import { fixture, readFixtureJson, runCli } from "./helpers.js";
import { meetingNotes, replayFetcher } from "./notion-fake.js";

const config = readFixtureJson("meeting-notes.config.json") as { type: unknown };
const configJson = JSON.stringify(config);
const { dataSource, pageOk, pageBad, pageOrder } = meetingNotes.ids;

const env = { NOTION_TOKEN: "secret_test_token_value" };

function checkCli(args: string[], options: { config?: string } = {}) {
  const calls: string[] = [];
  return runCli(["--config-json", options.config ?? configJson, ...args], {
    env,
    createFetcher: (token) => {
      expect(token).toBe(env.NOTION_TOKEN);
      return replayFetcher(meetingNotes, calls);
    },
  }).then((result) => ({ ...result, calls }));
}

const validateResult = new Ajv({ strictTypes: false }).compile(resultJsonSchema());

function parseResult(stdout: string): CheckResult {
  const output = JSON.parse(stdout) as unknown;
  expect(validateResult(output), JSON.stringify(validateResult.errors)).toBe(true);
  return output as CheckResult;
}

describe("notion-lint check", () => {
  it("passes a page that matches the type (exit 0)", async () => {
    const result = await checkCli(["--page", pageOk, "--format", "json"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const output = parseResult(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      summary: { pages: 1, violations: 0, errors: 0, warnings: 0 },
      pages: [
        { pageId: pageOk, title: "議事録 2026-11-04 定例", typeName: "議事録", violations: [] },
      ],
      notes: [],
    });
  });

  it("reports property violations, a missing heading, extra headings, and a skipped level", async () => {
    const result = await checkCli(["--page", pageBad, "--format", "json"]);
    expect(result.code).toBe(1);
    const output = parseResult(result.stdout);
    const page = output.pages[0];
    const url = `https://www.notion.so/議事録-2026-11-05-臨時-${pageBad.replace(/-/g, "")}`;
    expect(page?.url).toBe(url);
    expect(page?.violations.map((v) => [v.path, v.rule, v.message])).toEqual([
      ["properties.日付", "property.required", '"日付" is empty'],
      ["properties.参加者", "property.min", "needs at least 1 person (0 found)"],
      [
        "properties.種別",
        "property.option",
        '"臨時会" is not an allowed option (allowed: "定例", "臨時")',
      ],
      ["properties.チケット", "property.pattern", '"abc-1" does not match /^[A-Z]+-\\d+$/'],
      ["body[1]", "body.missing", 'heading "決定事項" is missing (required after "目的")'],
      ["body", "body.extra", 'heading "雑談" is not in the type'],
      ["body", "body.extra", 'heading "付録" is not in the type'],
      ["headings.noSkipLevel", "headings.skipLevel", 'H3 "詳細" follows H1 "付録" (skips H2)'],
    ]);
    const missing = page?.violations[4];
    expect(missing).toMatchObject({
      pageId: pageBad,
      blockId: null,
      severity: "error",
      suggestions: [
        { message: 'Add an H2 heading "決定事項" after "目的"', replacement: "決定事項" },
      ],
    });
    // A missing heading links to the heading it should follow.
    expect(missing?.url).toMatch(new RegExp(`^${url}#[0-9a-f]{32}$`));
    expect(page?.violations[0]).toMatchObject({ blockId: null, url });
    const extra = page?.violations[5];
    expect(extra?.blockId).toMatch(/^[0-9a-f-]{36}$/);
    expect(extra?.url).toBe(`${url}#${extra?.blockId?.replace(/-/g, "")}`);
  });

  it("reports headings in the wrong order and sections without their blocks", async () => {
    const result = await checkCli(["--page", pageOrder, "--format", "json"]);
    expect(result.code).toBe(1);
    const output = parseResult(result.stdout);
    expect(output.pages[0]?.violations.map((v) => [v.path, v.rule, v.message])).toEqual([
      [
        "body[1]",
        "body.order",
        'heading "決定事項" is out of order (the type puts it after "目的")',
      ],
      ["body[1].children[0]", "body.min", 'needs at least 1 list item under "決定事項" (0 found)'],
      ["body[2].children[0]", "body.min", 'needs at least 1 to-do under "TODO" (0 found)'],
    ]);
  });

  it("checks every page of a data source target, filtered by where", async () => {
    const targets = (where?: Record<string, unknown>) =>
      JSON.stringify({
        targets: [{ dataSource: dataSource, ...(where ? { where } : {}), type: config.type }],
      });

    const all = await checkCli(["--format", "json"], { config: targets() });
    expect(all.code).toBe(1);
    const output = parseResult(all.stdout);
    expect(output.pages.map((p) => [p.pageId, p.violations.length])).toEqual([
      [pageOk, 0],
      [pageBad, 8],
      [pageOrder, 3],
    ]);
    expect(output.summary).toEqual({ pages: 3, violations: 11, errors: 11, warnings: 0 });
    // The query result already holds the pages, so they are not retrieved again.
    expect(all.calls.filter((c) => c.startsWith("GET /v1/pages/"))).toEqual([]);
    expect(all.calls.filter((c) => c.startsWith("POST"))).toHaveLength(2);

    const regular = await checkCli(["--format", "json"], {
      config: targets({ 種別: "定例", 公開: true }),
    });
    expect(parseResult(regular.stdout).pages.map((p) => p.pageId)).toEqual([pageOk, pageOrder]);

    const typo = await checkCli(["--format", "json"], { config: targets({ 種類: "定例" }) });
    expect(typo.code).toBe(2);
    expect(JSON.parse(typo.stdout)).toMatchObject({
      ok: false,
      error: { kind: "config", message: expect.stringContaining("targets[0].where.種類") },
    });
  });

  it("prints violations for people in text format", async () => {
    const result = await checkCli(["--page", pageBad, "--page", pageOk]);
    expect(result.code).toBe(1);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe(
      `議事録 2026-11-05 臨時  https://www.notion.so/議事録-2026-11-05-臨時-${pageBad.replace(/-/g, "")}`,
    );
    // Paths are padded by display width (CJK characters take two columns).
    expect(lines[1]).toBe('  ✖ properties.日付       "日付" is empty');
    expect(lines[2]).toBe("  ✖ properties.参加者     needs at least 1 person (0 found)");
    expect(lines).toContain(
      '  ✖ body[1]               heading "決定事項" is missing (required after "目的")',
    );
    expect(result.stdout).not.toContain("2026-11-04");
    expect(lines.at(-2)).toBe("✖ 8 problems (8 errors, 0 warnings) in 1 of 2 pages");
  });

  it("prints a short summary when nothing is wrong", async () => {
    const result = await checkCli(["--page", pageOk]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("✔ 1 page checked, no problems\n");
  });

  it("writes GitHub Actions annotations with --format github", async () => {
    const result = await checkCli(["--page", pageOrder, "--format", "github"]);
    expect(result.code).toBe(1);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      `::error title=notion-lint body[1]::議事録 2026-11-06 定例: heading "決定事項" is out of order (the type puts it after "目的") https://www.notion.so/議事録-2026-11-06-定例-${pageOrder.replace(/-/g, "")}#3b9c0d1e2f3a8000b000000000000022`,
    );
    expect(lines[3]).toBe("notion-lint: 1 page checked, 3 problems");
  });

  it("skips parts of a type that are not implemented yet, with a note", async () => {
    const type = {
      body: [{ heading: 2, title: "目的" }],
      numbering: { format: { h2: "{n}. {title}" } },
      references: { patterns: ["see section {n}"] },
    };
    const result = await checkCli(["--page", pageOk, "--format", "json"], {
      config: JSON.stringify({ type }),
    });
    expect(result.code).toBe(0);
    expect(parseResult(result.stdout).notes).toEqual([
      expect.objectContaining({ rule: "skipped", path: "type.numbering" }),
      expect.objectContaining({ rule: "skipped", path: "type.references" }),
    ]);

    const text = await checkCli(["--page", pageOk], { config: JSON.stringify({ type }) });
    expect(text.stdout).toContain(
      "ℹ type.numbering  numbering (section numbers) is not checked yet",
    );
  });

  it("does not fetch blocks when the type has no body rules", async () => {
    const result = await checkCli(["--page", pageOk, "--format", "json"], {
      config: JSON.stringify({ type: { properties: { 日付: { type: "date" } } } }),
    });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([`GET /v1/pages/${pageOk}`]);
  });
});

describe("notion-lint check errors (exit 2)", () => {
  it("needs NOTION_TOKEN, and never prints a token", async () => {
    const result = await runCli([
      "--config-json",
      configJson,
      "--page",
      pageOk,
      "--format",
      "json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { kind: "api", code: "missing_token", source: "--config-json" },
    });
  });

  it("returns a Notion API error as JSON", async () => {
    const missing = "0123456789abcdef0123456789abcdef";
    const result = await checkCli(["--page", missing, "--format", "json"]);
    expect(result.code).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(validateResult(output)).toBe(true);
    expect(output).toMatchObject({ ok: false, error: { kind: "api", code: "object_not_found" } });
    expect(result.stdout).not.toContain(env.NOTION_TOKEN);
  });

  it("prints a Notion API error for people in text format", async () => {
    const result = await checkCli(["--page", "0123456789abcdef0123456789abcdef"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("notion-lint: Notion API error for page 01234567-89ab");
  });

  it("needs --page or targets", async () => {
    const result = await checkCli(["--format", "json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { kind: "usage" } });
  });

  it("rejects a target page that is not an ID", async () => {
    const result = await checkCli(["--format", "json"], {
      config: JSON.stringify({ targets: [{ page: "<page ID>", type: {} }] }),
    });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { kind: "config", message: expect.stringContaining("targets[0].page") },
    });
  });

  it("keeps the fixtures free of real tokens", () => {
    expect(readFileSync(fixture("notion/meeting-notes.json"), "utf8")).not.toMatch(/secret_|ntn_/);
  });
});
