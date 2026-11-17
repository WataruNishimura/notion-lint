import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Names to look for, lowercase. `.claude/CLAUDE.md` is handled separately. */
const TOP_LEVEL = ["agents.md", "agent.md", "claude.md"];

/** The first directory at or above `cwd` that contains `.git` (a directory, or a file for worktrees). */
export function findRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Instruction files in the root, matched case-insensitively. Returns absolute paths in a stable order. */
export function findInstructionFiles(root: string): string[] {
  const found: string[] = [];
  const names = entries(root);
  for (const wanted of TOP_LEVEL) {
    for (const name of names) {
      if (name.toLowerCase() === wanted && isFile(path.join(root, name))) {
        found.push(path.join(root, name));
      }
    }
  }
  for (const dirName of names) {
    if (dirName.toLowerCase() !== ".claude") continue;
    const dir = path.join(root, dirName);
    for (const name of entries(dir)) {
      if (name.toLowerCase() === "claude.md" && isFile(path.join(dir, name))) {
        found.push(path.join(dir, name));
      }
    }
  }
  return found;
}

const same = (a: string, b: string): boolean =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Paths imported with `@path` on their own line (outside code fences), resolved against the file. */
export function importsOf(file: string, text: string): string[] {
  const result: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\s*@(\S+)\s*$/.exec(line);
    if (match?.[1] !== undefined) result.push(path.resolve(path.dirname(file), match[1]));
  }
  return result;
}

/**
 * Pick the files to write. A file that imports another found file is left out, so the text is
 * not loaded twice (for example `CLAUDE.md` containing `@AGENTS.md`).
 */
export function chooseTargets(files: string[]): string[] {
  const imports = new Map(
    files.map((file) => [file, importsOf(file, readFileSync(file, "utf8"))] as const),
  );
  return files.filter(
    (file) =>
      !files.some(
        (other) =>
          !same(other, file) && (imports.get(file) ?? []).some((target) => same(target, other)),
      ),
  );
}
