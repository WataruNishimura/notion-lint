import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configJsonSchema, resultJsonSchema } from "../src/index.js";
import { fixture, readFixtureJson, runCli } from "./helpers.js";

const designJson = readFixtureJson("design-example.json");

/** A config that breaks the schema in three places. Issues follow the schema order (properties before body). */
const INVALID = JSON.stringify({
  type: {
    body: [
      { heading: 7, title: "目的" },
      { block: "to_do", min: -1 },
    ],
    properties: { 参加者: { type: "people", min: "1" } },
  },
});

const EXPECTED_ISSUES = [
  expect.objectContaining({
    path: "type.properties.参加者.min",
    pointer: "/type/properties/参加者/min",
    keyword: "type",
  }),
  expect.objectContaining({
    path: "type.body[0].heading",
    pointer: "/type/body/0/heading",
    keyword: "enum",
  }),
  expect.objectContaining({
    path: "type.body[1].min",
    pointer: "/type/body/1/min",
    keyword: "minimum",
  }),
];

function parse(text: string): unknown {
  return JSON.parse(text);
}

describe("notion-lint schema", () => {
  it("prints the config JSON Schema", async () => {
    const result = await runCli(["schema"]);
    expect(result.code).toBe(0);
    expect(parse(result.stdout)).toStrictEqual(configJsonSchema());
  });

  it("prints the result JSON Schema", async () => {
    const result = await runCli(["schema", "result"]);
    expect(result.code).toBe(0);
    expect(parse(result.stdout)).toStrictEqual(resultJsonSchema());
  });

  it("rejects an unknown schema name", async () => {
    const result = await runCli(["schema", "nope"]);
    expect(result.code).toBe(2);
    expect(parse(result.stderr)).toMatchObject({ ok: false, error: { kind: "usage" } });
  });
});

describe("notion-lint print-config", () => {
  it("runs a TS config and prints it as JSON equal to the hand-written JSON", async () => {
    const result = await runCli(["print-config", "--config", fixture("design-example.config.ts")]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(parse(result.stdout)).toStrictEqual(designJson);
  });

  it("reads JSON from stdin with --config -", async () => {
    const result = await runCli(["print-config", "--config", "-"], {
      stdin: JSON.stringify(designJson),
    });
    expect(result.code).toBe(0);
    expect(parse(result.stdout)).toStrictEqual(designJson);
  });

  it("reads JSON from --config-json", async () => {
    const result = await runCli(["print-config", "--config-json", JSON.stringify(designJson)]);
    expect(result.code).toBe(0);
    expect(parse(result.stdout)).toStrictEqual(designJson);
  });

  it("finds notion-lint.config.ts in the current directory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "notion-lint-"));
    writeFileSync(
      path.join(dir, "notion-lint.config.ts"),
      `import { defineConfig, doc, h } from "notion-lint";
export default defineConfig({ type: doc({ body: [h.h2("目的")] }) });
`,
    );
    const result = await runCli(["print-config"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(parse(result.stdout)).toStrictEqual({ type: { body: [{ heading: 2, title: "目的" }] } });
  });

  it.each([
    ["--config -", ["--config", "-"], INVALID],
    ["--config-json", ["--config-json", INVALID], undefined],
  ])("exits 2 with JSON issues for an invalid config from %s", async (_, args, stdin) => {
    const result = await runCli(["print-config", ...args], { stdin });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    const output = parse(result.stderr);
    expect(output).toMatchObject({ ok: false, error: { kind: "config" } });
    expect((output as { error: { issues: unknown[] } }).error.issues).toEqual(EXPECTED_ISSUES);
  });

  it("does not execute a .json config as code", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "notion-lint-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "globalThis.__notionLintRan = true; export default { type: {} }");
    const result = await runCli(["print-config", "--config", file]);
    expect(result.code).toBe(2);
    expect((globalThis as { __notionLintRan?: boolean }).__notionLintRan).toBeUndefined();
    expect(parse(result.stderr)).toMatchObject({
      error: { kind: "config", message: expect.stringContaining("JSON として読めません") },
    });
  });

  it("reports malformed JSON and empty stdin as config errors", async () => {
    for (const [args, stdin] of [
      [["--config-json", "{type:"], undefined],
      [["--config", "-"], "  "],
    ] as const) {
      const result = await runCli(["print-config", ...args], { stdin });
      expect(result.code).toBe(2);
      expect(parse(result.stderr)).toMatchObject({ ok: false, error: { kind: "config" } });
    }
  });

  it("reports a TS config that exports a function", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "notion-lint-"));
    const file = path.join(dir, "bad.config.ts");
    writeFileSync(file, "export default { type: { body: [() => 1] } };\n");
    const result = await runCli(["print-config", "--config", file]);
    expect(result.code).toBe(2);
    expect(parse(result.stderr)).toMatchObject({
      error: { kind: "config", message: expect.stringContaining("type.body[0]") },
    });
  });

  it("rejects --config together with --config-json", async () => {
    const result = await runCli(["print-config", "--config", "-", "--config-json", "{}"]);
    expect(result.code).toBe(2);
    expect(parse(result.stderr)).toMatchObject({ error: { kind: "usage" } });
  });
});

