import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BodyItem } from "../src/normalize/model.js";
import { toMarkdown } from "../src/text/markdown.js";
import { prepareTextlint, TextlintSetupError } from "../src/text/textlint.js";
import { fixture, readFixtureJson, runCli } from "./helpers.js";
import { type Recording, replayFetcher } from "./notion-fake.js";

const recording = readFixtureJson("notion/text-lint.json") as Recording & {
  ids: { pageClean: string; pageDirty: string };
};
const { pageClean, pageDirty } = recording.ids;

const block = (id: string, type: string, text: string, children: BodyItem[] = []): BodyItem => ({
  kind: "block",
  id,
  type,
  text,
  children,
});
const heading = (id: string, level: number, text: string, children: BodyItem[] = []): BodyItem => ({
  kind: "heading",
  id,
  level,
  text,
  children,
});

describe("toMarkdown", () => {
  it("converts the heading tree and keeps a line-to-block map", () => {
    const doc = toMarkdown([
      block("a", "paragraph", "前文です。"),
      heading("h", 2, "目的", [
        block("b", "paragraph", "一行目\n二行目"),
        block("c", "bulleted_list_item", "項目1", [block("d", "bulleted_list_item", "入れ子")]),
        block("e", "bulleted_list_item", "項目2"),
        block("f", "numbered_list_item", "手順1"),
        block("g", "numbered_list_item", "手順2"),
        block("x", "code", "const a = 出来る;"),
        block("q", "quote", "引用です。"),
        block("s", "paragraph", "# 見出しではない"),
        heading("h3", 3, "詳細", [block("i", "paragraph", "本文")]),
      ]),
    ]);
    expect(doc.markdown).toBe(
      [
        "前文です。",
        "",
        "## 目的",
        "",
        "一行目",
        "二行目",
        "",
        "- 項目1",
        "  - 入れ子",
        "- 項目2",
        "",
        "1. 手順1",
        "2. 手順2",
        "",
        "> 引用です。",
        "",
        "\\# 見出しではない",
        "",
        "### 詳細",
        "",
        "本文",
      ].join("\n"),
    );
    const byLine = doc.lines.map((l) => l.blockId);
    expect(byLine[0]).toBe("a");
    expect(byLine[2]).toBe("h");
    expect(byLine.slice(4, 6)).toEqual(["b", "b"]);
    expect(byLine[8]).toBe("d");
    expect(byLine.at(-1)).toBe("i");
    expect(doc.lines.at(-1)?.headings).toEqual(["目的", "詳細"]);
    expect(doc.lines[0]?.headings).toEqual([]);
    expect(doc.lines.some((l) => l.blockId === "x")).toBe(false);
  });

  it("is empty for a body without prose", () => {
    expect(toMarkdown([block("x", "divider", "")]).markdown).toBe("");
  });
});

const baseDir = path.dirname(fixture("prh/terms.yml"));
const noisy = block("t", "paragraph", "これは、とても、長い、文章、です。");

