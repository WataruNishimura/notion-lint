import { type Static, type TProperties, Type } from "@sinclair/typebox";
import {
  IntegerEnum,
  KeyedUnion,
  RefTo,
  StringEnum,
  StringOrRegex,
  TaggedUnion,
} from "./helpers.js";

/**
 * The configuration format. This module is the single source of the JSON Schema
 * (`notion-lint schema`); the TypeScript types below are derived from it with `Static`,
 * so the two cannot drift apart.
 */

// ---------------------------------------------------------------------------
// properties

const presence = {
  required: Type.Optional(
    Type.Boolean({ description: "true なら値が空であってはならない。既定は false" }),
  ),
  optional: Type.Optional(
    Type.Boolean({
      description:
        "true ならページにこのプロパティ自体がなくてもよい (あれば他の条件を見る)。既定は false",
    }),
  ),
};

const textMatch = {
  pattern: Type.Optional(
    Type.String({
      format: "regex",
      description: "値 (プレーンテキスト) が合うべき正規表現のソース。空の値には適用しない",
    }),
  ),
  flags: Type.Optional(
    Type.String({ pattern: "^[dgimsuvy]*$", description: "pattern のフラグ (例: iu)" }),
  ),
};

const count = {
  min: Type.Optional(Type.Integer({ minimum: 0, description: "要素数の下限" })),
  max: Type.Optional(Type.Integer({ minimum: 0, description: "要素数の上限" })),
};

const options = {
  options: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
      description: "許す選択肢の名前。省略するとデータソースにある選択肢をすべて許す",
    }),
  ),
};

function propVariant<const K extends string, P extends TProperties>(
  type: K,
  extra: P,
  description: string,
) {
  const hasPattern = "pattern" in extra;
  return Type.Object(
    { type: Type.Literal(type), ...presence, ...extra },
    {
      additionalProperties: false,
      description,
      ...(hasPattern ? { dependencies: { flags: ["pattern"] } } : {}),
    },
  );
}

export const PropSpec = TaggedUnion(
  "type",
  [
    propVariant("title", textMatch, "タイトルプロパティ"),
    propVariant("rich_text", textMatch, "テキストプロパティ"),
    propVariant(
      "number",
      {
        min: Type.Optional(Type.Number({ description: "値の下限" })),
        max: Type.Optional(Type.Number({ description: "値の上限" })),
      },
      "数値プロパティ",
    ),
    propVariant("select", options, "セレクトプロパティ"),
    propVariant("multi_select", { ...options, ...count }, "マルチセレクトプロパティ"),
    propVariant("status", options, "ステータスプロパティ"),
    propVariant("date", {}, "日付プロパティ"),
    propVariant("people", count, "ユーザープロパティ"),
    propVariant("files", count, "ファイルプロパティ"),
    propVariant("checkbox", {}, "チェックボックスプロパティ"),
    propVariant("url", textMatch, "URL プロパティ"),
    propVariant("email", textMatch, "メールプロパティ"),
    propVariant("phone_number", textMatch, "電話番号プロパティ"),
    propVariant("relation", count, "リレーションプロパティ"),
  ],
  {
    $id: "PropSpec",
    title: "PropSpec",
    description: "プロパティの型。type は Notion API のプロパティ型名",
  },
);
export type PropSpec = Static<typeof PropSpec>;
export type PropertyType = PropSpec["type"];

// ---------------------------------------------------------------------------
// body