describe("notion-lint check", () => {
  it.each([
    ["--config -", ["--config", "-"], INVALID],
    ["--config-json", ["--config-json", INVALID], undefined],
  ])(
    "exits 2 with a JSON error on stdout for an invalid config from %s",
    async (_, args, stdin) => {
      const result = await runCli([...args, "--format", "json"], { stdin });
      expect(result.code).toBe(2);
      const output = parse(result.stdout);
      expect(output).toMatchObject({ ok: false, error: { kind: "config" } });
      expect((output as { error: { issues: unknown[] } }).error.issues).toEqual(EXPECTED_ISSUES);
    },
  );

  it("prints config errors for people in text format", async () => {
    const result = await runCli(["check", "--config-json", INVALID]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("✖ type.body[0].heading");
    expect(result.stderr).toContain("✖ type.properties.参加者.min");
  });

  it("accepts --page and --format json, then reports that checking is not implemented yet", async () => {
    const result = await runCli(
      [
        "--config",
        "-",
        "--page",
        "https://www.notion.so/xxxx-0123456789abcdef0123456789abcdef",
        "--format",
        "json",
      ],
      { stdin: '{"type":{"body":[{"heading":2,"title":"目的"}]}}' },
    );
    expect(result.code).toBe(2);
    expect(parse(result.stdout)).toMatchObject({
      ok: false,
      error: { kind: "internal", code: "not_implemented", source: "stdin" },
    });
  });

  it("rejects a bad --page or --format as a usage error", async () => {
    const config = '{"type":{}}';
    const page = await runCli(["--config-json", config, "--page", "nope", "--format=json"]);
    expect(page.code).toBe(2);
    expect(parse(page.stdout)).toMatchObject({ error: { kind: "usage" } });

    const format = await runCli(["--config-json", config, "--format", "xml"]);
    expect(format.code).toBe(2);
    expect(format.stderr).toContain("--format");
  });

  it("needs a type in the config to check --page", async () => {
    const result = await runCli([
      "--config-json",
      JSON.stringify({ targets: [{ page: "p", type: {} }] }),
      "--page",
      "0123456789abcdef0123456789abcdef",
      "--format",
      "json",
    ]);
    expect(result.code).toBe(2);
    expect(parse(result.stdout)).toMatchObject({ error: { kind: "usage" } });
  });
});

describe("the notion-lint process", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));

  it("exits 2 with a JSON error for an invalid config piped to --config -", () => {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--config", "-", "--format", "json"],
      { cwd: root, input: INVALID, encoding: "utf8" },
    );
    expect(child.status).toBe(2);
    const output = parse(child.stdout);
    expect((output as { error: { issues: unknown[] } }).error.issues).toEqual(EXPECTED_ISSUES);
  });

  it("prints the version", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
