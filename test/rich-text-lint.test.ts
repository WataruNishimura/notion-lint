import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeBlocks } from "../src/normalize/index.js";
import type { BodyItem } from "../src/normalize/model.js";
import type { CheckResult } from "../src/schema/result.js";
import { toMarkdown } from "../src/text/markdown.js";
import { fixture, readFixtureJson, runCli } from "./helpers.js";
import { type Recording, replayFetcher } from "./notion-fake.js";

const recording = readFixtureJson("notion/rich-text-lint.json") as Recording & {
  ids: { pageClean: string; pageDirty: string };
};
const { pageClean, pageDirty } = recording.ids;
const baseDir = path.dirname(fixture("prh/terms.yml"));

async function lint(page: string, presets: string[] = []) {
  const type = { text: { textlint: { presets, prh: ["./terms.yml"] } } };
  const result = await runCli(
    ["--config-json", JSON.stringify({ type }), "--page", page, "--format", "json"],
    {
      env: { NOTION_TOKEN: "secret_test_token_value" },
      cwd: baseDir,
      createFetcher: () => replayFetcher(recording),
    },
  );
  return { ...result, output: JSON.parse(result.stdout) as CheckResult };
}

const blockId = (n: number) => `8b6c1d2e-3f40-8000-f001-000000000${n}`;

describe("textlint on rich text and tables", () => {
  it("passes the clean page, with the preset too", async () => {
    for (const presets of [[], ["ja-technical-writing"]]) {
      const result = await lint(pageClean, presets);
      expect(result.output.pages[0]?.violations).toEqual([]);
      expect(result.code).toBe(0);
    }
  });

  it("finds a problem in bold text, in link text, and in a table cell", async () => {
    const result = await lint(pageDirty);
    expect(result.code).toBe(1);
    const violations = result.output.pages[0]?.violations ?? [];
    // Inline code, the equation and the mention also say 出来る, but are not prose.
    expect(violations.map((v) => [v.blockId, v.path, v.rule])).toEqual([
      [blockId(202), "body > 目的", "prh"],
      [blockId(203), "body > 目的", "prh"],
      [blockId(212), "body > 設定", "prh"],
    ]);
    // The cell's violation is on its table row block, and names the row and the column.
    const cell = violations[2];
    expect(cell?.message).toMatch(/^row 2, column 2: 出来る => できる/);
    expect(cell?.url).toMatch(/#8b6c1d2e3f408000f001000000000212$/);
    expect(cell?.suggestions).toEqual([
      { message: 'replace "出来る" with "できる"', replacement: "できる" },
    ]);
    expect(violations[0]?.message).not.toMatch(/^row/);
  });
});

describe("toMarkdown with rich text", () => {
  const raw = recording.responses as Record<string, { results: unknown[] }[]>;
  const tree = (id: string): BodyItem[] => {
    const load = (blockId: string): { block: Record<string, unknown>; children: never[] }[] =>
      (raw[`GET /v1/blocks/${blockId}/children`]?.[0]?.results ?? []).map((block) => {
        const b = block as Record<string, unknown>;
        return {
          block: b,
          children: (b.has_children === true ? load(b.id as string) : []) as never[],
        };
      });
    return normalizeBlocks(load(id));
  };

  it("writes inline code, equations and mentions as code spans, and links as their text", () => {
    const doc = toMarkdown(tree(pageDirty));
    expect(doc.markdown.split("\n")).toEqual([
      "## 目的",
      "",
      "この画面では設定を変更出来る。",
      "",
      "手順は変更出来る手順を見てください。",
      "",
      "値は`出来る_flag`と`出来る`で、詳細は`出来るまで`にあります。",
      "",
      "## 設定",
      "",
      "| 項目 | 説明 | 備考 |",
      "| --- | --- | --- |",
      "| 通知 | 通知を止めることが出来る。 | `a\\|b` を使う |",
      "|  | 空欄の次 | 最後 |",
      "",
      "以上です。",
    ]);
    const row = doc.lines[12];
    expect(row).toMatchObject({ blockId: blockId(212), row: 2 });
    expect(
      row?.cells?.map(({ start, end }) => doc.markdown.split("\n")[12]?.slice(start, end)),
    ).toEqual(["通知", "通知を止めることが出来る。", "`a\\|b` を使う"]);
  });

  it("escapes Markdown syntax in prose", () => {
    const block = (text: string): BodyItem => ({
      kind: "block",
      id: "p",
      type: "paragraph",
      text,
      rich: [[{ kind: "text", text, start: 0 }]],
      children: [],
    });
    expect(toMarkdown([block("a*b*c <x> [y](z) `q` ~~s~~ & \\")]).markdown).toBe(
      "a\\*b\\*c \\<x> \\[y\\](z) \\`q\\` \\~\\~s\\~\\~ \\& \\\\",
    );
  });
});