export const BLOCK_KINDS = [
  "any",
  "paragraph",
  "list",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
  "table",
  "image",
  "divider",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const HEADING_LEVELS = [1, 2, 3] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

export const BodyNode = Type.Recursive(
  (Self) =>
    KeyedUnion(
      ["heading", "block"],
      [
        Type.Object(
          {
            heading: IntegerEnum(HEADING_LEVELS, { description: "見出しのレベル (1〜3)" }),
            title: StringOrRegex({
              description:
                "見出しの文字列。文字列なら完全一致、{ pattern } なら正規表現。章番号 (numbering) を除いた部分と照合する",
            }),
            optional: Type.Optional(
              Type.Boolean({ description: "true ならこの見出しがなくてもよい。既定は false" }),
            ),
            children: Type.Optional(
              Type.Array(Self, { description: "見出しの下 (次の同レベル以上の見出しまで) の骨格" }),
            ),
          },
          { additionalProperties: false, description: "見出し" },
        ),
        Type.Object(
          {
            block: StringEnum(BLOCK_KINDS, {
              description:
                "ブロックの種類。list は箇条書きと番号付きリストのどちらでもよい。any は種類を問わない",
            }),
            min: Type.Optional(
              Type.Integer({
                minimum: 0,
                description:
                  "この位置に続く、この種類のブロックの数の下限。既定は 1 (0 なら省略可)",
              }),
            ),
            max: Type.Optional(
              Type.Integer({ minimum: 1, description: "同じく上限。既定は上限なし" }),
            ),
            children: Type.Optional(
              Type.Array(Self, {
                description: "このブロックの子ブロック (トグルの中身など) の骨格",
              }),
            ),
          },
          { additionalProperties: false, description: "見出し以外のブロック" },
        ),
      ],
    ),
  {
    $id: "BodyNode",
    title: "BodyNode",
    description:
      "本文の骨格の 1 要素。heading を持てば見出し、block を持てばそれ以外のブロック。配列の上から順に並ぶことを要求する",
  },
);
export type BodyNode = Static<typeof BodyNode>;
export type HeadingNode = Extract<BodyNode, { heading: HeadingLevel }>;
export type BlockNode = Extract<BodyNode, { block: BlockKind }>;

// ---------------------------------------------------------------------------
// other parts of a document type

export const HeadingsRule = Type.Object(
  {
    noSkipLevel: Type.Optional(
      Type.Boolean({ description: "見出しのレベルを飛ばさない (H1 の次に H3 など)。既定は false" }),
    ),
    allowExtra: Type.Optional(
      Type.Boolean({ description: "body にない見出しを許す。既定は true" }),
    ),
  },
  { additionalProperties: false, description: "見出し全体の規則" },
);
export type HeadingsRule = Static<typeof HeadingsRule>;

export const TextRule = Type.Object(
  {
    textlint: Type.Optional(
      Type.Object(
        {
          presets: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              description: "textlint のプリセット名 (例: ja-technical-writing)",
            }),
          ),
          rules: Type.Optional(
            Type.Record(
              Type.String(),
              Type.Unsafe<boolean | Record<string, unknown>>({ type: ["boolean", "object"] }),
              { description: "textlint のルール名と設定 (true / false / オプション)" },
            ),
          ),
          prh: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              description: "prh の辞書ファイルのパス (設定ファイルからの相対パス)",
            }),
          ),
        },
        { additionalProperties: false, description: "textlint で本文を検査する" },
      ),
    ),
  },
  { additionalProperties: false, description: "本文の表記の検査" },
);
export type TextRule = Static<typeof TextRule>;

const numberingFormat = (level: string) =>
  Type.Optional(
    Type.String({
      pattern: "\\{title\\}",
      description: `${level} の書き方。{n} が番号の各段、{title} がタイトル (例: "{n}.{n} {title}")`,
    }),
  );

export const NumberingRule = Type.Object(
  {
    format: Type.Object(
      { h1: numberingFormat("H1"), h2: numberingFormat("H2"), h3: numberingFormat("H3") },
      { additionalProperties: false, minProperties: 1 },
    ),
    sequential: Type.Optional(
      Type.Boolean({ description: "番号が 1, 2, 3 と抜けや重複なく続く。既定は true" }),
    ),
  },
  { additionalProperties: false, description: "見出しに手で書かれた章番号の規則" },
);
export type NumberingRule = Static<typeof NumberingRule>;

