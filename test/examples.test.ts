import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";

const dir = resolve(import.meta.dirname, "../examples/github-actions");
const workflow = readFileSync(resolve(dir, "notion-lint.yml"), "utf8");

describe("examples/github-actions", () => {
  it("has an example config that passes validation", async () => {
    const result = await runCli([
      "print-config",
      "--config",
      resolve(dir, "notion-lint.config.json"),
    ]);
    expect(result.code, result.stderr).toBe(0);
  });

  it("runs on a schedule and by hand, and passes the token only as a secret", () => {
    expect(workflow).toMatch(/^ {2}schedule:\r?\n(?: {4}#.*\r?\n)* {4}- cron: /m);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("NOTION_TOKEN: $" + "{{ secrets.NOTION_TOKEN }}");
    expect(workflow).not.toMatch(/(secret|ntn)_[A-Za-z0-9]{20,}/);
    expect(workflow).toContain("--config notion-lint.config.json --format github");
  });
});
