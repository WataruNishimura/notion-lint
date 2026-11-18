import type {
  BlockItem,
  BodyItem,
  HeadingItem,
  NotionLink,
  PageModel,
} from "../normalize/model.js";
import { joinPath } from "../path.js";
import type { NumberingRule, ReferencesRule } from "../schema/config.js";
import type { Regex } from "../schema/helpers.js";
import type { Suggestion } from "../schema/result.js";
import type { Finding } from "./finding.js";
import { allHeadings, type HeadingFormat, headingFormats } from "./numbering.js";

/**
 * References to sections in the body (`references`), matched against the page's headings.
 *
 * - `patterns` find references in the text of paragraphs, list items, to-dos, toggles,
 *   quotes, callouts, and table cells. Code blocks and headings are not searched.
 *   - `references.number`: "see section 4" and there is no section 4.
 *   - `references.mismatch`: "2.1 \"Background\"" and section 2.1 is "Purpose".
 *   - `references.title`: "see \"Background\"" and no heading is titled "Background".
 * - `notionLinks`: a link to a heading on the same page must still read as that heading
 *   (`references.link`). Links to other pages are checked for existence by `check`
 *   (`outsideLinks`), since that needs the Notion API.
 * - `ignore`: text that is never a reference. A match that overlaps an ignored word or an
 *   ignored regex match is skipped.
 */

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Blocks whose text is searched for references. */
const TEXT_BLOCKS = new Set([
  "paragraph",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "table_row",
]);

/** A heading with its section number (if it has one) and its title. */
export interface IndexedHeading {
  item: HeadingItem;
  /** Number parts joined with dots ("2.1"); undefined for an unnumbered heading. */
  key: string | undefined;
  /** The number as the heading writes it ("2.1", "第2章"). */
  number: string | undefined;
  title: string;
}

/**
 * Without a format for a heading's level, a leading "2.1 " or "2. " is read as its number,
 * so references can be checked on pages that have no `numbering` rule.
 */
const LOOSE_NUMBER = /^\s*(\d+(?:\.\d+)*)\.?\s+(.+)$/u;

function indexHeadings(items: BodyItem[], formats: Map<number, HeadingFormat>): IndexedHeading[] {
  return allHeadings(items).map((item) => {
    const format = formats.get(item.level);
    const parsed = format?.parse(item.text);
    if (format !== undefined && parsed !== undefined && parsed.parts.length > 0) {
      return {
        item,
        key: parsed.parts.join("."),
        number: format.renderNumber(parsed.parts),
        title: parsed.title,
      };
    }
    const loose = LOOSE_NUMBER.exec(item.text);
    if (loose !== null) {
      return { item, key: loose[1], number: loose[1], title: (loose[2] as string).trim() };
    }
    return { item, key: undefined, number: undefined, title: item.text };
  });
}

/** Number parts of a reference ("2.1", "2-1", "第2章" -> "2.1", "2.1", "2"). */
const numberKey = (text: string): string => (text.match(/\d+/g) ?? []).join(".");

/** Regex source for a section number in references: digits joined by the formats' separators. */
function numberSource(formats: Map<number, HeadingFormat>): string {
  const separators = new Set(["."]);
  for (const format of formats.values()) for (const s of format.separators()) separators.add(s);
  const alternatives = [...separators].map(escapeRegex).join("|");
  return `(?<![\\d])\\d+(?:(?:${alternatives})\\d+)*`;
}

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/**
 * A template such as `see section {n}` or `{n} "{title}"` as a regex (case-insensitive;
 * whitespace matches any whitespace). A `{title}` between punctuation (quotes, brackets)
 * takes any text up to the closing character. A `{title}` without such delimiters only
 * matches the titles of the page's headings, since its end cannot be told otherwise.
 */
