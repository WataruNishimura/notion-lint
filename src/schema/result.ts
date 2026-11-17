import { type Static, Type } from "@sinclair/typebox";
import { KeyedUnion, StringEnum } from "./helpers.js";

/**
 * Output of `notion-lint check --format json` (`notion-lint schema result`).
 * Only the format is defined here; fetching pages and validating them come later.
 */

export const Severity = StringEnum(["error", "warning"] as const, {
  description:
    "error means the page does not match the type. warning is for things like textlint findings",
});
export type Severity = Static<typeof Severity>;

export const Suggestion = Type.Object(
  {
    message: Type.String({
      description:
        "Explanation of the fix (e.g. \"Section 2.1 is 'Purpose'. 'Background' is 2.2\")",
    }),
    replacement: Type.Optional(
      Type.String({ description: "The replacement text, when it is known" }),
    ),
  },
  { additionalProperties: false, description: "Candidate fix" },
);
export type Suggestion = Static<typeof Suggestion>;

export const Violation = Type.Object(
  {
    pageId: Type.String({ description: "Page ID" }),
    blockId: Type.Unsafe<string | null>({
      type: ["string", "null"],
      description:
        "Block ID. null for property violations and for violations about a missing block",
    }),
    path: Type.String({
      description:
        "Where in the type it applies (e.g. body[1], body[1].children[0], properties.Attendees)",
    }),
    rule: Type.String({
      description:
        "Kind of violation (e.g. property.min, body.missing, body.order, numbering.sequence, textlint/<rule name>)",
    }),
    severity: Severity,
    message: Type.String(),
    suggestions: Type.Array(Suggestion),
    url: Type.Optional(Type.String({ description: "Notion link to the violation" })),
  },
  { additionalProperties: false },
);
export type Violation = Static<typeof Violation>;

export const PageResult = Type.Object(
  {
    pageId: Type.String(),
    url: Type.String(),
    title: Type.Optional(Type.String()),
    typeName: Type.Optional(Type.String({ description: "name of the type that was applied" })),
    violations: Type.Array(Violation),
  },
  { additionalProperties: false },
);
export type PageResult = Static<typeof PageResult>;

export const CheckResult = Type.Object(
  {
    ok: Type.Boolean({ description: "true if there are no violations (exit code 0)" }),
    summary: Type.Object(
      {
        pages: Type.Integer({ minimum: 0 }),
        violations: Type.Integer({ minimum: 0 }),
        errors: Type.Integer({ minimum: 0 }),
        warnings: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    pages: Type.Array(PageResult),
  },
  { additionalProperties: false, description: "Check result (exit code 0 or 1)" },
);
export type CheckResult = Static<typeof CheckResult>;

export const ConfigIssueSchema = Type.Object(
  {
    path: Type.String({
      description: "Readable location (e.g. type.body[1].heading). Empty string for the root",
    }),
    pointer: Type.String({ description: "JSON Pointer (e.g. /type/body/1/heading)" }),
    keyword: Type.String({ description: "JSON Schema keyword that did not match" }),
    message: Type.String(),
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const ERROR_KINDS = ["usage", "config", "api", "internal"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const ErrorResult = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.Object(
      {
        kind: StringEnum(ERROR_KINDS, {
          description:
            "usage: invalid arguments, config: config loading or schema mismatch, api: Notion API error, internal: other",
        }),
        code: Type.Optional(Type.String({ description: "Finer kind (e.g. not_implemented)" })),
        message: Type.String(),
        source: Type.Optional(
          Type.String({
            description: "Where the config came from (file path, stdin, --config-json)",
          }),
        ),
        issues: Type.Optional(
          Type.Array(ConfigIssueSchema, { description: "Fields that did not match the schema" }),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, description: "Config or API error (exit code 2)" },
);
export type ErrorResult = Static<typeof ErrorResult>;

export const ResultSchema = KeyedUnion(["summary", "error"], [CheckResult, ErrorResult], {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "notion-lint result",
  description: "Output of notion-lint check --format json",
});
export type Result = Static<typeof ResultSchema>;

/** Exit codes, as in docs/design.md. */
export const ExitCode = {
  /** No violations. */
  Ok: 0,
  /** At least one violation. */
  Violations: 1,
  /** Configuration, usage, or Notion API error. */
  Error: 2,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export function exitCodeFor(result: Result): ExitCode {
  if ("error" in result) return ExitCode.Error;
  return result.summary.violations > 0 ? ExitCode.Violations : ExitCode.Ok;
}
