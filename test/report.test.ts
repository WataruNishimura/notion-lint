import { describe, expect, it } from "vitest";
import { formatGithub } from "../src/report/index.js";
import type { CheckResult, Violation } from "../src/schema/result.js";

const pageUrl = "https://www.notion.so/Meeting-0123456789abcdef0123456789abcdef";

function violation(overrides: Partial<Violation>): Violation {
  return {
    pageId: "0123456789abcdef0123456789abcdef",
    blockId: null,
    path: "properties.Date",
    rule: "property.required",
    severity: "error",
    message: "is empty",
    suggestions: [],
    ...overrides,
  };
}

function result(violations: Violation[], notes: CheckResult["notes"] = []): CheckResult {
  const errors = violations.filter((v) => v.severity === "error").length;
  return {
    ok: violations.length === 0,
    summary: {
      pages: 1,
      violations: violations.length,
      errors,
      warnings: violations.length - errors,
    },
    pages: [
      { pageId: "0123456789abcdef0123456789abcdef", url: pageUrl, title: "Meeting", violations },
    ],
    notes,
  };
}

describe("formatGithub", () => {
  it("links each annotation to the block, or to the page when there is no block URL", () => {
    const out = formatGithub(
      result([
        violation({ message: "is empty" }),
        violation({
          path: "body[1]",
          blockId: "b1",
          rule: "textlint/no-exclamation",
          severity: "warning",
          message: "bad",
          url: `${pageUrl}#b1`,
        }),
      ]),
    );
    expect(out.split("\n")).toEqual([
      `::error title=notion-lint properties.Date::Meeting: is empty ${pageUrl}`,
      `::warning title=notion-lint body[1]::Meeting: bad ${pageUrl}#b1`,
      "notion-lint: 1 page checked, 2 problems",
      "",
    ]);
  });

  it("escapes workflow command characters in titles and messages", () => {
    const out = formatGithub(
      result([
        violation({
          path: "properties.a:b,c",
          message: '100% wrong\nsecond line "x" ::error::',
        }),
      ]),
    );
    const [line] = out.split("\n");
    expect(line).toBe(
      `::error title=notion-lint properties.a%3Ab%2Cc::Meeting: 100%25 wrong%0Asecond line "x" ::error:: ${pageUrl}`,
    );
    // The whole annotation stays on one line.
    expect(out.split("\n")).toHaveLength(3);
  });

  it("writes notes as notices and a clean result as the summary line only", () => {
    const notes = [{ rule: "skipped", path: "targets[0].type.text", message: "not checked" }];
    expect(formatGithub(result([], notes))).toBe(
      "::notice title=notion-lint targets[0].type.text::not checked\nnotion-lint: 1 page checked, 0 problems\n",
    );
    expect(formatGithub(result([]))).toBe("notion-lint: 1 page checked, 0 problems\n");
  });
});
