import { regexToData, toData } from "../config/to-data.js";
import type {
  BlockKind,
  BlockNode,
  BodyNode,
  Config,
  DocType,
  HeadingLevel,
  HeadingNode,
  HeadingsRule,
  NumberingRule,
  PropSpec,
  ReferencesRule,
  TemplateSource,
  TextRule,
} from "../schema/config.js";
import type { Regex } from "../schema/helpers.js";

/**
 * Builders for `notion-lint.config.ts`. They only produce plain JSON data (the shapes in
 * `schema/config.ts`); `toJSON()` returns exactly what the same config written by hand in
 * JSON would contain. A `RegExp` is stored as `{ pattern, flags }`.
 */

/** Anything that turns into `T` when serialized: a builder, or `T` written directly. */
export interface Buildable<T> {
  toJSON(): T;
}
export type Input<T> = T | Buildable<T>;

function build<T>(value: Input<T>): T {
  return toData(value) as T;
}

function matcher(value: string | RegExp | Regex): string | Regex {
  return value instanceof RegExp ? regexToData(value) : value;
}

// ---------------------------------------------------------------------------
// prop

type SpecOf<K extends PropSpec["type"]> = Extract<PropSpec, { type: K }>;

abstract class PropBuilder<S extends PropSpec> implements Buildable<S> {
  constructor(protected readonly spec: S) {}

  protected with(patch: Partial<S>): this {
    const Ctor = this.constructor as new (spec: S) => this;
    return new Ctor({ ...this.spec, ...patch });
  }

  /** The value must not be empty. */
  required(): this {
    return this.with({ required: true } as Partial<S>);
  }

  /** The page may lack this property entirely. */
  optional(): this {
    return this.with({ optional: true } as Partial<S>);
  }

  toJSON(): S {
    return { ...this.spec };
  }
}

class PlainProp<K extends "date" | "checkbox"> extends PropBuilder<SpecOf<K>> {}

class TextProp<
  K extends "title" | "rich_text" | "url" | "email" | "phone_number",
> extends PropBuilder<SpecOf<K>> {
  /** The plain text value must match. A `RegExp` keeps its flags. */
  pattern(pattern: RegExp | string, flags?: string): this {
    const data = matcher(pattern);
    const regex = typeof data === "string" ? { pattern: data, flags } : data;
    const patch: Partial<SpecOf<K>> = { pattern: regex.pattern } as Partial<SpecOf<K>>;
    if (regex.flags !== undefined && regex.flags !== "") {
      (patch as { flags?: string }).flags = regex.flags;
    }
    return this.with(patch);
  }
}

class CountProp<K extends "people" | "files" | "relation" | "multi_select"> extends PropBuilder<
  SpecOf<K>
> {
  /** At least `n` items. */
  min(n: number): this {
    return this.with({ min: n } as Partial<SpecOf<K>>);
  }

  /** At most `n` items. */
  max(n: number): this {
    return this.with({ max: n } as Partial<SpecOf<K>>);
  }
}

class NumberProp extends PropBuilder<SpecOf<"number">> {
  min(n: number): this {
    return this.with({ min: n });
  }

  max(n: number): this {
    return this.with({ max: n });
  }
}

class OptionsProp<K extends "select" | "status"> extends PropBuilder<SpecOf<K>> {}

function withOptions<K extends "select" | "status" | "multi_select">(
  type: K,
  options: readonly string[] | undefined,
): SpecOf<K> {
  return (options === undefined ? { type } : { type, options: [...options] }) as SpecOf<K>;
}

