import { describe, expect, it } from "vitest";
import type { BodyItem, PropertyValue } from "../src/normalize/model.js";
import type { BodyNode, PropSpec } from "../src/schema/config.js";
import { checkBody, longestInOrder } from "../src/validate/body.js";
import { checkProperties } from "../src/validate/properties.js";

let n = 0;
const h = (level: number, text: string, children: BodyItem[] = []): BodyItem => ({
  kind: "heading",
  id: `h${++n}`,
  level,
  text,
  children,
});
const b = (type: string, text = "x", children: BodyItem[] = []): BodyItem => ({
  kind: "block",
  id: `b${++n}`,
  type,
  text,
  children,
});

const rules = (findings: { path: string; rule: string }[]) =>
  findings.map((f) => `${f.path} ${f.rule}`);

describe("checkProperties", () => {
  const check = (spec: PropSpec, value: PropertyValue | undefined) =>
    checkProperties({ p: spec }, value === undefined ? {} : { p: value });

  it("reports missing properties unless optional", () => {
    expect(rules(check({ type: "date" }, undefined))).toEqual(["properties.p property.missing"]);
    expect(check({ type: "date", optional: true }, undefined)).toEqual([]);
  });

  it("reports a type mismatch and stops there", () => {
    const findings = check({ type: "select", required: true }, { type: "rich_text", text: "" });
    expect(rules(findings)).toEqual(["properties.p property.type"]);
    expect(findings[0]?.message).toBe(
      'property "p" is a rich text property; the type expects select',
    );
  });

  it("checks required, pattern, number range, options, and counts", () => {
    expect(rules(check({ type: "url", required: true }, { type: "url", text: " " }))).toEqual([
      "properties.p property.required",
    ]);
    expect(
      check({ type: "title", pattern: "^[a-z]+$", flags: "i" }, { type: "title", text: "ABC" }),
    ).toEqual([]);
    expect(
      rules(check({ type: "title", pattern: "^[a-z]+$" }, { type: "title", text: "ABC" })),
    ).toEqual(["properties.p property.pattern"]);
    expect(check({ type: "rich_text", pattern: "^x$" }, { type: "rich_text", text: "" })).toEqual(
      [],
    );
    expect(rules(check({ type: "number", min: 1, max: 3 }, { type: "number", value: 5 }))).toEqual([
      "properties.p property.max",
    ]);
    expect(
      rules(
        check(
          { type: "multi_select", options: ["a", "b"], max: 1 },
          { type: "multi_select", values: ["a", "c"] },
        ),
      ),
    ).toEqual(["properties.p property.option", "properties.p property.max"]);
    expect(
      check({ type: "people", min: 2 }, { type: "people", count: 1, hasMore: false })[0]?.message,
    ).toBe("needs at least 2 people (1 found)");
    // `check` completes long lists before matching, so `min` is exact beyond 25 items too.
    expect(
      check({ type: "relation", min: 30 }, { type: "relation", count: 25, hasMore: false })[0]
        ?.message,
    ).toBe("needs at least 30 related pages (25 found)");
    expect(
      check({ type: "relation", min: 30 }, { type: "relation", count: 31, hasMore: false }),
    ).toEqual([]);
    expect(
      rules(check({ type: "checkbox", required: true }, { type: "checkbox", checked: false })),
    ).toEqual(["properties.p property.required"]);
  });

  it("suggests the allowed options", () => {
    const [finding] = check(
      { type: "status", options: ["Draft", "Final"] },
      { type: "status", value: "Done" },
    );
    expect(finding?.suggestions).toEqual([
      { message: 'Use "Draft"', replacement: "Draft" },
      { message: 'Use "Final"', replacement: "Final" },
    ]);
  });
});

