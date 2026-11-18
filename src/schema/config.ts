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
    Type.Boolean({ description: "If true, the value must not be empty. Default false" }),
  ),
  optional: Type.Optional(
    Type.Boolean({
      description:
        "If true, the property may be absent from the page (if it is present, the other checks still apply). Default false",
    }),
  ),
};

const textMatch = {
  pattern: Type.Optional(
    Type.String({
      format: "regex",
      description:
        "Regex source that the value (plain text) must match. Not applied to empty values",
    }),
  ),
  flags: Type.Optional(
    Type.String({ pattern: "^[dgimsuvy]*$", description: "Flags for pattern (e.g. iu)" }),
  ),
};

const count = {
  min: Type.Optional(
    Type.Integer({ minimum: 0, description: "Lower bound on the number of items" }),
  ),
  max: Type.Optional(
    Type.Integer({ minimum: 0, description: "Upper bound on the number of items" }),
  ),
};

const options = {
  options: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
      description: "Allowed option names. If omitted, every option in the data source is allowed",
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
    propVariant("title", textMatch, "Title property"),
    propVariant("rich_text", textMatch, "Rich text property"),
    propVariant(
      "number",
      {
        min: Type.Optional(Type.Number({ description: "Lower bound of the value" })),
        max: Type.Optional(Type.Number({ description: "Upper bound of the value" })),
      },
      "Number property",
    ),
    propVariant("select", options, "Select property"),
    propVariant("multi_select", { ...options, ...count }, "Multi-select property"),
    propVariant("status", options, "Status property"),
    propVariant("date", {}, "Date property"),
    propVariant("people", count, "People property"),
    propVariant("files", count, "Files property"),
    propVariant("checkbox", {}, "Checkbox property"),
    propVariant("url", textMatch, "URL property"),
    propVariant("email", textMatch, "Email property"),
    propVariant("phone_number", textMatch, "Phone number property"),
    propVariant("relation", count, "Relation property"),
  ],
  {
    $id: "PropSpec",
    title: "PropSpec",
    description: "Property type. type is the Notion API property type name",
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
            heading: IntegerEnum(HEADING_LEVELS, { description: "Heading level (1 to 3)" }),
            title: StringOrRegex({
              description:
                "Heading text. A string must match exactly; { pattern } is a regex. Matched against the text without the section number (numbering)",
            }),
            optional: Type.Optional(
              Type.Boolean({ description: "If true, this heading may be absent. Default false" }),
            ),
            children: Type.Optional(
              Type.Array(Self, {
                description:
                  "Skeleton under this heading (up to the next heading of the same or a higher level)",
              }),
            ),
          },
          { additionalProperties: false, description: "Heading" },
        ),
        Type.Object(
          {
            block: StringEnum(BLOCK_KINDS, {
              description:
                "Block kind. list accepts either a bulleted or a numbered list. any accepts any kind",
            }),
            min: Type.Optional(
              Type.Integer({
                minimum: 0,
                description:
                  "Lower bound on the number of blocks of this kind at this position. Default 1 (0 makes it optional)",
              }),
            ),
            max: Type.Optional(
              Type.Integer({
                minimum: 1,
                description: "Upper bound, same as above. Default: no upper bound",
              }),
            ),
            children: Type.Optional(
              Type.Array(Self, {
                description:
                  "Skeleton of the child blocks of this block (e.g. the contents of a toggle)",
              }),
            ),
          },
          { additionalProperties: false, description: "A block other than a heading" },
        ),
      ],
    ),
  {
    $id: "BodyNode",
    title: "BodyNode",
    description:
      "One element of the body skeleton. An element with heading is a heading; one with block is any other block. The array must appear in this order, from top to bottom",
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
      Type.Boolean({
        description: "Do not skip heading levels (e.g. H3 right after H1). Default false",
      }),
    ),
    allowExtra: Type.Optional(
      Type.Boolean({ description: "Allow headings that are not in body. Default true" }),
    ),
  },
  { additionalProperties: false, description: "Rules for the whole heading structure" },
);
export type HeadingsRule = Static<typeof HeadingsRule>;

export const TextRule = Type.Object(
  {
    textlint: Type.Optional(
      Type.Object(
        {
          presets: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              description: "textlint preset names (e.g. ja-technical-writing)",
            }),
          ),
          rules: Type.Optional(
            Type.Record(
              Type.String(),
              Type.Unsafe<boolean | Record<string, unknown>>({ type: ["boolean", "object"] }),
              { description: "textlint rule names and their settings (true / false / options)" },
            ),
          ),
          prh: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
              description: "Paths to prh dictionary files (relative to the config file)",
            }),
          ),
        },
        { additionalProperties: false, description: "Check the body with textlint" },
      ),
    ),
  },
  { additionalProperties: false, description: "Check of the notation in the body" },
);
export type TextRule = Static<typeof TextRule>;

const numberingFormat = (level: string) =>
  Type.Optional(
    Type.String({
      pattern: "\\{title\\}",
      description: `Format for ${level} headings. {n} is each part of the number, {title} is the title (e.g. "{n}.{n} {title}")`,
    }),
  );