export const prop = {
  title: () => new TextProp<"title">({ type: "title" }),
  richText: () => new TextProp<"rich_text">({ type: "rich_text" }),
  url: () => new TextProp<"url">({ type: "url" }),
  email: () => new TextProp<"email">({ type: "email" }),
  phoneNumber: () => new TextProp<"phone_number">({ type: "phone_number" }),
  number: () => new NumberProp({ type: "number" }),
  /** `options`: the allowed option names. Omit to allow any option of the data source. */
  select: (options?: readonly string[]) => new OptionsProp(withOptions("select", options)),
  status: (options?: readonly string[]) => new OptionsProp(withOptions("status", options)),
  multiSelect: (options?: readonly string[]) => new CountProp(withOptions("multi_select", options)),
  date: () => new PlainProp<"date">({ type: "date" }),
  checkbox: () => new PlainProp<"checkbox">({ type: "checkbox" }),
  people: () => new CountProp<"people">({ type: "people" }),
  files: () => new CountProp<"files">({ type: "files" }),
  relation: () => new CountProp<"relation">({ type: "relation" }),
};

// ---------------------------------------------------------------------------
// h / block

export type NodeInput = Input<BodyNode>;

function nodes(input: NodeInput | readonly NodeInput[]): BodyNode[] {
  const list = (Array.isArray(input) ? input : [input]) as readonly NodeInput[];
  return list.map((node) => build(node));
}

export interface HeadingOptions {
  /** The skeleton under this heading. A single node or a list. */
  children?: NodeInput | readonly NodeInput[];
  optional?: boolean;
}

export class HeadingBuilder implements Buildable<HeadingNode> {
  constructor(private readonly node: HeadingNode) {}

  /** The heading may be missing. */
  optional(): HeadingBuilder {
    return new HeadingBuilder({ ...this.node, optional: true });
  }

  /** Replace the skeleton under this heading. */
  children(...children: NodeInput[]): HeadingBuilder {
    return new HeadingBuilder({ ...this.node, children: nodes(children) });
  }

  toJSON(): HeadingNode {
    return { ...this.node };
  }
}

function heading(level: HeadingLevel) {
  return (title: string | RegExp, options: HeadingOptions = {}): HeadingBuilder => {
    const node: HeadingNode = { heading: level, title: matcher(title) };
    if (options.optional !== undefined) node.optional = options.optional;
    if (options.children !== undefined) node.children = nodes(options.children);
    return new HeadingBuilder(node);
  };
}

/** Headings. `h.h2("Purpose")`, `h.h2(/^Decisions/, { children: block.list() })` */
export const h = { h1: heading(1), h2: heading(2), h3: heading(3) };

export class BlockBuilder implements Buildable<BlockNode> {
  constructor(private readonly node: BlockNode) {}

  /** At least `n` consecutive blocks of this kind (default 1). */
  min(n: number): BlockBuilder {
    return new BlockBuilder({ ...this.node, min: n });
  }

  /** At most `n` consecutive blocks of this kind. */
  max(n: number): BlockBuilder {
    return new BlockBuilder({ ...this.node, max: n });
  }

  /** The block may be missing (same as `min(0)`). */
  optional(): BlockBuilder {
    return this.min(0);
  }

  /** The skeleton of this block's children (the inside of a toggle, nested list items, ...). */
  children(...children: NodeInput[]): BlockBuilder {
    return new BlockBuilder({ ...this.node, children: nodes(children) });
  }

  toJSON(): BlockNode {
    return { ...this.node };
  }
}

function blockOf(kind: BlockKind) {
  return () => new BlockBuilder({ block: kind });
}

/** Blocks other than headings. `block.list().min(1)`, `block.todo()` */
export const block = {
  any: blockOf("any"),
  paragraph: blockOf("paragraph"),
  /** Bulleted or numbered list items. */
  list: blockOf("list"),
  bulleted: blockOf("bulleted_list_item"),
  numbered: blockOf("numbered_list_item"),
  todo: blockOf("to_do"),
  toggle: blockOf("toggle"),
  quote: blockOf("quote"),
  callout: blockOf("callout"),
  code: blockOf("code"),
  table: blockOf("table"),
  image: blockOf("image"),
  divider: blockOf("divider"),
};

// ---------------------------------------------------------------------------
// text / numbering / references

