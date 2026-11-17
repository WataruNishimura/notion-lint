import type { BodyItem, HeadingItem } from "../normalize/model.js";
import type { NumberingRule } from "../schema/config.js";
import type { Finding } from "./finding.js";

/**
 * Section numbers written by hand in headings (`numbering`).
 *
 * Each heading level that has a `format` is parsed into a number and a title. The checks:
 * - `numbering.format`: a heading does not fit its level's format.
 * - `numbering.hierarchy`: the number does not continue its parent section's number
 *   (an H2 "3.1" under the H1 "2.").
 * - `numbering.sequence` (`sequential`, default true): sibling sections do not run 1, 2, 3
 *   (a gap, a duplicate, or a number that goes back).
 */

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A literal part of a format: whitespace matches any run of whitespace. */
const literalSource = (text: string): string => text.split(/\s+/).map(escapeRegex).join("\\s+");

/** One level's `format`, compiled. */
export class HeadingFormat {
  readonly regex: RegExp;
  /** How many `{n}` the format has (the depth of the number). */
  readonly depth: number;

  constructor(
    readonly level: number,
    readonly format: string,
  ) {
    let source = "";
    let n = 0;
    let titleSeen = false;
    for (const token of format.split(/(\{n\}|\{title\})/)) {
      if (token === "{n}") source += `(?<n${n++}>\\d+)`;
      else if (token === "{title}" && !titleSeen) {
        titleSeen = true;
        source += "(?<title>.+?)";
      } else source += literalSource(token);
    }
    this.depth = n;
    this.regex = new RegExp(`^\\s*${source}\\s*$`, "u");
  }

  /** The number and title of a heading text, or undefined when it does not fit the format. */
  parse(text: string): { parts: number[]; title: string } | undefined {
    const groups = this.regex.exec(text)?.groups;
    if (groups === undefined) return undefined;
    const parts = Array.from({ length: this.depth }, (_, i) => Number(groups[`n${i}`]));
    return { parts, title: (groups.title ?? "").trim() };
  }

  /**
   * The number as the format writes it, from the first to the last `{n}`: "2.1" for
   * "{n}.{n} {title}", "2-1" for "{n}-{n} {title}", "2" for "第{n}章 {title}".
   */
  renderNumber(parts: readonly number[]): string {
    const first = this.format.indexOf("{n}");
    const last = this.format.lastIndexOf("{n}");
    if (first === -1) return "";
    let i = 0;
    return this.format.slice(first, last + 3).replace(/\{n\}/g, () => String(parts[i++] ?? "?"));
  }

  /** A full heading text in this format. */
  render(parts: readonly number[], title: string): string {
    let i = 0;
    return this.format.replace(/\{n\}/g, () => String(parts[i++] ?? "?")).replace("{title}", title);
  }

  /** Text between consecutive `{n}` (e.g. "." in "{n}.{n} {title}"). */
  separators(): string[] {
    const out: string[] = [];
    const between = this.format.split("{n}").slice(1, -1);
    for (const text of between) if (text !== "" && !text.includes("{title}")) out.push(text);
    return out;
  }
}

/** The formats of a `numbering` rule by heading level. */
export function headingFormats(numbering: NumberingRule | undefined): Map<number, HeadingFormat> {
  const formats = new Map<number, HeadingFormat>();
  for (const [key, format] of Object.entries(numbering?.format ?? {})) {
    if (format === undefined) continue;
    const level = Number(key.slice(1));
    formats.set(level, new HeadingFormat(level, format));
  }
  return formats;
}

/** All headings of a body, in document order (including headings inside toggles and other blocks). */
export function allHeadings(items: BodyItem[]): HeadingItem[] {
  const out: HeadingItem[] = [];
  const visit = (list: BodyItem[]) => {
    for (const item of list) {
      if (item.kind === "heading") out.push(item);
      visit(item.children);
    }
  };
  visit(items);
  return out;
}

interface Section {
  /** Undefined for the page itself (the root of the numbering). */
  heading: HeadingItem | undefined;
  level: number;
  /** The parsed number; undefined when the heading has no format or does not fit it. */
  parts: number[] | undefined;
  /** Last number used by child sections, per child level. */
  last: Map<number, number>;
}