export const NumberingRule = Type.Object(
  {
    format: Type.Object(
      { h1: numberingFormat("H1"), h2: numberingFormat("H2"), h3: numberingFormat("H3") },
      { additionalProperties: false, minProperties: 1 },
    ),
    sequential: Type.Optional(
      Type.Boolean({
        description: "Numbers run 1, 2, 3 without gaps or duplicates. Default true",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Rules for the section numbers written by hand in headings",
  },
);
export type NumberingRule = Static<typeof NumberingRule>;

export const ReferencesRule = Type.Object(
  {
    patterns: Type.Array(
      StringOrRegex({
        description:
          'Reference forms in the body. A string is a template containing {n} (section number) and {title} (heading), e.g. "see section {n}" or {n} "{title}"; it matches case-insensitively, and whitespace matches any whitespace. A {title} between punctuation such as quotes takes any text up to the closing character; elsewhere it only matches existing heading titles. {page} names the page the section is on: a page mention, or the title of a page checked in the same run (case-insensitive; quotes or brackets around it are ignored); the number and title are then matched against the headings of that page, and a page that is not checked, or a title several checked pages share, is not checked. Patterns with {page} are tried before the others. { pattern } is a regex with named groups n, title and page',
      }),
      { minItems: 1 },
    ),
    notionLinks: Type.Optional(
      Type.Boolean({
        description:
          "Also check Notion links: a link to a heading on the same page must read as that heading's current number and title, and a link or mention of another page (or a block on it) must point to something that exists and can be read; when that page is also checked in the same run, a link to a heading on it must read as that heading's current number and title too. Default false",
      }),
    ),
    ignore: Type.Optional(
      Type.Array(
        StringOrRegex({
          description:
            'Text that is never a reference: a reference that overlaps an occurrence of the string (case-sensitive), or a match of the regex, is skipped (e.g. "RFC 9110, see chapter" or { "pattern": "chapter [0-9]+ of RFC [0-9]+" })',
        }),
      ),
    ),
  },
  {
    additionalProperties: false,
    description: "Match section references in the body against the headings",
  },
);
export type ReferencesRule = Static<typeof ReferencesRule>;

export const TemplateSource = Type.Object(
  {
    page: Type.String({ minLength: 1, description: "ID or URL of the template page" }),
  },
  {
    additionalProperties: false,
    description:
      "Build body from the headings of a template page (headings only, all required, nested as in the template). A body written in the same type replaces it (no merge). Other settings such as properties apply as written",
  },
);
export type TemplateSource = Static<typeof TemplateSource>;

export const DocType = Type.Object(
  {
    name: Type.Optional(
      Type.String({ minLength: 1, description: "Name of the type (shown in results)" }),
    ),
    fromTemplate: Type.Optional(TemplateSource),
    properties: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), RefTo(PropSpec), {
        description: "Type for each property name",
      }),
    ),
    body: Type.Optional(Type.Array(RefTo(BodyNode), { description: "Body skeleton" })),
    headings: Type.Optional(HeadingsRule),
    text: Type.Optional(TextRule),
    numbering: Type.Optional(NumberingRule),
    references: Type.Optional(ReferencesRule),
  },
  {
    $id: "DocType",
    title: "DocType",
    additionalProperties: false,
    description: "Document type. Checks whether a page matches it",
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
        dataSource: Type.String({
          minLength: 1,
          description:
            "Data source ID or URL. A database ID or URL also works when the database has one data source; with several, the error lists their IDs",
        }),
        where: Type.Optional(
          Type.Record(Type.String({ minLength: 1 }), WhereValue, {
            description:
              "Property names and values. Only pages where all of them match are checked. A formula is compared as its result (number, true / false, text, or date), a rollup as a number, a date, or an array in which some item must equal the value, and files by true (has files), false (no files), or a file name",
          }),
        ),
        type: RefTo(DocType),
      },
      { additionalProperties: false, description: "Apply a type to the pages of a data source" },
    ),
    Type.Object(
      {
        page: Type.String({ minLength: 1, description: "Page ID or URL" }),
        type: RefTo(DocType),
      },
      { additionalProperties: false, description: "Apply a type to one page" },
    ),
  ],
  {
    description: "Which type applies to which pages. Has either dataSource or page",
  },
);
export type Target = Static<typeof Target>;

export const ConfigSchema = Type.Object(
  {
    $schema: Type.Optional(
      Type.String({ description: "Location of the schema for editors (ignored)" }),
    ),
    type: Type.Optional(
      RefTo(DocType, {
        description: "Type applied to the page given with --page",
      }),
    ),
    targets: Type.Optional(Type.Array(Target, { minItems: 1 })),
  },
  {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "notion-lint config",
    description:
      "notion-lint config. Has type (the type for the page checked with --page), targets, or both",
    additionalProperties: false,
    anyOf: [{ required: ["type"] }, { required: ["targets"] }],
    definitions: { DocType, BodyNode, PropSpec },
  },
);
export type Config = Static<typeof ConfigSchema>;
