import { parseArgs } from "node:util";
import { agentCommand } from "./agent/command.js";
import {
  type ConfigSource,
  findDefaultConfig,
  type LoadResult,
  loadConfig,
} from "./config/load.js";
import { parseNotionId } from "./notion/id.js";
import { type ErrorKind, type ErrorResult, ExitCode } from "./schema/result.js";
import { configJsonSchema, resultJsonSchema } from "./schema/validate.js";
import { VERSION } from "./version.js";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  cwd: string;
}

export const FORMATS = ["text", "json", "github"] as const;
export type Format = (typeof FORMATS)[number];

/** Arguments accepted by `check`. Fetching and validating pages arrive in later PRs. */
export interface CheckOptions {
  source: ConfigSource;
  /** Pages given with `--page`, as hyphenated IDs. Empty means "use targets". */
  pages: string[];
  format: Format;
}

const HELP = `notion-lint ${VERSION}
Checks that Notion pages match the document "types" written in your config.

Usage:
  notion-lint [check] [config] [--page <URL or ID>]... [--format text|json|github]
  notion-lint schema [config|result]
  notion-lint print-config [config]
  notion-lint agent [--target <file>] [--dry-run | --print | --remove] [--create <file>]

Commands:
  check          Check pages (the default command)
  schema         Print the JSON Schema of the config (config) or of the --format json output (result)
  print-config   Load the config and print it as JSON
  agent          Write how to use notion-lint into the repository's agent instruction file
                 (AGENTS.md, AGENT.md, CLAUDE.md, .claude/CLAUDE.md)

Config (choose one; if omitted, notion-lint.config.ts and similar files in the current directory are used):
  --config <path>         Config file (.ts / .mts / .js / .mjs are executed; .json is read as JSON)
  --config -              Read JSON from standard input
  --config-json '<json>'  Read JSON given as an argument
  JSON is never executed as code.

check options:
  --page <URL or ID>      Check only this page, ignoring targets (can be repeated)
  --format <format>       text (default), json, or github

agent options:
  --target <file>         Write to this file only
  --dry-run               Show a diff without writing
  --print                 Print the section to standard output only
  --remove                Remove the section
  --create <file>         Create this file (in the repository root) when no instruction file exists

Exit codes:
  0  No violations
  1  Violations found
  2  Config error, invalid arguments, or Notion API error (with --format json, returned as JSON)
`;

class UsageError extends Error {}

function errorResult(
  kind: ErrorKind,
  message: string,
  extra: Partial<ErrorResult["error"]> = {},
): ErrorResult {
  return { ok: false, error: { kind, message, ...extra } };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Errors are JSON. `check --format json` puts them on stdout (its result channel), others on stderr. */
function writeError(io: Io, result: ErrorResult, channel: "stdout" | "stderr" | "text"): ExitCode {
  if (channel === "stdout") io.stdout(json(result));
  else if (channel === "stderr") io.stderr(json(result));
  else {
    const { error } = result;
    const where = error.source === undefined ? "" : ` (${error.source})`;
    let text = `notion-lint: ${error.message}${where}\n`;
    for (const issue of error.issues ?? []) {
      text += `  ✖ ${issue.path === "" ? "(root)" : issue.path}  ${issue.message}\n`;
    }
    io.stderr(text);
  }
  return ExitCode.Error;
}

function loadError(load: Extract<LoadResult, { ok: false }>): ErrorResult {
  return errorResult("config", load.message, {
    source: load.source,
    ...(load.issues === undefined ? {} : { issues: load.issues }),
  });
}

const CONFIG_OPTIONS = {
  config: { type: "string" },
  "config-json": { type: "string" },
} as const;

function configSource(
  values: { config?: string | undefined; "config-json"?: string | undefined },
  cwd: string,
): ConfigSource {
  if (values.config !== undefined && values["config-json"] !== undefined) {
    throw new UsageError("--config and --config-json cannot be used together");
  }
  if (values["config-json"] !== undefined) return { kind: "inline", json: values["config-json"] };
  if (values.config === "-") return { kind: "stdin" };
  if (values.config !== undefined) return { kind: "file", path: values.config };
  const found = findDefaultConfig(cwd);
  if (found === undefined) {
    throw new UsageError(
      "No config given. Pass one with --config <path>, --config -, or --config-json, or place notion-lint.config.ts in the current directory",
    );
  }
  return { kind: "file", path: found };
}

export async function run(argv: readonly string[], io: Io): Promise<ExitCode> {
  const [first, ...rest] = argv;
  const command = first !== undefined && !first.startsWith("-") ? first : "check";
  const args = command === first ? rest : [...argv];

  if (argv.includes("--version") || argv.includes("-v")) {
    io.stdout(`${VERSION}\n`);
    return ExitCode.Ok;
  }
  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    io.stdout(HELP);
    return ExitCode.Ok;
  }

  switch (command) {
    case "schema":
      return schemaCommand(args, io);
    case "print-config":
      return printConfigCommand(args, io);
    case "agent":
      return agentCommand(args, io);
    case "check":
      return checkCommand(args, io);
    default:
      return writeError(
        io,
        errorResult("usage", `Unknown command: ${command} (see notion-lint --help)`),
        "stderr",
      );
  }
}

