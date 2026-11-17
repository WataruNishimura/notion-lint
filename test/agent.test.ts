import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { END_MARKER, START_MARKER } from "../src/agent/section.js";
import { VERSION } from "../src/version.js";
import { runCli } from "./helpers.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "notion-lint-agent-")));
  mkdirSync(path.join(root, ".git"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (name: string, content: string): void => {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), content);
};
const read = (name: string): string => readFileSync(path.join(root, name), "utf8");
const agent = (args: string[] = [], cwd = root) => runCli(["agent", ...args], { cwd });
const hasSection = (text: string): boolean =>
  text.includes(START_MARKER) && text.includes(END_MARKER);
const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("agent: where to write", () => {
  it("writes to the only file found", async () => {
    write("AGENTS.md", "# Rules\n");
    const result = await agent();
    expect(result.code).toBe(0);
    expect(hasSection(read("AGENTS.md"))).toBe(true);
    expect(read("AGENTS.md").startsWith("# Rules\n\n<!-- notion-lint:start -->\n")).toBe(true);
  });

  it("writes only to AGENTS.md when CLAUDE.md imports it", async () => {
    write("AGENTS.md", "# Rules\n");
    write("CLAUDE.md", "@AGENTS.md\n\nMore.\n");
    expect((await agent()).code).toBe(0);
    expect(hasSection(read("AGENTS.md"))).toBe(true);
    expect(read("CLAUDE.md")).toBe("@AGENTS.md\n\nMore.\n");
  });

  it("writes only to AGENTS.md when .claude/CLAUDE.md imports it", async () => {
    write("AGENTS.md", "# Rules\n");
    write(".claude/CLAUDE.md", "@../AGENTS.md\n");
    expect((await agent()).code).toBe(0);
    expect(hasSection(read("AGENTS.md"))).toBe(true);
    expect(hasSection(read(".claude/CLAUDE.md"))).toBe(false);
  });

  it("writes to every file when none imports another", async () => {
    write("AGENTS.md", "# A\n");
    write("CLAUDE.md", "# C\n");
    expect((await agent()).code).toBe(0);
    expect(hasSection(read("AGENTS.md"))).toBe(true);
    expect(hasSection(read("CLAUDE.md"))).toBe(true);
  });

  it("writes nothing and exits with 2 when no file exists", async () => {
    const result = await agent();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--create AGENTS.md");
    expect(result.stderr).toContain("Nothing was written");
  });
});

