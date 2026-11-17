import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type BodyNode,
  type Config,
  configJsonSchema,
  type DocType,
  exitCodeFor,
  type PropSpec,
  type Result,
  resultJsonSchema,
  validateConfig,
} from "../src/index.js";
import { parseNotionId } from "../src/notion/id.js";
import { pointerToPath } from "../src/path.js";

const committed = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8"));

function issuesOf(data: unknown) {
  const result = validateConfig(data);
  if (result.ok) throw new Error("expected the config to be invalid");
  return result.issues.map(({ path, keyword }) => ({ path, keyword }));
}

describe("JSON Schema", () => {
  it("is committed up to date (run `pnpm schema:write` after changing src/schema)", () => {
    expect(committed("notion-lint.schema.json")).toStrictEqual(configJsonSchema());
    expect(committed("result.schema.json")).toStrictEqual(resultJsonSchema());
  });

  it("is plain JSON (no functions or symbols leak in)", () => {
    const schema = configJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toStrictEqual(schema);
  });

  it("accepts the smallest agent config from the design doc", () => {
    expect(validateConfig({ type: { body: [{ heading: 2, title: "目的" }] } }).ok).toBe(true);
  });

  it("needs type or targets", () => {
    expect(issuesOf({})).toEqual([{ path: "", keyword: "anyOf" }]);
  });

  it("tells headings and blocks apart and reports only the relevant fields", () => {
    expect(
      issuesOf({
        type: {
          body: [
            { heading: 2, title: 5 },
            { title: "x" },
            { block: "todo" },
            { heading: 2, title: "a", children: [{ block: "list", extra: true }] },
          ],
        },
      }),
    ).toEqual([
      { path: "type.body[0].title", keyword: "type" },
      { path: "type.body[1]", keyword: "anyOf" },
      { path: "type.body[2].block", keyword: "enum" },
      { path: "type.body[3].children[0].extra", keyword: "additionalProperties" },
    ]);
  });

  it("checks each property type's own fields", () => {
    expect(
      issuesOf({
        type: {
          properties: {
            a: { type: "date", min: 1 },
            b: { type: "people", pattern: "x" },
            c: { type: "unknown" },
            d: { type: "rich_text", pattern: "(" },
            e: { type: "rich_text", flags: "i" },
            f: { type: "select", options: ["x", "x"] },
            g: {},
          },
        },
      }),
    ).toEqual([
      { path: "type.properties.a.min", keyword: "additionalProperties" },
      { path: "type.properties.b.pattern", keyword: "additionalProperties" },
      { path: "type.properties.c.type", keyword: "enum" },
      { path: "type.properties.d.pattern", keyword: "format" },
      { path: "type.properties.e.pattern", keyword: "dependencies" },
      { path: "type.properties.f.options", keyword: "uniqueItems" },
      { path: "type.properties.g.type", keyword: "required" },
    ]);
  });

  it("checks targets, numbering, references and text", () => {
    expect(
      issuesOf({
        targets: [
          { dataSource: "d", where: { 状態: ["a"] }, type: {} },
          { page: "", type: { numbering: { format: { h1: "{n}." } } } },
          {
            page: "p",
            type: { references: { patterns: [] }, text: { textlint: { presets: "x" } } },
          },
          {},
        ],
      }),
    ).toEqual([
      { path: "targets[0].where.状態", keyword: "type" },
      { path: "targets[1].page", keyword: "minLength" },
      { path: "targets[1].type.numbering.format.h1", keyword: "pattern" },
      { path: "targets[2].type.text.textlint.presets", keyword: "type" },
      { path: "targets[2].type.references.patterns", keyword: "minItems" },
      { path: "targets[3]", keyword: "anyOf" },
    ]);
  });

  it("formats JSON Pointers as readable paths", () => {
    expect(pointerToPath("/type/properties/参加者/min")).toBe("type.properties.参加者.min");
    expect(pointerToPath("/targets/0/where/a~1b")).toBe("targets[0].where.a/b");
    expect(pointerToPath("/type/properties/has space")).toBe('type.properties["has space"]');
    expect(pointerToPath("/type/properties/a.b")).toBe('type.properties["a.b"]');
  });
});

describe("TypeScript types derived from the schema", () => {
  it("match the JSON shapes", () => {
    expectTypeOf<{ type: { body: [{ heading: 2; title: "目的" }] } }>().toExtend<Config>();
    expectTypeOf<{ heading: 4; title: "x" }>().not.toExtend<BodyNode>();
    expectTypeOf<{
      block: "to_do";
      min: 1;
      children: [{ heading: 3; title: { pattern: "^a" } }];
    }>().toExtend<BodyNode>();
    expectTypeOf<{ type: "people"; min: 1 }>().toExtend<PropSpec>();
    expectTypeOf<{ type: "people"; min: "1" }>().not.toExtend<PropSpec>();
    expectTypeOf<{ type: "dates" }>().not.toExtend<PropSpec>();
    expectTypeOf<PropSpec["type"]>().toEqualTypeOf<
      | "title"
      | "rich_text"
      | "number"
      | "select"
      | "multi_select"
      | "status"
      | "date"
      | "people"
      | "files"
      | "checkbox"
      | "url"
      | "email"
      | "phone_number"
      | "relation"
    >();
    expectTypeOf<DocType["fromTemplate"]>().toEqualTypeOf<{ page: string } | undefined>();
  });
});

describe("result format", () => {
  it("maps results to exit codes 0 / 1 / 2", () => {
    const clean: Result = {
      ok: true,
      summary: { pages: 1, violations: 0, errors: 0, warnings: 0 },
      pages: [],
      notes: [],
    };
    const dirty: Result = {
      ok: false,
      summary: { pages: 1, violations: 1, errors: 1, warnings: 0 },
      pages: [
        {
          pageId: "p",
          url: "https://www.notion.so/p",
          violations: [
            {
              pageId: "p",
              blockId: null,
              path: "properties.参加者",
              rule: "property.min",
              severity: "error",
              message: "needs at least 1 person (0 found)",
              suggestions: [],
            },
          ],
        },
      ],
      notes: [],
    };
    expect(exitCodeFor(clean)).toBe(0);
    expect(exitCodeFor(dirty)).toBe(1);
    expect(exitCodeFor({ ok: false, error: { kind: "config", message: "x" } })).toBe(2);
  });
});

describe("parseNotionId", () => {
  it.each([
    ["0123456789abcdef0123456789abcdef", "01234567-89ab-cdef-0123-456789abcdef"],
    ["01234567-89AB-cdef-0123-456789abcdef", "01234567-89ab-cdef-0123-456789abcdef"],
    [
      "https://www.notion.so/team/My-page-0123456789abcdef0123456789abcdef?pvs=4",
      "01234567-89ab-cdef-0123-456789abcdef",
    ],
    [
      "https://www.notion.so/team/abc?v=1&p=0123456789abcdef0123456789abcdef",
      "01234567-89ab-cdef-0123-456789abcdef",
    ],
    ["nope", undefined],
    ["https://www.notion.so/xxxx", undefined],
  ])("%s", (input, expected) => {
    expect(parseNotionId(input)).toBe(expected);
  });
});