function schemaCommand(args: string[], io: Io): ExitCode {
  let which: string;
  try {
    const { positionals } = parseArgs({ args, options: {}, allowPositionals: true, strict: true });
    if (positionals.length > 1) throw new UsageError("schema accepts only config or result");
    which = positionals[0] ?? "config";
  } catch (error) {
    return writeError(io, errorResult("usage", (error as Error).message), "stderr");
  }
  if (which === "config") io.stdout(json(configJsonSchema()));
  else if (which === "result") io.stdout(json(resultJsonSchema()));
  else {
    return writeError(
      io,
      errorResult("usage", `The schema kind must be config or result: ${which}`),
      "stderr",
    );
  }
  return ExitCode.Ok;
}

async function printConfigCommand(args: string[], io: Io): Promise<ExitCode> {
  let source: ConfigSource;
  try {
    const { values } = parseArgs({ args, options: CONFIG_OPTIONS, strict: true });
    source = configSource(values, io.cwd);
  } catch (error) {
    return writeError(io, errorResult("usage", (error as Error).message), "stderr");
  }
  const load = await loadConfig(source, { cwd: io.cwd, readStdin: io.readStdin });
  if (!load.ok) return writeError(io, loadError(load), "stderr");
  io.stdout(json(load.config));
  return ExitCode.Ok;
}

export function parseCheckArgs(args: string[], cwd: string): CheckOptions {
  const { values } = parseArgs({
    args,
    options: {
      ...CONFIG_OPTIONS,
      page: { type: "string", multiple: true },
      format: { type: "string", default: "text" },
    },
    strict: true,
  });
  const format = values.format as string;
  if (!(FORMATS as readonly string[]).includes(format)) {
    throw new UsageError(`--format must be one of ${FORMATS.join(" / ")}: ${format}`);
  }
  const pages = (values.page ?? []).map((page) => {
    const id = parseNotionId(page);
    if (id === undefined) throw new UsageError(`--page needs a page URL or ID: ${page}`);
    return id;
  });
  return { source: configSource(values, cwd), pages, format: format as Format };
}

/** Decide where errors go before the arguments are fully parsed. */
function wantsJson(args: string[]): boolean {
  const i = args.findIndex((a) => a === "--format" || a.startsWith("--format="));
  if (i === -1) return false;
  const arg = args[i] as string;
  return (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1]) === "json";
}

async function checkCommand(args: string[], io: Io): Promise<ExitCode> {
  let options: CheckOptions;
  const early = wantsJson(args) ? "stdout" : "text";
  try {
    options = parseCheckArgs(args, io.cwd);
  } catch (error) {
    return writeError(io, errorResult("usage", (error as Error).message), early);
  }
  const channel = options.format === "json" ? "stdout" : "text";

  const load = await loadConfig(options.source, { cwd: io.cwd, readStdin: io.readStdin });
  if (!load.ok) return writeError(io, loadError(load), channel);

  if (options.pages.length > 0 && load.config.type === undefined) {
    return writeError(
      io,
      errorResult(
        "usage",
        "Checking with --page requires a type (the type to apply to the page) in the config",
        {
          source: load.source,
        },
      ),
      channel,
    );
  }

  // Fetching pages (Notion API) and matching them against the type come in the next PRs.
  return writeError(
    io,
    errorResult(
      "internal",
      "check is not implemented yet (config loading and validation are done)",
      {
        code: "not_implemented",
        source: load.source,
      },
    ),
    channel,
  );
}
