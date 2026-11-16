import { parseArgs } from "node:util";
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
Notion のページが、設定に書いた文書の「型」に合っているかを検証する。

使い方:
  notion-lint [check] [設定] [--page <URL か ID>]... [--format text|json|github]
  notion-lint schema [config|result]
  notion-lint print-config [設定]

コマンド:
  check          ページを検査する (既定のコマンド)
  schema         設定 (config) または --format json の出力 (result) の JSON Schema を出す
  print-config   設定を読み込み、JSON にして出す

設定 (どれか 1 つ。省略するとカレントディレクトリの notion-lint.config.ts などを使う):
  --config <path>         設定ファイル (.ts / .mts / .js / .mjs は実行、.json は JSON として読む)
  --config -              標準入力から JSON を読む
  --config-json '<json>'  引数の JSON を読む
  JSON はコードとして実行しない。

check のオプション:
  --page <URL か ID>      targets を使わず、このページだけを検査する (複数可)
  --format <形式>         text (既定)、json、github

終了コード:
  0  違反なし
  1  違反あり
  2  設定エラー、引数の誤り、Notion API のエラー (--format json なら JSON で返す)
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
      text += `  ✖ ${issue.path === "" ? "(ルート)" : issue.path}  ${issue.message}\n`;
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
    throw new UsageError("--config と --config-json は同時に指定できません");
  }
  if (values["config-json"] !== undefined) return { kind: "inline", json: values["config-json"] };
  if (values.config === "-") return { kind: "stdin" };
  if (values.config !== undefined) return { kind: "file", path: values.config };
  const found = findDefaultConfig(cwd);
  if (found === undefined) {
    throw new UsageError(
      "設定がありません。--config <path>、--config -、--config-json のどれかで渡すか、notion-lint.config.ts を置いてください",
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
    case "check":
      return checkCommand(args, io);
    default:
      return writeError(
        io,
        errorResult("usage", `不明なコマンドです: ${command} (notion-lint --help を参照)`),
        "stderr",
      );
  }
}

function schemaCommand(args: string[], io: Io): ExitCode {
  let which: string;
  try {
    const { positionals } = parseArgs({ args, options: {}, allowPositionals: true, strict: true });
    if (positionals.length > 1)
      throw new UsageError("schema に渡せるのは config か result だけです");
    which = positionals[0] ?? "config";
  } catch (error) {
    return writeError(io, errorResult("usage", (error as Error).message), "stderr");
  }
  if (which === "config") io.stdout(json(configJsonSchema()));
  else if (which === "result") io.stdout(json(resultJsonSchema()));
  else {
    return writeError(
      io,
      errorResult("usage", `schema の種類は config か result です: ${which}`),
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
    throw new UsageError(`--format は ${FORMATS.join(" / ")} のどれかです: ${format}`);
  }
  const pages = (values.page ?? []).map((page) => {
    const id = parseNotionId(page);
    if (id === undefined)
      throw new UsageError(`--page にページの URL か ID を指定してください: ${page}`);
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
      errorResult("usage", "--page で検査するには設定に type (ページに当てる型) が必要です", {
        source: load.source,
      }),
      channel,
    );
  }

  // Fetching pages (Notion API) and matching them against the type come in the next PRs.
  return writeError(
    io,
    errorResult("internal", "check はまだ実装されていません (設定の読み込みと検証までは完了)", {
      code: "not_implemented",
      source: load.source,
    }),
    channel,
  );
}
