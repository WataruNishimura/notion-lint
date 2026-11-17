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
  string: "a string",
  object: "an object",
  array: "an array",
  number: "a number",
  integer: "an integer",
  boolean: "a boolean",
  null: "null",
};

function describeTypes(types: unknown): string {
  const list = Array.isArray(types) ? types : String(types).split(",");
  return list.map((t) => TYPE_NAMES[String(t)] ?? String(t)).join(" or ");
}

function messageFor(error: ErrorObject): string {
  const p = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required":
      return `required property "${p.missingProperty}" is missing`;
    case "additionalProperties":
      return `unknown property "${p.additionalProperty}"`;
    case "type":
      return `must be ${describeTypes(p.type)}`;
    case "enum":
      return `must be one of: ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    case "const":
      return `must be ${JSON.stringify(p.allowedValue)}`;
    case "minimum":
      return `must be ${p.limit} or more`;
    case "maximum":
      return `must be ${p.limit} or less`;
    case "minItems":
      return `needs at least ${p.limit} item(s)`;
    case "minLength":
      return p.limit === 1 ? "must not be empty" : `needs at least ${p.limit} character(s)`;
    case "minProperties":
      return `needs at least ${p.limit} property(ies)`;
    case "uniqueItems":
      return `has duplicates (item ${p.j} and item ${p.i})`;
    case "pattern":
      return `must match the regular expression ${p.pattern}`;
    case "format":
      return p.format === "regex"
        ? "is not a valid regular expression"
        : `must be in ${p.format} format`;
    case "dependencies":
      return `"${p.property}" requires "${p.missingProperty}" as well`;
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
      message: `one of these is required: ${names.map((n) => `"${n}"`).join(", ")}`,
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
