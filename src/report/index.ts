import type { CheckResult, Violation } from "../schema/result.js";

/**
 * Output of a finished check (exit code 0 or 1). Errors (exit code 2) are written by run.ts.
 */

export function formatJson(result: CheckResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

const MARK = { error: "✖", warning: "⚠" } as const;

/** East Asian wide characters take two columns in a terminal. */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE.test(char) ? 2 : 1;
  return width;
}

function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * For people: each page with violations as its title and URL, then one line per violation.
 *
 * ```
 * Meeting 2026-11-04  https://www.notion.so/...
 *   ✖ properties.Attendees  needs at least 1 person (0 found)
 *   ✖ body[1]               heading "Decisions" is missing (required after "Purpose")
 * ```
 */
export function formatText(result: CheckResult): string {
  const lines: string[] = [];
  for (const page of result.pages) {
    if (page.violations.length === 0) continue;
    lines.push(
      `${page.title === undefined || page.title === "" ? "(untitled)" : page.title}  ${page.url}`,
    );
    const width = Math.max(...page.violations.map((v) => displayWidth(v.path)));
    for (const violation of page.violations) {
      lines.push(
        `  ${MARK[violation.severity]} ${padEnd(violation.path, width)}  ${violation.message}`,
      );
    }
    lines.push("");
  }
  for (const note of result.notes) lines.push(`ℹ ${note.path}  ${note.message}`);
  if (result.notes.length > 0) lines.push("");

  const { summary } = result;
  if (summary.violations === 0) {
    lines.push(`✔ ${plural(summary.pages, "page")} checked, no problems`);
  } else {
    const failing = result.pages.filter((p) => p.violations.length > 0).length;
    lines.push(
      `✖ ${plural(summary.violations, "problem")} (${plural(summary.errors, "error")}, ${plural(summary.warnings, "warning")}) in ${failing} of ${plural(summary.pages, "page")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// GitHub Actions workflow commands:
// https://docs.github.com/actions/reference/workflow-commands-for-github-actions
function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function annotation(
  page: { title?: string | undefined; url: string },
  violation: Violation,
): string {
  const level = violation.severity === "error" ? "error" : "warning";
  const title = escapeProperty(`notion-lint ${violation.path}`);
  const name = page.title === undefined || page.title === "" ? "(untitled)" : page.title;
  // Every annotation links to Notion: the block when the violation has one, otherwise the page.
  const link = violation.url ?? page.url;
  return `::${level} title=${title}::${escapeData(`${name}: ${violation.message} ${link}`)}`;
}

/** GitHub Actions annotations: one `::error` / `::warning` per violation, `::notice` per note. */
export function formatGithub(result: CheckResult): string {
  const lines: string[] = [];
  for (const page of result.pages) {
    for (const violation of page.violations) lines.push(annotation(page, violation));
  }
  for (const note of result.notes) {
    lines.push(
      `::notice title=${escapeProperty(`notion-lint ${note.path}`)}::${escapeData(note.message)}`,
    );
  }
  const { summary } = result;
  lines.push(
    `notion-lint: ${plural(summary.pages, "page")} checked, ${plural(summary.violations, "problem")}`,
  );
  return `${lines.join("\n")}\n`;
}