export function compileTemplate(template: string, titles: string[], number: string): RegExp {
  const tokens = template.split(/(\{n\}|\{title\})/);
  let source = "";
  let seenN = false;
  let seenTitle = false;
  tokens.forEach((token, i) => {
    if (token === "{n}") {
      source += seenN ? `(?:${number})` : `(?<n>${number})`;
      seenN = true;
      return;
    }
    if (token === "{title}") {
      const before = (tokens[i - 1] ?? "").at(-1);
      const after = (tokens[i + 1] ?? "").at(0);
      let body: string;
      if (
        before !== undefined &&
        after !== undefined &&
        !/\s/u.test(before) &&
        !/\s/u.test(after) &&
        !isWordChar(before) &&
        !isWordChar(after)
      ) {
        body = `[^${escapeRegex(after).replace(/-/g, "\\-")}\\n]+`;
      } else {
        const alternatives = [...titles]
          .filter((title) => title !== "")
          .sort((a, b) => b.length - a.length)
          .map(
            (title) =>
              `${isWordChar(title[0]) ? "(?<![\\p{L}\\p{N}_])" : ""}${escapeRegex(title)}${
                /[A-Za-z0-9_]$/.test(title) ? "(?![A-Za-z0-9_])" : ""
              }`,
          );
        body = alternatives.length === 0 ? "(?!)" : alternatives.join("|");
      }
      source += seenTitle ? `(?:${body})` : `(?<title>${body})`;
      seenTitle = true;
      return;
    }
    source += token.split(/\s+/).map(escapeRegex).join("\\s+");
  });
  return new RegExp(source, "dgiu");
}

function compilePattern(pattern: string | Regex, titles: string[], number: string): RegExp {
  if (typeof pattern === "string") return compileTemplate(pattern, titles, number);
  const flags = new Set([...(pattern.flags ?? ""), "d", "g"]);
  return new RegExp(pattern.pattern, [...flags].join(""));
}

/** One reference found in the text. */
interface Reference {
  /** Index into `patterns`. */
  pattern: number;
  block: BlockItem;
  /** The whole match. */
  text: string;
  n: { text: string; key: string; start: number; end: number } | undefined;
  title: { text: string; start: number; end: number } | undefined;
}

