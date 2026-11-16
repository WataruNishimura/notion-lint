import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { Config } from "../schema/config.js";
import type { ConfigIssue } from "../schema/validate.js";
import { validateConfig } from "../schema/validate.js";
import { ConfigDataError, toData } from "./to-data.js";

/**
 * Where the config comes from.
 * - `file`: a path. `.json` is parsed as JSON; `.ts` / `.mts` / `.js` / `.mjs` ... are executed with jiti.
 * - `stdin`: JSON on standard input (`--config -`).
 * - `inline`: JSON in an argument (`--config-json '...'`).
 *
 * JSON is never executed as code; only TS/JS config files are.
 */
export type ConfigSource =
  | { kind: "file"; path: string }
  | { kind: "stdin" }
  | { kind: "inline"; json: string };

export type LoadResult =
  | { ok: true; config: Config; source: string }
  | { ok: false; source: string; message: string; issues?: ConfigIssue[] };

/** File names looked up in the current directory when no config is given. */
export const DEFAULT_CONFIG_FILES = [
  "notion-lint.config.ts",
  "notion-lint.config.mts",
  "notion-lint.config.js",
  "notion-lint.config.mjs",
  "notion-lint.config.json",
] as const;

export function findDefaultConfig(cwd: string): string | undefined {
  for (const name of DEFAULT_CONFIG_FILES) {
    const file = path.join(cwd, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

export function describeSource(source: ConfigSource): string {
  switch (source.kind) {
    case "file":
      return source.path;
    case "stdin":
      return "stdin";
    case "inline":
      return "--config-json";
  }
}

const JSON_EXTENSIONS = new Set([".json"]);
const CODE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

export interface LoadOptions {
  cwd: string;
  readStdin: () => Promise<string>;
}

export async function loadConfig(source: ConfigSource, options: LoadOptions): Promise<LoadResult> {
  const label = describeSource(source);
  let data: unknown;
  try {
    data = await readSource(source, options);
  } catch (error) {
    return { ok: false, source: label, message: errorMessage(error) };
  }

  const result = validateConfig(data);
  if (!result.ok) {
    return {
      ok: false,
      source: label,
      message: `設定が JSON Schema に合いません (${result.issues.length} 件)。notion-lint schema で Schema を確認できます`,
      issues: result.issues,
    };
  }
  return { ok: true, config: result.config, source: label };
}

async function readSource(source: ConfigSource, options: LoadOptions): Promise<unknown> {
  switch (source.kind) {
    case "stdin":
      return parseJson(await options.readStdin(), "標準入力");
    case "inline":
      return parseJson(source.json, "--config-json");
    case "file": {
      const file = path.resolve(options.cwd, source.path);
      const ext = path.extname(file).toLowerCase();
      if (JSON_EXTENSIONS.has(ext)) {
        return parseJson(await readFileOrThrow(file), file);
      }
      if (CODE_EXTENSIONS.has(ext)) return importConfigModule(file);
      throw new Error(
        `設定ファイルの拡張子 ${ext || "(なし)"} は扱えません (.ts / .mts / .js / .mjs / .json)`,
      );
    }
  }
}

async function readFileOrThrow(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`設定ファイルがありません: ${file}`);
    }
    throw error;
  }
}

function parseJson(text: string, where: string): unknown {
  if (text.trim() === "") throw new Error(`${where}が空です。設定の JSON を渡してください`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${where}を JSON として読めません: ${errorMessage(error)}`);
  }
}

/**
 * The module that `import ... from "notion-lint"` in a config file resolves to: this very
 * package (src/index.ts during development, dist/index.js when built). A config therefore
 * works even where notion-lint is installed globally rather than in the project.
 */
function selfEntry(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", `index${path.extname(here)}`);
}

async function importConfigModule(file: string): Promise<unknown> {
  if (!existsSync(file)) throw new Error(`設定ファイルがありません: ${file}`);
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    interopDefault: true,
    alias: { "notion-lint": selfEntry() },
  });
  let exported: unknown;
  try {
    exported = await jiti.import(file, { default: true });
  } catch (error) {
    throw new Error(`設定ファイルを読み込めません (${file}): ${errorMessage(error)}`);
  }
  if (exported === undefined) {
    throw new Error(`設定ファイルに default export がありません: ${file}`);
  }
  try {
    return toData(exported);
  } catch (error) {
    if (error instanceof ConfigDataError) {
      throw new Error(`設定ファイルの値を JSON にできません: ${error.message}`);
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
