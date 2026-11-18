import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { resultJsonSchema } from "../src/index.js";
import type { CheckResult } from "../src/schema/result.js";
import { compileTemplate, pageTitleKey } from "../src/validate/references.js";
import { fixture, readFixtureJson, runCli } from "./helpers.js";
import { type Recording, replayFetcher } from "./notion-fake.js";

const recording = readFixtureJson("notion/page-references.json") as Recording & {
  ids: Record<"notes" | "spec" | "shiyou" | "glossaryA" | "glossaryB" | "history", string>;
};
const { notes, spec, shiyou, glossaryA, glossaryB, history } = recording.ids;

// Patterns that name a page come first in the list here, but they are tried first anyway.
const notesType = {
  name: "Notes",
  numbering: { format: { h1: "{n}. {title}" } },
  references: {
    patterns: [
      "see section {n}",
      '{page} {n} "{title}"',
      "{page} {n}",
      "{page}の{n}章",
      'section {n} of "{page}"',
      "section {n} of {page}",
    ],
    notionLinks: true,
  },
};
const numbered = { numbering: { format: { h1: "{n}. {title}", h2: "{n}.{n} {title}" } } };

const env = { NOTION_TOKEN: "secret_test_token_value" };
const validateResult = new Ajv({ strictTypes: false }).compile(resultJsonSchema());

async function check(pages: [string, unknown][]) {
  const calls: string[] = [];
  const targets = pages.map(([page, type]) => ({ page, type }));
  const result = await runCli(["--config-json", JSON.stringify({ targets }), "--format", "json"], {
    env,
    createFetcher: () => replayFetcher(recording, calls),
  });
  const output = JSON.parse(result.stdout) as unknown;
  expect(validateResult(output), JSON.stringify(validateResult.errors)).toBe(true);
  return { ...result, output: output as CheckResult, calls };
}

const blockId = (n: number) => `7a5b0c1d-2e3f-8000-e001-000000000${n}`;
const summary = (page: CheckResult["pages"][number] | undefined) =>
  page?.violations.map((v) => [v.rule, v.blockId, v.message]);

const all: [string, unknown][] = [
  [notes, notesType],
  [spec, numbered],
  [shiyou, numbered],
  [glossaryA, numbered],
  [glossaryB, numbered],
];

describe("text references that name another checked page", () => {
  it("checks a mention followed by a section, and '{page}の{n}章', against that page", async () => {
    const result = await check(all);
    expect(result.code).toBe(1);
    const [notesPage, ...others] = result.output.pages;
    // Correct: "Spec 2.1 "Rate limits"", "Spec 3", "仕様書の3章", "see section 1".
    // Not checked: "section 2 of Glossary" (two checked pages are titled Glossary), the
    // mention of History (not checked), and "section 7 of "Roadmap"" (no such checked page).
    expect(summary(notesPage)).toEqual([
      [
        "references.mismatch",
        blockId(103),
        '"Spec 2.1 "Quotas"": on the page "Spec", 2.1 is "Rate limits"; "Quotas" is 2.2',
      ],
      ["references.number", blockId(105), '"Spec 4": on the page "Spec", there is no section 4'],
      [
        "references.number",
        blockId(107),
        '"仕様書の5章": on the page "仕様書", there is no section 5',
      ],
    ]);
    expect(notesPage?.violations[0]?.suggestions).toEqual([
      { message: "Change the number to 2.2", replacement: 'Spec 2.2 "Quotas"' },
      { message: 'Change the title to "Rate limits"', replacement: 'Spec 2.1 "Rate limits"' },
    ]);
    expect(notesPage?.violations.map((v) => v.path)).toEqual([
      "references.patterns[1]",
      "references.patterns[2]",
      "references.patterns[3]",
    ]);
    expect(notesPage?.violations[0]?.url).toMatch(/#7a5b0c1d2e3f8000e001000000000103$/);
    for (const page of others) expect(page.violations).toEqual([]);
  });

  it("fetches no page twice, and reads only the unchecked mention for existence", async () => {
    const result = await check(all);
    const counts = new Map<string, number>();
    for (const call of result.calls) counts.set(call, (counts.get(call) ?? 0) + 1);
    expect([...counts.entries()].filter(([, n]) => n > 1)).toEqual([]);
    expect(result.calls.filter((c) => c.startsWith("GET /v1/pages/")).sort()).toEqual(
      all.map(([id]) => `GET /v1/pages/${id}`).sort(),
    );
    expect(
      result.calls.filter((c) => c.startsWith("GET /v1/blocks/") && !c.endsWith("/children")),
    ).toEqual([`GET /v1/blocks/${history}`]);
  });

  it("falls back when the named page is not checked: existence for mentions, nothing for text", async () => {
    const result = await check([
      [notes, notesType],
      [glossaryA, numbered],
      [glossaryB, numbered],
    ]);
    // "Spec 2.1 "Quotas"", "Spec 4" and "仕様書の5章" are not checked without those pages.
    expect(result.code).toBe(0);
    expect(result.output.pages[0]?.violations).toEqual([]);
    // The mentioned pages are read once each, to check that they exist.
    expect(
      result.calls
        .filter((c) => c.startsWith("GET /v1/blocks/") && !c.endsWith("/children"))
        .sort(),
    ).toEqual([`GET /v1/blocks/${history}`, `GET /v1/blocks/${spec}`].sort());
  });

  it("checks a title once only one checked page has it", async () => {
    const result = await check([
      [notes, notesType],
      [glossaryA, numbered],
    ]);
    expect(summary(result.output.pages[0])).toEqual([
      [
        "references.number",
        blockId(108),
        '"section 2 of Glossary": on the page "Glossary", there is no section 2',
      ],
    ]);
  });

  it("keeps the fixture free of real tokens", () => {
    expect(readFileSync(fixture("notion/page-references.json"), "utf8")).not.toMatch(
      /secret_|ntn_/,
    );
  });
});

describe("page names", () => {
  it("compares titles ignoring case and one pair of enclosing quotes or brackets", () => {
    expect(pageTitleKey("Spec")).toBe("spec");
    expect(pageTitleKey(' "Spec" ')).toBe("spec");
    expect(pageTitleKey("「仕様書」")).toBe("仕様書");
    expect(pageTitleKey("(Spec)")).toBe("spec");
    expect(pageTitleKey("Spec v2")).toBe("spec v2");
    expect(pageTitleKey('""')).toBe('""');
  });

  it("compiles {page}: quoted takes any text, unquoted only the given names", () => {
    const quoted = compileTemplate('section {n} of "{page}"', [], "\\d+", []);
    expect('see section 3 of "Any page"'.match(quoted)?.[0]).toBe('section 3 of "Any page"');
    const named = compileTemplate("{page}の{n}章", [], "\\d+", ["仕様書"]);
    expect([..."詳しくは仕様書の3章、設計書の2章".matchAll(named)].map((m) => m[0])).toEqual([
      "仕様書の3章",
    ]);
    const ascii = compileTemplate("{page} {n}", [], "\\d+", ["Spec"]);
    expect("MySpec 3".match(ascii)).toBeNull();
    expect({ ...[..."see Spec 3".matchAll(ascii)][0]?.groups }).toEqual({ page: "Spec", n: "3" });
    expect(compileTemplate("{page} {n}", [], "\\d+", []).test("Spec 3")).toBe(false);
  });
});