/** Ranges of the text that `ignore` excludes. */
function ignoredRanges(text: string, ignore: (string | Regex)[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const entry of ignore) {
    if (typeof entry === "string") {
      for (let at = text.indexOf(entry); at !== -1; at = text.indexOf(entry, at + 1)) {
        ranges.push([at, at + entry.length]);
      }
      continue;
    }
    const flags = new Set([...(entry.flags ?? ""), "g"]);
    for (const match of text.matchAll(new RegExp(entry.pattern, [...flags].join("")))) {
      if (match[0] !== "") ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

const overlaps = (ranges: [number, number][], start: number, end: number): boolean =>
  ranges.some(([s, e]) => start < e && s < end);

function findReferences(block: BlockItem, patterns: RegExp[], ignore: (string | Regex)[]) {
  const refs: Reference[] = [];
  const ignored = ignoredRanges(block.text, ignore);
  const taken: [number, number][] = [];
  patterns.forEach((regex, pattern) => {
    for (const match of block.text.matchAll(regex)) {
      const start = match.index;
      const end = start + match[0].length;
      if (end === start || overlaps(ignored, start, end) || overlaps(taken, start, end)) continue;
      const span = (name: string) => {
        const value = match.groups?.[name];
        const at = match.indices?.groups?.[name];
        if (value === undefined || at === undefined) return undefined;
        return { text: value, start: at[0] - start, end: at[1] - start };
      };
      const n = span("n");
      const title = span("title");
      if (n === undefined && title === undefined) continue;
      taken.push([start, end]);
      refs.push({
        pattern,
        block,
        text: match[0],
        n: n === undefined ? undefined : { ...n, key: numberKey(n.text) },
        title: title === undefined ? undefined : { ...title, text: title.text.trim() },
      });
    }
  });
  return refs;
}

/** Every block in the body, depth first, in document order. */
function* blocks(items: BodyItem[]): Generator<BlockItem> {
  for (const item of items) {
    if (item.kind === "block") yield item;
    yield* blocks(item.children);
  }
}

const sameId = (a: string, b: string): boolean =>
  a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();

/** `"text"` with the part from `start` to `end` replaced. */
const splice = (text: string, start: number, end: number, value: string): string =>
  `${text.slice(0, start)}${value}${text.slice(end)}`;

export function checkReferences(
  rule: ReferencesRule,
  numbering: NumberingRule | undefined,
  page: PageModel,
): Finding[] {
  const findings: Finding[] = [];
  const formats = headingFormats(numbering);
  const headings = indexHeadings(page.body, formats);
  const byKey = new Map<string, IndexedHeading>();
  const byTitle = new Map<string, IndexedHeading>();
  for (const heading of headings) {
    if (heading.key !== undefined && !byKey.has(heading.key)) byKey.set(heading.key, heading);
    if (!byTitle.has(heading.title)) byTitle.set(heading.title, heading);
    if (!byTitle.has(heading.item.text)) byTitle.set(heading.item.text, heading);
  }
  const titles = [...new Set(headings.map((h) => h.title))];
  const number = numberSource(formats);
  const patterns = rule.patterns.map((p) => compilePattern(p, titles, number));
  const ignore = rule.ignore ?? [];

  for (const block of blocks(page.body)) {
    if (!TEXT_BLOCKS.has(block.type)) continue;
    for (const ref of findReferences(block, patterns, ignore)) {
      const finding = checkReference(ref, byKey, byTitle);
      if (finding === undefined) continue;
      findings.push({
        path: joinPath(joinPath("references", "patterns"), ref.pattern),
        blockId: block.id,
        ...finding,
      });
    }
  }

  if (rule.notionLinks === true) findings.push(...checkSamePageLinks(page, headings, byTitle));
  return findings;
}

type Problem = Pick<Finding, "rule" | "message" | "suggestions">;

function checkReference(
  ref: Reference,
  byKey: Map<string, IndexedHeading>,
  byTitle: Map<string, IndexedHeading>,
): Problem | undefined {
  const quoted = `"${ref.text}"`;
  const { n, title } = ref;
  const section = n === undefined ? undefined : byKey.get(n.key);
  const named = title === undefined ? undefined : byTitle.get(title.text);

  if (n === undefined && title !== undefined) {
    if (named !== undefined) return undefined;
    const lower = title.text.toLowerCase();
    const near = [...byTitle.values()].find((h) => h.title.toLowerCase() === lower);
    const suggestions: Suggestion[] =
      near === undefined
        ? []
        : [
            {
              message: `Did you mean "${near.title}"?`,
              replacement: splice(ref.text, title.start, title.end, near.title),
            },
          ];
    return {
      rule: "references.title",
      message: `${quoted}: there is no heading "${title.text}"`,
      suggestions,
    };
  }
  if (n === undefined) return undefined;

  if (title === undefined) {
    if (section !== undefined) return undefined;
    return {
      rule: "references.number",
      message: `${quoted}: there is no section ${n.text}`,
      suggestions: [],
    };
  }

  // Both a number and a title.
  if (section !== undefined && (section.title === title.text || section.item.text === title.text)) {
    return undefined;
  }
  const renumber = (heading: IndexedHeading): Suggestion[] =>
    heading.number === undefined
      ? []
      : [
          {
            message: `Change the number to ${heading.number}`,
            replacement: splice(ref.text, n.start, n.end, heading.number),
          },
        ];
  if (section !== undefined) {
    const retitle: Suggestion = {
      message: `Change the title to "${section.title}"`,
      replacement: splice(ref.text, title.start, title.end, section.title),
    };
    if (named !== undefined) {
      const where =
        named.number === undefined
          ? `"${title.text}" has no section number`
          : `"${title.text}" is ${named.number}`;
      return {
        rule: "references.mismatch",
        message: `${quoted}: ${n.text} is "${section.title}"; ${where}`,
        suggestions: [...renumber(named), retitle],
      };
    }
    return {
      rule: "references.mismatch",
      message: `${quoted}: ${n.text} is "${section.title}"; there is no heading "${title.text}"`,
      suggestions: [retitle],
    };
  }
  if (named !== undefined) {
    return {
      rule: "references.number",
      message: `${quoted}: there is no section ${n.text}; "${title.text}" is ${named.number ?? "not numbered"}`,
      suggestions: renumber(named),
    };
  }
  return {
    rule: "references.number",
    message: `${quoted}: there is no section ${n.text} and no heading "${title.text}"`,
    suggestions: [],
  };
}

/**
 * What a link to a block of a page is checked against: the page's headings (numbered by the
 * page's own type) and the IDs of all its blocks.
 */
export interface LinkTarget {
  page: PageModel;
  headings: IndexedHeading[];
  byTitle: Map<string, IndexedHeading>;
  /** Block IDs, without hyphens, lowercase. */
  ids: Set<string>;
}

function headingsByTitle(headings: IndexedHeading[]): Map<string, IndexedHeading> {
  const byTitle = new Map<string, IndexedHeading>();
  for (const heading of headings) {
    if (!byTitle.has(heading.title)) byTitle.set(heading.title, heading);
    if (!byTitle.has(heading.item.text)) byTitle.set(heading.item.text, heading);
  }
  return byTitle;
}

function blockIds(page: PageModel): Set<string> {
  const ids = new Set<string>();
  const collect = (items: BodyItem[]) => {
    for (const item of items) {
      ids.add(item.id.replace(/-/g, "").toLowerCase());
      collect(item.children);
    }
  };
  collect(page.body);
  return ids;
}

/** Index a page as the target of links. `numbering` is the numbering rule of the page's own type. */
export function linkTarget(page: PageModel, numbering: NumberingRule | undefined): LinkTarget {
  const headings = indexHeadings(page.body, headingFormats(numbering));
  return { page, headings, byTitle: headingsByTitle(headings), ids: blockIds(page) };
}

/**
 * A link to a block of `target`. A link whose text reads like a section reference (it starts
 * with a section number, or is the title of another heading) must name the linked heading's
 * current number and title. Free text such as "here" is not checked. `other` is set when the
 * target is not the page that holds the link: the messages then name that page.
 */
export function checkBlockLink(
  link: NotionLink,
  blockId: string,
  target: LinkTarget,
  other: boolean,
): Finding | undefined {
  if (link.blockId === null) return undefined;
  const path = joinPath("references", "notionLinks");
  const on = other ? `the page "${target.page.title}"` : "this page";
  const heading = target.headings.find((h) => sameId(h.item.id, link.blockId as string));
  if (heading === undefined) {
    if (target.ids.has(link.blockId.replace(/-/g, "").toLowerCase())) return undefined;
    return {
      path,
      rule: "references.link",
      message: `link "${link.text}" points to a block that is no longer on ${on}`,
      suggestions: [{ message: "Link to the heading again, or remove the link" }],
      blockId,
    };
  }
  if (link.kind !== "link") return undefined; // Notion keeps the text of mentions up to date.
  if (!staleLinkText(link, heading, target.byTitle)) return undefined;
  return {
    path,
    rule: "references.link",
    message: `link "${link.text}" points to the heading "${heading.item.text}"${
      other ? ` on ${on}` : ""
    }`,
    suggestions: [
      {
        message: `Change the link text to "${heading.item.text}"`,
        replacement: heading.item.text,
      },
    ],
    blockId,
  };
}

/** Links to blocks on the same page. */
function checkSamePageLinks(
  page: PageModel,
  headings: IndexedHeading[],
  byTitle: Map<string, IndexedHeading>,
): Finding[] {
  const findings: Finding[] = [];
  const target: LinkTarget = { page, headings, byTitle, ids: blockIds(page) };
  for (const block of blocks(page.body)) {
    if (block.type === "code") continue;
    for (const link of block.links ?? []) {
      if (link.blockId === null || !sameId(link.pageId, page.id)) continue;
      const finding = checkBlockLink(link, block.id, target, false);
      if (finding !== undefined) findings.push(finding);
    }
  }
  return findings;
}

function staleLinkText(
  link: NotionLink,
  target: IndexedHeading,
  byTitle: Map<string, IndexedHeading>,
): boolean {
  const text = link.text.trim();
  if (text === target.item.text || text === target.title) return false;
  const numbered = /^\s*(\d+(?:[.-]\d+)*)[.:)]?(?:\s+(.*))?$/su.exec(text);
  if (numbered !== null) {
    const rest = (numbered[2] ?? "").trim();
    return (
      numberKey(numbered[1] as string) !== target.key || (rest !== "" && rest !== target.title)
    );
  }
  // A link text that is another heading's title points to the wrong heading.
  return byTitle.has(text);
}

/** A link to another page (or a block on it), whose existence `check` verifies. */
export interface OutsideLink {
  link: NotionLink;
  /** The block that holds the link. */
  blockId: string;
}

export function outsideLinks(rule: ReferencesRule | undefined, page: PageModel): OutsideLink[] {
  if (rule?.notionLinks !== true) return [];
  const out: OutsideLink[] = [];
  for (const block of blocks(page.body)) {
    if (block.type === "code") continue;
    for (const link of block.links ?? []) {
      if (!sameId(link.pageId, page.id)) out.push({ link, blockId: block.id });
    }
  }
  return out;
}