export const ReferencesRule = Type.Object(
  {
    patterns: Type.Array(
      StringOrRegex({
        description:
          '本文中の参照の書き方。文字列は {n} (章番号) と {title} (見出し) を含むひな形 (例: "{n}章")。{ pattern } なら名前付きグループ n / title を持つ正規表現',
      }),
      { minItems: 1 },
    ),
    notionLinks: Type.Optional(
      Type.Boolean({
        description: "ブロックへのリンクの文字列とリンク先の見出しも照合する。既定は false",
      }),
    ),
    ignore: Type.Optional(
      Type.Array(
        StringOrRegex({ description: "参照として扱わない語 (文字列は完全一致、または正規表現)" }),
      ),
    ),
  },
  { additionalProperties: false, description: "本文中の章への参照と見出しの照合" },
);
export type ReferencesRule = Static<typeof ReferencesRule>;

export const TemplateSource = Type.Object(
  {
    page: Type.String({ minLength: 1, description: "テンプレートページの ID か URL" }),
  },
  {
    additionalProperties: false,
    description:
      "テンプレートページから body を作る。同じ型に書いた body / properties はテンプレートからの分より優先する",
  },
);
export type TemplateSource = Static<typeof TemplateSource>;

export const DocType = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, description: "型の名前 (結果の表示に使う)" })),
    fromTemplate: Type.Optional(TemplateSource),
    properties: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), RefTo(PropSpec), {
        description: "プロパティ名ごとの型",
      }),
    ),
    body: Type.Optional(Type.Array(RefTo(BodyNode), { description: "本文の骨格" })),
    headings: Type.Optional(HeadingsRule),
    text: Type.Optional(TextRule),
    numbering: Type.Optional(NumberingRule),
    references: Type.Optional(ReferencesRule),
  },
  {
    $id: "DocType",
    title: "DocType",
    additionalProperties: false,
    description: "文書の型。ページがこれに合うかを検査する",
  },
);
export type DocType = Static<typeof DocType>;

// ---------------------------------------------------------------------------
// targets and the root

const WhereValue = Type.Unsafe<string | number | boolean>({
  type: ["string", "number", "boolean"],
});

export const Target = KeyedUnion(
  ["dataSource", "page"],
  [
    Type.Object(
      {
        dataSource: Type.String({ minLength: 1, description: "データソースの ID か URL" }),
        where: Type.Optional(
          Type.Record(Type.String({ minLength: 1 }), WhereValue, {
            description: "プロパティ名と値。すべて等しいページだけを検査する",
          }),
        ),
        type: RefTo(DocType),
      },
      { additionalProperties: false, description: "データソースのページに型を当てる" },
    ),
    Type.Object(
      {
        page: Type.String({ minLength: 1, description: "ページの ID か URL" }),
        type: RefTo(DocType),
      },
      { additionalProperties: false, description: "1 つのページに型を当てる" },
    ),
  ],
  { description: "どのページにどの型を当てるか。dataSource か page のどちらかを持つ" },
);
export type Target = Static<typeof Target>;

export const ConfigSchema = Type.Object(
  {
    $schema: Type.Optional(
      Type.String({ description: "エディタ向けの Schema の場所 (無視される)" }),
    ),
    type: Type.Optional(
      RefTo(DocType, {
        description: "--page で指定したページに当てる型",
      }),
    ),
    targets: Type.Optional(Type.Array(Target, { minItems: 1 })),
  },
  {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "notion-lint config",
    description:
      "notion-lint の設定。type (--page で検査するページの型) か targets のどちらか、または両方を持つ",
    additionalProperties: false,
    anyOf: [{ required: ["type"] }, { required: ["targets"] }],
    definitions: { DocType, BodyNode, PropSpec },
  },
);
export type Config = Static<typeof ConfigSchema>;