export function checkNumbering(numbering: NumberingRule, items: BodyItem[]): Finding[] {
  const findings: Finding[] = [];
  const formats = headingFormats(numbering);
  const sequential = numbering.sequential ?? true;
  const root: Section = { heading: undefined, level: 0, parts: [], last: new Map() };
  const stack: Section[] = [root];
  const minLevel = Math.min(...formats.keys());

  for (const heading of allHeadings(items)) {
    while ((stack.at(-1) as Section).level >= heading.level) stack.pop();
    const format = formats.get(heading.level);
    const section: Section = { heading, level: heading.level, parts: undefined, last: new Map() };
    if (format === undefined) {
      stack.push(section);
      continue;
    }
    // The nearest enclosing section whose level is numbered (or the page itself).
    const parent = stack.findLast((s) => s === root || formats.has(s.level)) ?? root;
    const parentParts = parent === root ? [] : parent.parts;
    const previous = parent.last.get(heading.level) ?? 0;
    // The number this heading should have, if the parent's number is known and fits.
    const expected =
      parentParts !== undefined && parentParts.length === format.depth - 1
        ? [...parentParts, previous + 1]
        : undefined;
    const path = `numbering.format.h${heading.level}`;

    const parsed = format.parse(heading.text);
    if (parsed === undefined) {
      const title = stripLooseNumber(heading.text);
      const replacement = expected === undefined ? undefined : format.render(expected, title);
      findings.push({
        path,
        rule: "numbering.format",
        message: `heading "${heading.text}" does not match the H${heading.level} format "${format.format}"`,
        suggestions: [
          replacement === undefined
            ? { message: `Write the heading as "${format.format}"` }
            : { message: `Write it as "${replacement}"`, replacement },
        ],
        blockId: heading.id,
      });
      // It still takes a place among its siblings, so the next one is not reported as a gap.
      parent.last.set(heading.level, previous + 1);
      stack.push(section);
      continue;
    }

    const { parts, title } = parsed;
    section.parts = parts;
    const number = format.renderNumber(parts);
    const prefix = parts.slice(0, -1);
    const own = parts.at(-1) as number;

    let hierarchyOk = true;
    if (prefix.length > 0 && parentParts !== undefined) {
      if (parent === root) {
        // A number like 2.1 needs a numbered parent section, unless no higher level is numbered.
        if (heading.level > minLevel) {
          hierarchyOk = false;
          findings.push({
            path: "numbering",
            rule: "numbering.hierarchy",
            message: `heading "${heading.text}" is not under a section ${prefix.join(".")}`,
            suggestions: [
              { message: `Put "${heading.text}" under its parent section, or renumber it` },
            ],
            blockId: heading.id,
          });
        }
      } else if (parentParts.length === prefix.length && !sameParts(parentParts, prefix)) {
        hierarchyOk = false;
        const replacement = expected === undefined ? undefined : format.render(expected, title);
        findings.push({
          path: "numbering",
          rule: "numbering.hierarchy",
          message: `heading "${heading.text}" is under "${parent.heading?.text}", so its number should start with ${parentParts.join(".")}`,
          suggestions: [
            replacement === undefined
              ? { message: `Renumber "${heading.text}"` }
              : { message: `Renumber it to "${replacement}"`, replacement },
          ],
          blockId: heading.id,
        });
      }
    }

    if (sequential && hierarchyOk && own !== previous + 1) {
      const right = format.render([...prefix, previous + 1], title);
      const what =
        own > previous + 1
          ? `skips ${format.renderNumber([...prefix, previous + 1])}`
          : own === previous
            ? `repeats ${number}`
            : `goes back (the previous one is ${format.renderNumber([...prefix, previous])})`;
      findings.push({
        path: "numbering.sequential",
        rule: "numbering.sequence",
        message: `heading "${heading.text}" ${what}`,
        suggestions: [{ message: `Renumber it to "${right}"`, replacement: right }],
        blockId: heading.id,
      });
    }
    parent.last.set(heading.level, own);
    stack.push(section);
  }
  return findings;
}

function sameParts(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** "2.1. Background" or "2-1 Background" -> "Background", for a suggested rewrite. */
function stripLooseNumber(text: string): string {
  return text.replace(/^\s*\d+(?:[.\-－]\d+)*[.:)]?\s*/u, "").trim() || text;
}