describe("agent: detection", () => {
  it("matches file names case-insensitively", async () => {
    write("agents.MD", "# Rules\n");
    expect((await agent()).code).toBe(0);
    expect(hasSection(read("agents.MD"))).toBe(true);
  });

  it("finds .claude/CLAUDE.md and AGENT.md", async () => {
    write("AGENT.md", "# A\n");
    write(".claude/claude.md", "# C\n");
    expect((await agent()).code).toBe(0);
    expect(hasSection(read("AGENT.md"))).toBe(true);
    expect(hasSection(read(".claude/claude.md"))).toBe(true);
  });

  it("looks in the Git root when run from a subdirectory", async () => {
    write("AGENTS.md", "# Rules\n");
    mkdirSync(path.join(root, "packages", "a"), { recursive: true });
    write("packages/a/AGENTS.md", "# Nested\n");
    expect((await agent([], path.join(root, "packages", "a"))).code).toBe(0);
    expect(hasSection(read("AGENTS.md"))).toBe(true);
    expect(hasSection(read("packages/a/AGENTS.md"))).toBe(false);
  });

  it("uses the current directory outside Git", async () => {
    const plain = realpathSync(mkdtempSync(path.join(tmpdir(), "notion-lint-nogit-")));
    try {
      writeFileSync(path.join(plain, "AGENTS.md"), "# Rules\n");
      mkdirSync(path.join(plain, "sub"));
      // From a subdirectory there is no Git root to walk up to, so nothing is found there.
      const sub = await runCli(["agent"], { cwd: path.join(plain, "sub") });
      expect(sub.code).toBe(2);
      const top = await runCli(["agent"], { cwd: plain });
      expect(top.code).toBe(0);
      expect(hasSection(readFileSync(path.join(plain, "AGENTS.md"), "utf8"))).toBe(true);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("agent: the section", () => {
  it("does not duplicate on a second run", async () => {
    write("AGENTS.md", "# Rules\n");
    await agent();
    const once = read("AGENTS.md");
    const second = await agent();
    expect(second.code).toBe(0);
    expect(read("AGENTS.md")).toBe(once);
    expect(count(read("AGENTS.md"), START_MARKER)).toBe(1);
  });

  it("replaces a stale section and leaves the text outside the markers unchanged", async () => {
    const before = "# Top\r\n\r\nintro";
    const after = "\r\n\r\n## After\r\nlast line without newline";
    write("AGENTS.md", `${before}\r\n${START_MARKER}\r\nold 0.0.1 text\r\n${END_MARKER}${after}`);
    expect((await agent()).code).toBe(0);
    const text = read("AGENTS.md");
    expect(text.startsWith(`${before}\r\n${START_MARKER}\r\n`)).toBe(true);
    expect(text.endsWith(`${END_MARKER}${after}`)).toBe(true);
    expect(text).not.toContain("old 0.0.1");
    expect(text).toContain(`notion-lint ${VERSION}`);
    expect(text).not.toMatch(/[^\r]\n/);
  });

  it("keeps a missing final newline and CRLF endings in the text it does not touch", async () => {
    write("AGENTS.md", "# Rules\r\nno newline at end");
    await agent();
    const text = read("AGENTS.md");
    expect(text.startsWith("# Rules\r\nno newline at end\r\n\r\n<!-- notion-lint:start -->")).toBe(
      true,
    );
  });

  it("is short, in English, and covers the listed points", async () => {
    const { stdout } = await agent(["--print"]);
    expect(stdout.split("\n").length).toBeLessThan(15);
    for (const needle of [
      "notion-lint schema",
      "--config -",
      "--format json",
      "0 = no violations",
      "NOTION_TOKEN",
      "notion-lint.config.ts",
      VERSION,
    ]) {
      expect(stdout).toContain(needle);
    }
  });

  it("refuses to touch a file with unbalanced markers", async () => {
    write("AGENTS.md", `# Rules\n${START_MARKER}\nno end\n`);
    const result = await agent();
    expect(result.code).toBe(2);
    expect(read("AGENTS.md")).toBe(`# Rules\n${START_MARKER}\nno end\n`);
  });
});

describe("agent: options", () => {
  it("--target writes only to that file", async () => {
    write("AGENTS.md", "# A\n");
    write("docs/rules.md", "# Docs\n");
    expect((await agent(["--target", "docs/rules.md"])).code).toBe(0);
    expect(hasSection(read("docs/rules.md"))).toBe(true);
    expect(hasSection(read("AGENTS.md"))).toBe(false);
  });

  it("--target fails when the file does not exist", async () => {
    const result = await agent(["--target", "nope.md"]);
    expect(result.code).toBe(2);
  });

  it("--dry-run shows a diff and writes nothing", async () => {
    write("AGENTS.md", "# Rules\n");
    const result = await agent(["--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--- AGENTS.md");
    expect(result.stdout).toContain(`+${START_MARKER}`);
    expect(read("AGENTS.md")).toBe("# Rules\n");
  });

  it("--print prints the section and touches no file, even with none present", async () => {
    const result = await agent(["--print"]);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith(`${START_MARKER}\n`)).toBe(true);
    expect(result.stdout.endsWith(`${END_MARKER}\n`)).toBe(true);
  });

  it("--remove deletes the section and restores the original text", async () => {
    write("AGENTS.md", "# Rules\n");
    await agent();
    expect(hasSection(read("AGENTS.md"))).toBe(true);
    expect((await agent(["--remove"])).code).toBe(0);
    expect(read("AGENTS.md")).toBe("# Rules\n");
  });

  it("--remove keeps text after the section", async () => {
    write("AGENTS.md", `# Top\n\n${START_MARKER}\nx\n${END_MARKER}\n\n## After\n`);
    await agent(["--remove"]);
    expect(read("AGENTS.md")).toBe("# Top\n\n\n## After\n");
  });

  it("--create makes the file when none exists", async () => {
    const result = await agent(["--create", "AGENTS.md"]);
    expect(result.code).toBe(0);
    expect(hasSection(read("AGENTS.md"))).toBe(true);
    expect(read("AGENTS.md").startsWith(START_MARKER)).toBe(true);
  });

  it("--create is ignored when a file already exists", async () => {
    write("CLAUDE.md", "# C\n");
    expect((await agent(["--create", "AGENTS.md"])).code).toBe(0);
    expect(hasSection(read("CLAUDE.md"))).toBe(true);
    expect(() => read("AGENTS.md")).toThrow();
  });
});
