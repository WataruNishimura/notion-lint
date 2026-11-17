import { describe, expect, it } from "vitest";
import type { BodyItem } from "../src/normalize/model.js";
import type { CheckResult } from "../src/schema/result.js";
import { skeletonFromTemplate } from "../src/validate/template.js";
import { readFixtureJson, runCli } from "./helpers.js";
import { type Recording, replayFetcher } from "./notion-fake.js";

const recording = readFixtureJson("notion/design-template.json") as Recording & {
  ids: { template: string; pageOk: string; pageBad: string; pageNoTemplate: string };
};
const { template, pageOk, pageBad, pageNoTemplate } = recording.ids;
const env = { NOTION_TOKEN: "secret_test_token_value" };

function check(config: unknown, args: string[], rec: Recording = recording) {
  const calls: string[] = [];
  return runCli(["--config-json", JSON.stringify(config), ...args, "--format", "json"], {
    env,
    createFetcher: () => replayFetcher(rec, calls),
  }).then((result) => ({ ...result, calls }));
}

const type = {
  fromTemplate: { page: template },
  properties: { status: { type: "status", required: true, options: ["Draft", "Final"] } },
};
const parse = (stdout: string) => JSON.parse(stdout) as CheckResult;

describe("fromTemplate", () => {
  it("passes a page that has the template's headings (extra headings are allowed)", async () => {
    const result = await check({ type }, ["--page", pageOk]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const output = parse(result.stdout);
    expect(output.pages[0]?.violations).toEqual([]);
    expect(output.notes).toEqual([]);
  });

  it("reports missing and out-of-order headings compared with the template, and properties", async () => {
    const result = await check({ type }, ["--page", pageBad]);
    expect(result.code).toBe(1);
    const violations = parse(result.stdout).pages[0]?.violations ?? [];
    expect(violations.map((v) => [v.path, v.rule])).toEqual([
      ["properties.status", "property.required"],
      ["body[1]", "body.order"],
      ["body[1].children[1]", "body.order"],
    ]);
    expect(violations[1]?.message).toContain("背景");
    expect(violations[2]?.message).toContain("全体構成");
  });

  it("reports a heading that the template has and the page lacks", async () => {
    const result = await check({ type: { fromTemplate: { page: template } } }, [
      "--page",
      pageNoTemplate,
    ]);
    expect(result.code).toBe(1);
    const violations = parse(result.stdout).pages[0]?.violations ?? [];
    expect(violations.map((v) => [v.path, v.rule, v.message])).toEqual([
      [
        "body[1].children[1]",
        "body.missing",
        'heading "データモデル" is missing (required after "全体構成")',
      ],
    ]);
  });

  it("applies headings.allowExtra: false under template headings that have sub-headings", async () => {
    const result = await check(
      { type: { fromTemplate: { page: template }, headings: { allowExtra: false } } },
      ["--page", pageOk],
    );
    expect(result.code).toBe(1);
    const violations = parse(result.stdout).pages[0]?.violations ?? [];
    expect(violations.map((v) => [v.path, v.rule, v.message])).toEqual([
      ["body[1].children", "body.extra", 'heading "運用メモ" is not in the type'],
    ]);
  });

  it("uses a body written in the type instead of the template's (no merge, no template fetch)", async () => {
    const result = await check(
      { type: { fromTemplate: { page: template }, body: [{ heading: 1, title: "背景" }] } },
      ["--page", pageBad],
    );
    expect(result.code).toBe(0);
    expect(result.calls.some((c) => c.includes(template))).toBe(false);
  });

  it("fetches the template once per run, even for several targets", async () => {
    const result = await check(
      {
        targets: [
          { page: pageOk, type: { fromTemplate: { page: template } } },
          { page: pageBad, type: { fromTemplate: { page: template } } },
        ],
      },
      [],
    );
    expect(result.code).toBe(1);
    expect(result.calls.filter((c) => c === `GET /v1/pages/${template}`)).toHaveLength(1);
    expect(result.calls.filter((c) => c === `GET /v1/blocks/${template}/children`)).toHaveLength(1);
  });

  it("treats a template page that cannot be fetched as an API error (exit 2)", async () => {
    const missing = "4c1d2e3f-4a5b-8011-a002-0000000000ff";
    const result = await check({ type: { fromTemplate: { page: missing } } }, ["--page", pageOk]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { kind: "api", code: "object_not_found" },
    });
    expect(result.stdout).toContain("type.fromTemplate");
  });

  it("rejects an invalid template page ID as a config error (exit 2)", async () => {
    const result = await check({ type: { fromTemplate: { page: "nope" } } }, ["--page", pageOk]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { kind: "config" } });
  });
});

describe("skeletonFromTemplate", () => {
  const heading = (level: number, text: string, children: BodyItem[] = []): BodyItem => ({
    kind: "heading",
    id: text,
    level,
    text,
    children,
  });
  const para: BodyItem = { kind: "block", id: "p", type: "paragraph", text: "x", children: [] };

  it("keeps headings with their nesting, and drops blocks, empty and deep headings", () => {
    const items = [
      para,
      heading(1, "A", [para, heading(2, "A1", [heading(4, "deep")]), heading(2, "")]),
      heading(1, "B"),
    ];
    expect(skeletonFromTemplate(items, undefined)).toEqual([
      { heading: 1, title: "A", children: [{ heading: 2, title: "A1" }] },
      { heading: 1, title: "B" },
    ]);
  });

  it("strips section numbers in the numbering format", () => {
    const items = [heading(1, "1. Overview"), heading(2, "Plain")];
    expect(skeletonFromTemplate(items, { format: { h1: "{n}. {title}" } })).toEqual([
      { heading: 1, title: "Overview" },
      { heading: 2, title: "Plain" },
    ]);
  });
});
