import type { Static } from "@sinclair/typebox";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import formatsModule from "ajv-formats";
import { encodePointerToken, pointerToPath } from "../path.js";
import { type Config, ConfigSchema } from "./config.js";
import { type ConfigIssueSchema, ResultSchema } from "./result.js";

/**
 * One place where a configuration does not match the JSON Schema:
 * `path` (`type.body[1].heading`), `pointer` (`/type/body/1/heading`), the failed `keyword`, and a message.
 */
export type ConfigIssue = Static<typeof ConfigIssueSchema>;

export type ValidationResult = { ok: true; config: Config } | { ok: false; issues: ConfigIssue[] };

// ajv-formats is CommonJS; its default export arrives as `module.exports`.
const addFormats = ((formatsModule as unknown as { default?: unknown }).default ??
  formatsModule) as unknown as typeof formatsModule.default;

/** JSON form of the config schema, exactly as `notion-lint schema` prints it. */
export function configJsonSchema(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(ConfigSchema)) as Record<string, unknown>;
}

let validator: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (validator === undefined) {
    const ajv = new Ajv({ allErrors: true, strictTypes: false });
    addFormats(ajv, ["regex"]);
    validator = ajv.compile(configJsonSchema());
  }
  return validator;
}

/** Validate untrusted data (parsed JSON or a TS config's default export) against the schema. */
export function validateConfig(data: unknown): ValidationResult {
  const validate = getValidator();
  if (validate(data)) return { ok: true, config: data as Config };
  return { ok: false, issues: toIssues(validate.errors ?? []) };
}

// ---------------------------------------------------------------------------
// error formatting

const TYPE_NAMES: Record<string, string> = {
  string: "文字列",
  object: "オブジェクト",
  array: "配列",
  number: "数値",
  integer: "整数",
  boolean: "真偽値",
  null: "null",
};

function describeTypes(types: unknown): string {
  const list = Array.isArray(types) ? types : String(types).split(",");
  return list.map((t) => TYPE_NAMES[String(t)] ?? String(t)).join("か");
}

function messageFor(error: ErrorObject): string {
  const p = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required":
      return `必須の項目 "${p.missingProperty}" がありません`;
    case "additionalProperties":
      return `不明な項目 "${p.additionalProperty}" です`;
    case "type":
      return `${describeTypes(p.type)}である必要があります`;
    case "enum":
      return `次のどれかである必要があります: ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    case "const":
      return `${JSON.stringify(p.allowedValue)} である必要があります`;
    case "minimum":
      return `${p.limit} 以上である必要があります`;
    case "maximum":
      return `${p.limit} 以下である必要があります`;
    case "minItems":
      return `${p.limit} 個以上必要です`;
    case "minLength":
      return p.limit === 1 ? "空にできません" : `${p.limit} 文字以上必要です`;
    case "minProperties":
      return `項目が ${p.limit} つ以上必要です`;
    case "uniqueItems":
      return `重複があります (${p.j} 番目と ${p.i} 番目)`;
    case "pattern":
      return `正規表現 ${p.pattern} に合う必要があります`;
    case "format":
      return p.format === "regex"
        ? "正規表現として読めません"
        : `${p.format} の形式である必要があります`;
    case "dependencies":
      return `"${p.property}" を書くときは "${p.missingProperty}" も必要です`;
    default:
      return error.message ?? error.keyword;
  }
}

function issueFor(error: ErrorObject): ConfigIssue {
  const p = error.params as Record<string, unknown>;
  // Point at the field itself, not at its parent object.
  let pointer = error.instancePath;
  if (
    (error.keyword === "required" || error.keyword === "dependencies") &&
    typeof p.missingProperty === "string"
  ) {
    pointer += `/${encodePointerToken(p.missingProperty)}`;
  } else if (error.keyword === "additionalProperties" && typeof p.additionalProperty === "string") {
    pointer += `/${encodePointerToken(p.additionalProperty)}`;
  }
  return {
    path: pointerToPath(pointer),
    pointer,
    keyword: error.keyword,
    message: messageFor(error),
    params: p,
  };
}

/**
 * Turn Ajv errors into issues:
 * - drop `if` errors (the `then` branch already reported the real problem),
 * - fold "anyOf: required a / required b" into one "one of a, b is required" issue,
 * - drop duplicates.
 */
export function toIssues(errors: ErrorObject[]): ConfigIssue[] {
  // anyOf errors whose branches are all "required" at the same place -> one folded issue
  const consumed = new Set<ErrorObject>();
  const folded = new Map<ErrorObject, ConfigIssue>();
  for (const error of errors) {
    if (error.keyword !== "anyOf") continue;
    const prefix = `${error.schemaPath}/`;
    const branches = errors.filter(
      (e) => e.instancePath === error.instancePath && e.schemaPath.startsWith(prefix),
    );
    if (branches.length === 0 || !branches.every((e) => e.keyword === "required")) continue;
    for (const e of branches) consumed.add(e);
    const names = branches.map((e) =>
      String((e.params as { missingProperty: unknown }).missingProperty),
    );
    folded.set(error, {
      path: pointerToPath(error.instancePath),
      pointer: error.instancePath,
      keyword: "anyOf",
      message: `次のどれかが必要です: ${names.map((n) => `"${n}"`).join(", ")}`,
      params: { required: names },
    });
  }

  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    if (consumed.has(error) || error.keyword === "if") continue;
    const issue = folded.get(error) ?? issueFor(error);
    const key = JSON.stringify([issue.pointer, issue.keyword, issue.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return issues;
}

/** JSON form of the `--format json` output schema (`notion-lint schema result`). */
export function resultJsonSchema(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(ResultSchema)) as Record<string, unknown>;
}
