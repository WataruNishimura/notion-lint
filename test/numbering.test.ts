import { describe, expect, it } from "vitest";
import type { BodyItem } from "../src/normalize/model.js";
import type { NumberingRule } from "../src/schema/config.js";
import { checkNumbering, HeadingFormat } from "../src/validate/numbering.js";

let n = 0;
const h = (level: number, text: string, children: BodyItem[] = []): BodyItem => ({
  kind: "heading",
  id: `h${++n}`,
  level,
  text,
  children,
});

const rule: NumberingRule = {
  format: { h1: "{n}. {title}", h2: "{n}.{n} {title}", h3: "{n}.{n}.{n} {title}" },
};

const summary = (findings: ReturnType<typeof checkNumbering>) =>
  findings.map((f) => [f.rule, f.message, f.suggestions[0]?.replacement]);

describe("HeadingFormat", () => {
  it("parses a heading into a number and a title, and writes one back", () => {
    const format = new HeadingFormat(2, "{n}.{n} {title}");
    expect(format.parse("2.1 Background")).toEqual({ parts: [2, 1], title: "Background" });
    expect(format.parse("2.1  Background ")).toEqual({ parts: [2, 1], title: "Background" });
    expect(format.parse("2. Background")).toBeUndefined();
    expect(format.parse("Background")).toBeUndefined();
    expect(format.renderNumber([2, 1])).toBe("2.1");
    expect(format.render([2, 2], "Purpose")).toBe("2.2 Purpose");
    expect(format.separators()).toEqual(["."]);
  });

  it("supports formats with text around the number", () => {
    const format = new HeadingFormat(1, "第{n}章 {title}");
    expect(format.parse("第3章 設計")).toEqual({ parts: [3], title: "設計" });
    expect(format.renderNumber([3])).toBe("3");
    expect(format.render([3], "設計")).toBe("第3章 設計");
  });
});

describe("checkNumbering", () => {
  it("accepts numbers that follow the hierarchy and run without gaps", () => {
    const items = [
      h(1, "1. Overview", [h(2, "1.1 Background"), h(2, "1.2 Purpose", [h(3, "1.2.1 Scope")])]),
      h(1, "2. Design", [h(2, "2.1 Data model")]),
    ];
    expect(checkNumbering(rule, items)).toEqual([]);
  });

  it("reports a heading that does not fit its level's format, with the number it should have", () => {
    const items = [h(1, "1. Overview", [h(2, "1.1 Background"), h(2, "Purpose")]), h(1, "Design")];
    const findings = checkNumbering(rule, items);
    expect(summary(findings)).toEqual([
      [
        "numbering.format",
        'heading "Purpose" does not match the H2 format "{n}.{n} {title}"',
        "1.2 Purpose",
      ],
      [
        "numbering.format",
        'heading "Design" does not match the H1 format "{n}. {title}"',
        "2. Design",
      ],
    ]);
    expect(findings[0]?.path).toBe("numbering.format.h2");
    expect(findings[0]?.blockId).toMatch(/^h\d+$/);
  });

  it("reports gaps, duplicates, and numbers that go back", () => {
    const items = [
      h(1, "1. Overview", [h(2, "1.1 A"), h(2, "1.3 B"), h(2, "1.3 C"), h(2, "1.2 D")]),
      h(1, "3. Design"),
    ];
    expect(summary(checkNumbering(rule, items))).toEqual([
      ["numbering.sequence", 'heading "1.3 B" skips 1.2', "1.2 B"],
      ["numbering.sequence", 'heading "1.3 C" repeats 1.3', "1.4 C"],
      ["numbering.sequence", 'heading "1.2 D" goes back (the previous one is 1.3)', "1.4 D"],
      ["numbering.sequence", 'heading "3. Design" skips 2', "2. Design"],
    ]);
  });

  it("does not check the order when sequential is false", () => {
    const items = [h(1, "1. Overview"), h(1, "3. Design"), h(1, "3. Plan")];
    expect(checkNumbering({ ...rule, sequential: false }, items)).toEqual([]);
  });

  it("reports a number that does not continue its parent's number", () => {
    const items = [h(1, "1. Overview", [h(2, "1.1 A")]), h(1, "2. Design", [h(2, "3.1 B")])];
    const findings = checkNumbering(rule, items);
    expect(summary(findings)).toEqual([
      [
        "numbering.hierarchy",
        'heading "3.1 B" is under "2. Design", so its number should start with 2',
        "2.1 B",
      ],
    ]);
    expect(findings[0]?.path).toBe("numbering");
  });

  it("reports a sub-section number before any numbered parent", () => {
    const items = [h(2, "1.1 Background"), h(1, "1. Overview")];
    expect(summary(checkNumbering(rule, items))).toEqual([
      ["numbering.hierarchy", 'heading "1.1 Background" is not under a section 1', undefined],
    ]);
  });

  it("leaves levels without a format alone", () => {
    const items = [h(1, "1. Overview", [h(2, "Notes"), h(3, "anything")]), h(1, "2. Design")];
    expect(checkNumbering({ format: { h1: "{n}. {title}" } }, items)).toEqual([]);
  });

  it("checks headings nested in other blocks in document order", () => {
    const toggle: BodyItem = {
      kind: "block",
      id: "t",
      type: "toggle",
      text: "more",
      children: [h(1, "2. Design")],
    };
    const items = [h(1, "1. Overview", [toggle]), h(1, "2. Plan")];
    expect(summary(checkNumbering(rule, items))).toEqual([
      ["numbering.sequence", 'heading "2. Plan" repeats 2', "3. Plan"],
    ]);
  });
});