describe("checkBody", () => {
  it("matches titles exactly or by regex", () => {
    const body: BodyNode[] = [
      { heading: 2, title: "Purpose" },
      { heading: 2, title: { pattern: "^Decisions" } },
    ];
    expect(
      checkBody(body, [h(2, "Purpose"), h(2, "Decisions (draft)")], undefined, undefined),
    ).toEqual([]);
    expect(
      rules(checkBody(body, [h(2, "purpose"), h(2, "Decisions")], undefined, undefined)),
    ).toEqual(["body[0] body.missing"]);
  });

  it("names the neighbour a missing heading belongs next to", () => {
    const body: BodyNode[] = [
      { heading: 2, title: "A" },
      { heading: 2, title: "B" },
      { heading: 2, title: "C" },
    ];
    const [after] = checkBody(body, [h(2, "A"), h(2, "C")], undefined, undefined);
    expect(after?.message).toBe('heading "B" is missing (required after "A")');
    const [before] = checkBody(body, [h(2, "B"), h(2, "C")], undefined, undefined);
    expect(before?.message).toBe('heading "A" is missing (required before "B")');
  });

  it("reports wrong order, keeping the longest in-order run", () => {
    const body: BodyNode[] = [
      { heading: 2, title: "A" },
      { heading: 2, title: "B" },
      { heading: 2, title: "C" },
    ];
    const findings = checkBody(body, [h(2, "C"), h(2, "A"), h(2, "B")], undefined, undefined);
    expect(rules(findings)).toEqual(["body[2] body.order"]);
    expect(findings[0]?.message).toBe('heading "C" is out of order (the type puts it after "B")');
  });

  it("reports a wrong level, extra headings only when allowExtra is false, and skipped levels", () => {
    const body: BodyNode[] = [{ heading: 2, title: "A" }];
    const items = [h(1, "A", [h(3, "Deep")]), h(1, "Other")];
    expect(rules(checkBody(body, items, undefined, undefined))).toEqual(["body[0] body.level"]);
    expect(
      rules(checkBody(body, items, { allowExtra: false, noSkipLevel: true }, undefined)),
    ).toEqual(["body[0] body.level", "body body.extra", "headings.noSkipLevel headings.skipLevel"]);
  });

  it("checks blocks under a heading, ignoring blank paragraphs", () => {
    const body: BodyNode[] = [
      {
        heading: 2,
        title: "A",
        children: [{ block: "paragraph" }, { block: "list", min: 2, max: 3 }],
      },
    ];
    const ok = [
      h(2, "A", [
        b("paragraph"),
        b("paragraph", ""),
        b("bulleted_list_item"),
        b("numbered_list_item"),
      ]),
    ];
    expect(checkBody(body, ok, undefined, undefined)).toEqual([]);

    const few = [h(2, "A", [b("bulleted_list_item"), b("paragraph"), b("bulleted_list_item")])];
    const findings = checkBody(body, few, undefined, undefined);
    expect(rules(findings)).toEqual(["body[0].children[1] body.min"]);
    expect(findings[0]?.message).toBe('needs at least 2 list items under "A" (1 found)');
  });

  it("checks the children of matched blocks", () => {
    const body: BodyNode[] = [{ block: "toggle", children: [{ block: "code" }] }];
    const findings = checkBody(
      body,
      [b("toggle", "Details", [b("paragraph")])],
      undefined,
      undefined,
    );
    expect(rules(findings)).toEqual(["body[0].children[0] body.min"]);
    expect(findings[0]?.message).toBe(
      'needs at least 1 code block inside the toggle "Details" (0 found)',
    );
  });

  it("ignores section numbers written in the numbering format", () => {
    const body: BodyNode[] = [
      { heading: 1, title: "Overview" },
      { heading: 2, title: "Background" },
    ];
    const items = [h(1, "1. Overview", [h(2, "1.1 Background")])];
    const numbering = { format: { h1: "{n}. {title}", h2: "{n}.{n} {title}" } };
    // Background is under Overview in the tree, so at the top level it is missing.
    expect(rules(checkBody(body, items, undefined, numbering))).toEqual(["body[1] body.missing"]);
    expect(
      checkBody(
        [{ heading: 1, title: "Overview", children: [{ heading: 2, title: "Background" }] }],
        items,
        undefined,
        numbering,
      ),
    ).toEqual([]);
  });
});

describe("longestInOrder", () => {
  it.each([
    [
      [0, 1, 2],
      [0, 1, 2],
    ],
    [
      [1, 0, 2],
      [0, 2],
    ],
    [
      [2, 0, 1],
      [1, 2],
    ],
    [[1, 0], [0]],
    [[], []],
  ])("%j -> %j", (positions, expected) => {
    expect(longestInOrder(positions)).toEqual(expected);
  });
});
