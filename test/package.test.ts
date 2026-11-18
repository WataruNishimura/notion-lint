import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** `npm` is a .cmd file on Windows, which needs a shell to start. */
function npm(args: string[]) {
  return spawnSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
}

interface PackFile {
  path: string;
}

let files: string[] = [];

describe("npm package", () => {
  beforeAll(() => {
    // Start from a clean build so that stale files cannot hide a problem or end up in the tarball.
    rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
    const build = npm(["run", "build"]);
    expect(build.status, build.stderr + build.stdout).toBe(0);
    // --ignore-scripts: the build above is the prepack step, so do not run it twice.
    const pack = npm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
    expect(pack.status, pack.stderr).toBe(0);
    const [entry] = JSON.parse(pack.stdout) as { files: PackFile[] }[];
    files = (entry?.files ?? []).map((file) => file.path.replaceAll("\\", "/"));
  }, 120_000);

  it("contains what the CLI needs at runtime", () => {
    for (const required of [
      "dist/cli.js",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/version.js",
      "schema/notion-lint.schema.json",
      "schema/result.schema.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "package.json",
    ]) {
      expect(files, `${required} is missing from the tarball`).toContain(required);
    }
  });

  it("contains nothing from the source tree, tests, or repository settings", () => {
    const allowed = /^(dist\/|schema\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/;
    expect(files.filter((file) => !allowed.test(file))).toEqual([]);
    expect(
      files.filter((file) => /\.map$|\.test\.|(^|\/)(fixtures|\.github)\//.test(file)),
    ).toEqual([]);
  });

  it("starts the built CLI", () => {
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(pkg.version);
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");
  });
});
