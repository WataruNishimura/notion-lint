import { VERSION } from "../version.js";

export const START_MARKER = "<!-- notion-lint:start -->";
export const END_MARKER = "<!-- notion-lint:end -->";

const START_RE = /<!--\s*notion-lint:start\s*-->/g;
const END_RE = /<!--\s*notion-lint:end\s*-->/g;

/** The text between the markers. Short on purpose: the file is loaded into the agent every time. */
export function sectionBody(version: string = VERSION): string[] {
  return [
    "## notion-lint",
    "",
    `Written by notion-lint ${version}. If \`notion-lint --version\` differs, run \`notion-lint agent\` again to refresh this section.`,
    "",
    "- Build the type from the JSON Schema printed by `notion-lint schema`, and pass it on standard input with `--config -`.",
    "- Read results with `--format json`. Exit codes: 0 = no violations, 1 = violations found, 2 = config or API error.",
    "- The Notion token is `NOTION_TOKEN`. Never write its value to files or output.",
    "- If the repository has a `notion-lint.config.ts`, prefer it.",
    "- Details: `notion-lint --help`.",
  ];
}

/** The full section with its markers, using the given line ending and no trailing line ending. */
export function renderSection(eol: string, version: string = VERSION): string {
  return [START_MARKER, ...sectionBody(version), END_MARKER].join(eol);
}

export function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export type Range = { start: number; end: number };
export type FindResult =
  | { kind: "none" }
  | { kind: "found"; range: Range }
  | { kind: "malformed"; message: string };

/** Locate the marked section: from the start marker to the end of the end marker. */
export function findSection(text: string): FindResult {
  const starts = [...text.matchAll(START_RE)];
  const ends = [...text.matchAll(END_RE)];
  if (starts.length === 0 && ends.length === 0) return { kind: "none" };
  const start = starts[0];
  const end = ends[0];
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined) {
    return {
      kind: "malformed",
      message: `Expected exactly one ${START_MARKER} and one ${END_MARKER} (found ${starts.length} and ${ends.length})`,
    };
  }
  if (end.index < start.index) {
    return { kind: "malformed", message: `${END_MARKER} comes before ${START_MARKER}` };
  }
  return { kind: "found", range: { start: start.index, end: end.index + end[0].length } };
}

/** Add the section, or replace the existing one. Text outside the markers is kept byte for byte. */
export function upsertSection(text: string, version: string = VERSION): string | Error {
  const found = findSection(text);
  if (found.kind === "malformed") return new Error(found.message);
  const eol = detectEol(text);
  const section = renderSection(eol, version);
  if (found.kind === "found") {
    return text.slice(0, found.range.start) + section + text.slice(found.range.end);
  }
  if (text.length === 0) return `${section}${eol}`;
  const lineEnd = text.endsWith("\n") ? "" : eol;
  const separator = text.endsWith(`${eol}${eol}`) ? "" : eol;
  return `${text}${lineEnd}${separator}${section}${eol}`;
}

/** Remove the section and the blank line that `upsertSection` put in front of it. */
export function removeSection(text: string): string | Error {
  const found = findSection(text);
  if (found.kind === "malformed") return new Error(found.message);
  if (found.kind === "none") return text;
  const { start } = found.range;
  let { end } = found.range;
  // Drop the line ending that closes the end marker's line.
  if (text.startsWith("\r\n", end)) end += 2;
  else if (text.startsWith("\n", end)) end += 1;
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (after.length === 0) {
    // The section was last: also drop the one blank line that separated it from the text above.
    const eol = detectEol(text);
    if (before.endsWith(`${eol}${eol}`)) return before.slice(0, -eol.length);
    return before;
  }
  return before + after;
}