describe("prepareTextlint", () => {
  const rule = { presets: ["ja-technical-writing"], prh: ["./terms.yml"] };

  it("reports preset and prh findings on their blocks, with fix suggestions", async () => {
    const lint = prepareTextlint(rule, baseDir, "type.text.textlint");
    const found = await lint.lintBody([
      heading("h", 2, "目的", [block("p", "paragraph", "設定を変更する事が出来る。"), noisy]),
    ]);
    expect(found.map((f) => [f.blockId, f.path, f.rule, f.severity])).toEqual([
      ["p", "body > 目的", "prh", "warning"],
      ["t", "body > 目的", "ja-technical-writing/max-ten", "warning"],
    ]);
    expect(found[0]?.suggestions).toEqual([
      { message: 'replace "出来る" with "できる"', replacement: "できる" },
    ]);
    expect(found[0]?.message).toContain("出来る => できる");
  });

  it("finds nothing in clean text", async () => {
    const lint = prepareTextlint(rule, baseDir, "type.text.textlint");
    const clean = block("p", "paragraph", "設定を変更できます。");
    expect(await lint.lintBody([heading("h", 2, "目的", [clean])])).toEqual([]);
  });

  it("maps severity: error when a rule is configured as error, warning otherwise", async () => {
    const lint = prepareTextlint(
      {
        presets: ["ja-technical-writing"],
        rules: { "ja-technical-writing/max-ten": { severity: "error" } },
      },
      baseDir,
      "type.text.textlint",
    );
    const found = await lint.lintBody([noisy]);
    expect(found.map((f) => [f.rule, f.severity, f.path])).toEqual([
      ["ja-technical-writing/max-ten", "error", "body"],
    ]);
  });

  it("can switch a preset rule off", async () => {
    const lint = prepareTextlint(
      { presets: ["ja-technical-writing"], rules: { "ja-technical-writing/max-ten": false } },
      baseDir,
      "type.text.textlint",
    );
    expect(await lint.lintBody([noisy])).toEqual([]);
  });

  it("fails on a missing preset, dictionary, or unknown rule", () => {
    const p = (r: object) => () => prepareTextlint(r, baseDir, "type.text.textlint");
    expect(p({ presets: ["no-such-preset"] })).toThrow(TextlintSetupError);
    expect(p({ presets: ["no-such-preset"] })).toThrow(
      /type\.text\.textlint\.presets\[0\].*"no-such-preset" is not installed/,
    );
    expect(p({ prh: ["./missing.yml"] })).toThrow(/prh\[0\]: prh dictionary not found/);
    expect(
      p({ presets: ["ja-technical-writing"], rules: { "ja-technical-writing/nope": true } }),
    ).toThrow(/no rule "ja-technical-writing\/nope"/);
  });
});

describe("check with text.textlint", () => {
  const type = {
    body: [
      { heading: 2, title: "目的" },
      { heading: 2, title: "詳細" },
    ],
    text: { textlint: { presets: ["ja-technical-writing"], prh: ["./terms.yml"] } },
  };

  function run(page: string, config: object = { type }, cwd = baseDir) {
    return runCli(["--config-json", JSON.stringify(config), "--page", page, "--format", "json"], {
      env: { NOTION_TOKEN: "secret_test_token_value" },
      cwd,
      createFetcher: () => replayFetcher(recording),
    });
  }

  it("passes a clean page, and does not lint code blocks", async () => {
    const result = await run(pageClean);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.summary).toMatchObject({ violations: 0 });
    expect(output.notes).toEqual([]);
  });

  it("reports findings with block IDs, paths, rules and links", async () => {
    const result = await run(pageDirty);
    expect(result.code).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.summary).toMatchObject({ violations: 2, errors: 0, warnings: 2 });
    const violations = output.pages[0].violations;
    expect(
      violations.map((v: { path: string; rule: string; blockId: string }) => [
        v.path,
        v.rule,
        v.blockId,
      ]),
    ).toEqual([
      ["body > 目的", "prh", "3b9c0d1e-2f3a-8000-b001-000000000002"],
      ["body > 詳細 > 通知", "prh", "3b9c0d1e-2f3a-8000-b001-000000000005"],
    ]);
    expect(violations[0]).toMatchObject({
      severity: "warning",
      suggestions: [{ replacement: "できる" }],
      url: expect.stringMatching(/#3b9c0d1e2f3a8000b001000000000002$/),
    });
    expect(violations[1].message).toContain("ユーザ => ユーザー");
  });

  it("resolves prh paths from the config file's directory, and a missing one is exit 2", async () => {
    const result = await run(pageDirty, { type }, path.dirname(baseDir));
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      kind: "config",
      message: expect.stringContaining("type.text.textlint.prh[0]: prh dictionary not found"),
    });
  });

  it("a missing preset is exit 2", async () => {
    const result = await run(pageDirty, {
      type: { text: { textlint: { presets: ["no-such-preset"] } } },
    });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toContain('"no-such-preset" is not installed');
  });

  it("lints the body even when the type has no body rules", async () => {
    const result = await run(pageDirty, { type: { text: type.text } });
    expect(result.code).toBe(1);
  });
});