export interface TextlintOptions {
  /** Preset name(s), e.g. `"ja-technical-writing"`. */
  preset?: string | readonly string[];
  rules?: Record<string, boolean | Record<string, unknown>>;
  /** prh dictionary path(s), relative to the config file. */
  prh?: string | readonly string[];
}

function list(value: string | readonly string[]): string[] {
  return typeof value === "string" ? [value] : [...value];
}

export const text = {
  textlint(options: TextlintOptions = {}): TextRule {
    const textlint: NonNullable<TextRule["textlint"]> = {};
    if (options.preset !== undefined) textlint.presets = list(options.preset);
    if (options.rules !== undefined) textlint.rules = build(options.rules);
    if (options.prh !== undefined) textlint.prh = list(options.prh);
    return { textlint };
  },
};

/** Chapter numbers written in headings, e.g. `{ format: { h1: "{n}. {title}" } }`. */
export function numbering(rule: NumberingRule): NumberingRule {
  return build(rule);
}

export interface ReferencesOptions {
  /**
   * Templates with `{n}` / `{title}` / `{page}` (`"see section {n}"`, `"{page}の{n}章"`), or
   * regexps with named groups `n` / `title` / `page`.
   */
  patterns: readonly (string | RegExp)[];
  notionLinks?: boolean;
  ignore?: readonly (string | RegExp)[];
}

/** References to chapters in the text, checked against the headings. */
export function references(options: ReferencesOptions): ReferencesRule {
  const rule: ReferencesRule = { patterns: options.patterns.map(matcher) };
  if (options.notionLinks !== undefined) rule.notionLinks = options.notionLinks;
  if (options.ignore !== undefined) rule.ignore = options.ignore.map(matcher);
  return rule;
}

// ---------------------------------------------------------------------------
// doc

export interface DocInput {
  name?: string;
  properties?: Record<string, Input<PropSpec>>;
  body?: readonly NodeInput[];
  headings?: HeadingsRule;
  text?: TextRule;
  numbering?: NumberingRule;
  references?: ReferencesRule;
  fromTemplate?: TemplateSource;
}

export class DocBuilder implements Buildable<DocType> {
  constructor(private readonly data: DocType) {}

  /**
   * A new type based on this one. `properties` and `headings` are merged key by key;
   * every other field given here replaces the original.
   */
  extend(input: DocInput): DocBuilder {
    const patch = build<DocType>(input as Input<DocType>);
    const merged: DocType = { ...this.data, ...patch };
    if (this.data.properties !== undefined && patch.properties !== undefined) {
      merged.properties = { ...this.data.properties, ...patch.properties };
    }
    if (this.data.headings !== undefined && patch.headings !== undefined) {
      merged.headings = { ...this.data.headings, ...patch.headings };
    }
    return new DocBuilder(merged);
  }

  toJSON(): DocType {
    return build(this.data);
  }
}

function docImpl(input: DocInput): DocBuilder {
  return new DocBuilder(build<DocType>(input as Input<DocType>));
}

/** A document type. `doc.fromTemplate(pageId, {...})` takes its body from a template page. */
export const doc = Object.assign(docImpl, {
  fromTemplate(page: string, input: Omit<DocInput, "fromTemplate"> = {}): DocBuilder {
    return docImpl({ fromTemplate: { page }, ...input });
  },
});

// ---------------------------------------------------------------------------
// defineConfig

/** A document type: a `doc()` builder, or the data written directly (builders allowed inside). */
export type DocTypeInput = Input<DocType> | DocInput;

export type TargetInput =
  | { dataSource: string; where?: Record<string, string | number | boolean>; type: DocTypeInput }
  | { page: string; type: DocTypeInput };

export interface ConfigInput {
  $schema?: string;
  /** The type for pages given with `--page`. */
  type?: DocTypeInput;
  targets?: readonly TargetInput[];
}

/** Turn a config written with builders into plain data (what `print-config` prints). */
export function defineConfig(config: ConfigInput): Config {
  return toData(config) as Config;
}
