import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatErrorGithub } from "../src/report/index.js";
import type { ErrorResult } from "../src/schema/result.js";
import { readFixtureJson, runCli } from "./helpers.js";
import { meetingNotes, replayFetcher } from "./notion-fake.js";

const config = JSON.stringify(readFixtureJson("meeting-notes.config.json") as { type: unknown });
const env = { NOTION_TOKEN: "secret_test_token_value" };
const missing = "0123456789abcdef0123456789abcdef";

const BAD_CONFIG = JSON.stringify({ type: { body: [{ heading: 7, title: "Purpose" }] } });

describe("formatErrorGithub", () => {
  it("formats a config error with its file and the mismatched fields", () => {
    const result: ErrorResult = {
      ok: false,
      error: {
        kind: "config",
        message: "The config does not match the JSON Schema (1 issue(s))",
        source: "configs/notion-lint.config.json",
        issues: [
          {
            path: "type.body[0].heading",
            pointer: "/type/body/0/heading",
            keyword: "enum",
            message: "must be one of: 1, 2, 3",
          },
        ],
      },
    };
    expect(formatErrorGithub(result)).toBe(
      "::error file=configs/notion-lint.config.json,title=notion-lint error::" +
        "The config does not match the JSON Schema (1 issue(s))%0A  ✖ type.body[0].heading  must be one of: 1, 2, 3\n" +
        "notion-lint: stopped by a config error (exit code 2)\n",
    );
  });

  it("escapes special characters in the message and the file name", () => {
    const out = formatErrorGithub({
      ok: false,
      error: { kind: "config", message: "100% bad\r\nline", source: "a,b:c.json" },
    });
    expect(out).toContain("file=a%2Cb%3Ac.json,title=");
    expect(out).toContain("::100%25 bad%0D%0Aline\n");
  });

  it("sets no file for stdin, --config-json, or non-config errors", () => {
    for (const source of ["stdin", "--config-json"]) {
      const out = formatErrorGithub({ ok: false, error: { kind: "config", message: "x", source } });
      expect(out.startsWith("::error title=notion-lint error::x\n")).toBe(true);
    }
    const api = formatErrorGithub({
      ok: false,
      error: { kind: "api", message: "x", source: "notion-lint.config.json" },
    });
    expect(api.startsWith("::error title=")).toBe(true);
  });
});

describe("notion-lint check --format github errors (exit 2)", () => {
  it("reports a config error from a file as an annotation on that file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "notion-lint-annotation-"));
    const file = path.join(dir, "bad.config.json");
    writeFileSync(file, BAD_CONFIG);
    const result = await runCli(["--config", file, "--format", "github"], { env });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    const [annotation, summary] = result.stdout.trimEnd().split("\n");
    expect(annotation).toMatch(/^::error file=.*bad\.config\.json,title=notion-lint error::/);
    expect(annotation).toContain("%0A  ✖ type.body[0].heading  must be one of: 1, 2, 3");
    expect(summary).toBe("notion-lint: stopped by a config error (exit code 2)");
  });

  it("reports a Notion API error with the page ID in the message", async () => {
    const result = await runCli(
      ["--config-json", config, "--page", missing, "--format", "github"],
      { env, createFetcher: () => replayFetcher(meetingNotes) },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^::error title=notion-lint error::.*01234567-89ab/);
    expect(result.stdout).not.toContain("file=");
    expect(result.stdout).not.toContain(env.NOTION_TOKEN);
  });

  it("reports invalid arguments as an annotation", async () => {
    const result = await runCli(["--config-json", config, "--page", "nope", "--format=github"], {
      env,
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "::error title=notion-lint error::--page needs a page URL or ID",
    );
  });

  it("keeps the text format as it was", async () => {
    const result = await runCli(["--config-json", BAD_CONFIG], { env });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^notion-lint: The config does not match/);
    expect(result.stderr).not.toContain("::error");
  });

  it("keeps the JSON format as it was", async () => {
    const result = await runCli(["--config-json", BAD_CONFIG, "--format", "json"], { env });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { kind: "config" } });
  });

  it("still reports violations as before when nothing fails", async () => {
    const result = await runCli(
      ["--config-json", config, "--page", meetingNotes.ids.pageBad, "--format", "github"],
      { env, createFetcher: () => replayFetcher(meetingNotes) },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("::error title=notion-lint ");
    expect(result.stdout).not.toContain("notion-lint error");
  });
});
