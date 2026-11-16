import { type Static, Type } from "@sinclair/typebox";
import { KeyedUnion, StringEnum } from "./helpers.js";

/**
 * Output of `notion-lint check --format json` (`notion-lint schema result`).
 * Only the format is defined here; fetching pages and validating them come later.
 */

export const Severity = StringEnum(["error", "warning"] as const, {
  description: "error は型に合わない。warning は textlint の指摘など",
});
export type Severity = Static<typeof Severity>;

export const Suggestion = Type.Object(
  {
    message: Type.String({
      description: "直し方の説明 (例: 「2.1 は『目的』です。『背景』は 2.2 です」)",
    }),
    replacement: Type.Optional(
      Type.String({ description: "置き換える文字列が決まるときはその文字列" }),
    ),
  },
  { additionalProperties: false, description: "直し方の候補" },
);
export type Suggestion = Static<typeof Suggestion>;

export const Violation = Type.Object(
  {
    pageId: Type.String({ description: "ページ ID" }),
    blockId: Type.Unsafe<string | null>({
      type: ["string", "null"],
      description: "ブロック ID。プロパティの違反や、ブロックがないことの違反では null",
    }),
    path: Type.String({
      description: "型のどこに対応するか (例: body[1]、body[1].children[0]、properties.参加者)",
    }),
    rule: Type.String({
      description:
        "違反の種類 (例: property.min、body.missing、body.order、numbering.sequence、textlint/<ルール名>)",
    }),
    severity: Severity,
    message: Type.String(),
    suggestions: Type.Array(Suggestion),
    url: Type.Optional(Type.String({ description: "違反箇所への Notion のリンク" })),
  },
  { additionalProperties: false },
);
export type Violation = Static<typeof Violation>;

export const PageResult = Type.Object(
  {
    pageId: Type.String(),
    url: Type.String(),
    title: Type.Optional(Type.String()),
    typeName: Type.Optional(Type.String({ description: "当てた型の name" })),
    violations: Type.Array(Violation),
  },
  { additionalProperties: false },
);
export type PageResult = Static<typeof PageResult>;

export const CheckResult = Type.Object(
  {
    ok: Type.Boolean({ description: "違反が 1 つもなければ true (終了コード 0)" }),
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
  { additionalProperties: false, description: "検査の結果 (終了コード 0 または 1)" },
);
export type CheckResult = Static<typeof CheckResult>;

export const ConfigIssueSchema = Type.Object(
  {
    path: Type.String({ description: "読みやすい位置 (例: type.body[1].heading)。ルートは空文字" }),
    pointer: Type.String({ description: "JSON Pointer (例: /type/body/1/heading)" }),
    keyword: Type.String({ description: "合わなかった JSON Schema のキーワード" }),
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
            "usage: 引数の誤り、config: 設定の読み込みや Schema の不一致、api: Notion API のエラー、internal: その他",
        }),
        code: Type.Optional(Type.String({ description: "細かい種類 (例: not_implemented)" })),
        message: Type.String(),
        source: Type.Optional(
          Type.String({ description: "設定の出どころ (ファイルのパス、stdin、--config-json)" }),
        ),
        issues: Type.Optional(
          Type.Array(ConfigIssueSchema, { description: "Schema に合わなかった項目" }),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, description: "設定エラーや API エラー (終了コード 2)" },
);
export type ErrorResult = Static<typeof ErrorResult>;

export const ResultSchema = KeyedUnion(["summary", "error"], [CheckResult, ErrorResult], {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "notion-lint result",
  description: "notion-lint check --format json の出力",
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
