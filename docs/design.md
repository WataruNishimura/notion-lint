# notion-lint plan

A CLI that checks whether Notion pages follow a prescribed format.

## Direction (decided 2026-11-10)

- Build it as a new repository, `notion-lint` (under this folder). Implementation is done in an Orca project for that repository.
- A Node + TypeScript CLI. It fetches pages through the Notion API (integration token) and judges them. It can also run in CI and on a schedule.
- Unlike ESLint, which turns individual rules on and off, **the `notion-lint.config.ts` file describes the document "type" (schema), and pages are verified against that type**. It is close to validating data with zod.
- What a type can express: heading structure, properties, notation in the body, conformance to a template, and agreement between section numbers and cross-references in the body.
- Designed for use by agents. A type can also be written as JSON and passed on standard input. Results are returned as JSON too.

## Example config file

```ts
// notion-lint.config.ts
import { defineConfig, doc, prop, h, block, text, numbering, references } from "notion-lint";

// Document type. The 議事録 (meeting notes) type uses Japanese headings and property names on
// purpose, to show that they are checked as written. The other examples use English names.
const 議事録 = doc({
  properties: {
    日付: prop.date().required(),
    参加者: prop.people().min(1),
    種別: prop.select(["定例", "臨時"]),
    チケット: prop.richText().pattern(/^[A-Z]+-\d+$/).optional(),
  },
  // Skeleton of the body. Requires the elements to appear in this order from top to bottom
  body: [
    h.h2("目的"),
    h.h2("決定事項", {
      children: block.list().min(1), // one or more bulleted items under the heading
    }),
    h.h2("TODO", { children: block.todo() }),
    h.h2("メモ").optional(),
  ],
  headings: { noSkipLevel: true, allowExtra: true }, // whether headings not in the type are allowed
  text: text.textlint({ preset: "ja-technical-writing", prh: "./prh.yml" }),
});

// Documents with numbered chapters: also checks that chapter numbers and references to chapters in the body agree
const spec = doc({
  body: [h.h1("Overview"), h.h1("Requirements"), h.h1("Design")],
  numbering: numbering({
    // How headings are written. H1 is "1. Overview", H2 is "1.1 Background"
    format: { h1: "{n}. {title}", h2: "{n}.{n} {title}", h3: "{n}.{n}.{n} {title}" },
    sequential: true, // runs 1, 2, 3 without gaps or duplicates
  }),
  references: references({
    // Forms of references in the body (regular expressions are also allowed)
    patterns: ["see chapter {n}", "see section {n}", "see \"{title}\"", "as described in \"{title}\""],
    notionLinks: true, // also checks the link text of links to blocks and the heading they point to
  }),
});

// A type can also be made from a template page
const design = doc.fromTemplate("<template page ID>", {
  properties: { status: prop.status(["Draft", "In review", "Final"]) },
});

export default defineConfig({
  // Which type applies to which pages
  targets: [
    { dataSource: "<data source ID of the meeting notes DB>", type: 議事録 },
    { dataSource: "<design DB>", where: { status: "Final" }, type: design },
    { page: "<single page ID>", type: design },
  ],
});
```

- A type is a TypeScript value, so shared parts can be put in variables and reused, or derived with `議事録.extend({...})`.
- Violations are reported with "which page, which block or property, and where in the type it fails", with a Notion link. (Japanese example: the meeting notes type above, checked against a page.)

```
議事録 2026-11-04 定例  https://notion.so/...
  ✖ properties.参加者   needs at least 1 person (0 found)
  ✖ body[1]             heading "決定事項" is missing (required after "目的")
  ⚠ body > 目的         textlint: 「出来る」→「できる」 (ja-technical-writing/ja-no-weak-phrase)
```

## Use from agents

Lets agents such as Claude assemble a type on the spot and run the check.

**A type can also be written as JSON**
- Builders such as `doc()` only create a data structure that can be written as JSON. That data structure is defined by a JSON Schema, which is the source of truth.
- Regular expressions are written as strings (`{ "pattern": "^[A-Z]+-\\d+$" }`). Specifications that cannot be written as JSON, such as passing a function, are not offered.
- The TS config file is a layer that makes things easier for people to write. `notion-lint print-config` writes it out as JSON.

**Ways to pass input**

| Option | Use |
|---|---|
| `--config notion-lint.config.ts` | For people |
| `--config -` | Reads JSON from standard input. Agents basically use this. It avoids limits on length and shell quoting problems |
| `--config-json '{...}'` | For trying a short type |

A type passed as JSON is never executed as code. Only TS config files are executed.

**Output for agents**
- `notion-lint schema`: prints the JSON Schema of the config. Agents read it to assemble a type.
- `--format json`: for each violation, gives the page ID, the block ID, where it corresponds in the type (`body[1]`, `properties.attendees`, etc.), the message, and structured fix suggestions.
- `--page <URL or ID>`: ignores the `targets` in the config file and checks only the page specified on the spot.
- Exit codes: 0 means no violations, 1 means violations were found, and 2 means a config error or API error. Even config errors are returned as JSON, showing which fields do not match the schema. With `--format github`, errors are written as an `::error` annotation instead.

**Example**

```sh
echo '{"type":{"body":[{"heading":2,"title":"Purpose"}]}}' \
  | notion-lint --config - --page https://www.notion.so/xxxx --format json
```

**`notion-lint agent`: writes an agent instruction for the repository**

Automatically finds the agent instruction file in the repository and appends how to use notion-lint.

- Where it looks: from the current directory upward to the first Git root. If outside Git, the current directory.
- Files it looks for (case-insensitive): `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `.claude/CLAUDE.md`.
- How it chooses where to write:

| What was found | Where to write |
|---|---|
| Only one of them | That file |
| `CLAUDE.md` imports `@AGENTS.md` | `AGENTS.md` only (so it is not loaded twice) |
| Both exist and neither imports the other | Both |
| None exist | Writes nothing; tells the user to create one, e.g. with `--create AGENTS.md`, and exits with code 2 |

- The appended section is wrapped in `<!-- notion-lint:start -->` and `<!-- notion-lint:end -->`. Running it again replaces only that range with the latest content, so repeated runs never duplicate it. Anything outside the range is not changed.
- Options: `--target <file>` to choose the file to write, `--dry-run` to show only the diff, `--print` to only print the text to standard output, `--remove` to delete the appended section.
- Keep the appended text short, since these files are loaded into the agent every time. It contains only the following essentials; details are left to `notion-lint schema` and `notion-lint --help`.
  - Assemble the type from the JSON Schema given by `notion-lint schema`, and pass it on standard input with `--config -`
  - Receive results with `--format json`; exit codes are 0 / 1 / 2
  - The token is `NOTION_TOKEN`. Never write its value to files or output
  - If the repository has a `notion-lint.config.ts`, prefer it
  - Include the notion-lint version in the text so that it can prompt a re-run when the text is out of date

In the future, the same features (`schema` / `check`) could be exposed as an MCP server. It would only call the same internals as the CLI. The first release is CLI only.

## Structure

```
config load → fetch (Notion API) → normalize (internal representation) → match against the type → report → exit code
```

| Layer | Contents |
|---|---|
| config | Loads `notion-lint.config.ts` with `jiti` or similar. The builders `doc / prop / h / block / text` create the type definitions (internally, just data structures) |
| fetch | `@notionhq/client`. Collects target pages by page ID, or by data source plus conditions (`where` becomes a query filter built from the data source schema where possible; the rest is checked locally). Formula and rollup conditions are translated from what a few sample pages show the property yields (the schema does not say), and files as empty / not empty. A `dataSource` that is a database ID or URL is resolved to its only data source. Reads long people / files / relation / title / rich_text values in full through the page property endpoint. Recursively fetches child blocks, and handles pagination and rate limits (about 3 requests/s on average) |
| normalize | Converts API JSON into a block tree (headings, paragraphs, lists, etc.) and a dictionary of properties. The matching code never looks at the raw API shape |
| validate | Properties are checked item by item. The body is matched in order by aligning the "skeleton of the type" with "the heading tree of the page" (extra headings follow `allowExtra`). Body text is converted to Markdown and passed to textlint |
| report | Human-readable format, JSON, and GitHub Actions annotations. With `--format github`, errors (exit code 2) are annotations too: `::error title=notion-lint error` with the message and the mismatched config fields, `file=` set when the error is about a config file (not stdin or `--config-json`), and the page or data source in the message when the error is about one. They go to standard output, where the runner reads them; the text format keeps writing errors to standard error and `--format json` to standard output as JSON |

## How the body is matched

- Build a tree from the page's headings (blocks under a heading are children of that heading).
- Match the type's `body` array against the page's headings in order, by name. Wrong order, missing, and extra headings are each reported as separate violations.
- Heading names are matched exactly by default, but regular expressions are also allowed, such as `h.h2(/^Decisions/)`.
- `doc.fromTemplate` fetches the template page and generates a `body` of the same shape automatically. Changing the template changes the type too. How the skeleton is built (implemented):
  - Only the template's headings become entries: each is a required heading with the template's level and exact text (a section number in the `numbering` format is stripped). Sub-headings become `children`, so the nesting is checked too. Paragraphs, lists, and other blocks in a template are placeholder content, so they produce no block entries (write `body` yourself if a section needs, say, a list).
  - No entry is optional. A heading gets `children` only when the template has sub-headings under it, so `headings.allowExtra: false` forbids extra headings at the top level and under such headings only. Headings deeper than H3, empty headings, and headings nested in other blocks (toggles, columns) are ignored.
  - `properties`, `headings`, and the other settings of the type apply as written, together with the template-derived body. Properties of the template page itself are not used.
  - If the type also has a `body`, that `body` replaces the template's (no merge) and the template is not fetched.
  - Each template page is fetched once per run, however many targets use it. A template that cannot be read is an API error (exit code 2); an invalid template page ID is a config error (exit code 2).

## Linting the body text

Implemented in `src/text`. The body is converted to Markdown with a source map from Markdown lines to block IDs, and the textlint kernel runs on it. Differences from the plan above:

- `rule` is textlint's own rule ID (`ja-technical-writing/ja-no-weak-phrase`, `prh`), without a `textlint/` prefix, and `path` is `body > <heading> > ...` as in the example output.
- The message is textlint's message followed by `(<rule ID>)`, so the text format shows the rule.
- Severity is `warning` unless the rule is configured with `severity: "error"`; warnings count as violations.
- Presets and prh paths resolve from the config file's directory (the current directory for JSON configs), then from notion-lint's own dependencies. A missing one is a config error (exit code 2), reported before any page is fetched.
- Code, equations, tables and dividers are not linted; only each block's plain text is known.

## Matching section numbers and references

Notion headings have no automatic section numbers, so the numbers are assumed to be typed by hand in the heading text and are checked on that basis.

**Section numbers (`numbering`)**
- Splits heading text into number and title according to `format`. A heading that does not fit the format is a violation.
- Checks that numbers agree with the heading hierarchy (an H2 "2.1" must follow an H1 "2.") and that there are no gaps or duplicates.
- How it is implemented:
  - `{n}` is one part of the number, and whitespace in a format matches any whitespace. Levels without a format are not checked. Headings nested in toggles and other blocks count, in document order.
  - Rules: `numbering.format` (the suggestion is the heading rewritten with the number it should have), `numbering.hierarchy` (the number does not continue the enclosing numbered section, or "1.1" comes before any numbered parent), and `numbering.sequence` (siblings under one parent must run 1, 2, 3; `sequential` defaults to true). After a gap or a duplicate, counting continues from the number written, so one mistake is reported once.

**References (`references`)**
- Finds places in the body (paragraphs, lists, tables, callouts, etc.) that match `patterns`, and matches them against the list of headings on the page.

| Example in the body | What is checked | Example violation |
|---|---|---|
| "see chapter 3" | There is a chapter 3 | There are only two chapters |
| "2.1 \"Background\" describes this" | Section 2.1 is titled "Background" | 2.1 is "Purpose"; "Background" is 2.2 |
| "see \"Background\"" | A heading "Background" exists | The heading was renamed to "Context" |
| Block link with text "2.1 Background" | The linked heading is 2.1 "Background" | Sections were reordered but the link text is stale |

- When a number and a title disagree, the message shows the fix, e.g. "2.1 is 'Purpose'. 'Background' is 2.2".
- References to other pages (page mentions, links to blocks on other pages) check that the target exists and can be read. When that page is also a check target in the same run, a link to a block on it is also checked against its headings (see below).
- "Chapter 3" in the body may refer to a chapter in a different document, so `ignore` lets you specify excluded words or excluded ranges.
- How it is implemented:
  - Searched blocks: paragraphs, list items, to-dos, toggles, quotes, callouts, and table cells. Code blocks and headings are not searched.
  - A template matches case-insensitively, and `{n}` is a number whose parts are joined by `.` or by the separators the `numbering` formats use. A `{title}` between punctuation (quotes, brackets) takes the text up to the closing character. An unquoted `{title}` only matches titles of existing headings, because its end cannot be found otherwise; so it cannot report a missing heading. When several patterns match the same text, the first one wins.
  - Rules: `references.number` (no such section), `references.mismatch` (number and title disagree; suggestions fix either one), `references.title` (no heading with that title), `references.link` (same-page link text is stale, or the linked block is gone), and `references.target` (another page cannot be read). Each violation carries the block ID of the block that holds the reference.
  - Without `numbering`, a heading that starts with "2.1 " or "2. " still counts as that section.
  - `ignore`: a reference that overlaps an occurrence of an ignored string, or a match of an ignored regex, is skipped. A regex covers ranges such as "chapter 3 of RFC 9110".
  - Same-page links (`notionLinks`): only link text that reads like a reference is checked: text that starts with a section number, or that is another heading's title. Free text such as "here" is not. Mentions are not checked for text, since Notion keeps it up to date.
  - Other pages (`notionLinks`): page mentions, links to pages or blocks, and `link_to_page` blocks. Each target is retrieved once per run with `GET /v1/blocks/{id}` (a page ID works too); not found, no access, or in the trash is a violation, and other API errors stop the check (exit code 2). 
  - Other pages that are also checked in the run: all pages are fetched and matched first, and links are validated afterwards, so a checked page is never fetched again, and it counts as existing without a request. A text link to a block on it is matched against that page's headings the way same-page links are (`references.link`), using the page's own type: its `numbering` format when it has one, otherwise the "2.1 " / "2. " fallback. The message names the page: `link "2.1 Quotas" points to the heading "2.2 Quotas" on the page "API reference"`, with the same suggestion (the heading text). A block that is no longer on that page is also `references.link`. Page mentions, links to a page without a block, and mentions of a block are only checked for existence, since Notion keeps their text up to date. This also holds when the other page's type needs no body (it was fetched without blocks): then its block links fall back to the existence check. Text references (`patterns`) are matched against the page that holds them only, because they do not name a page. If a page is checked twice with different types, the first one is used.

## Tests

- Save Notion API response JSON as fixtures, and check them with vitest without network access.
- Keep the type builders and the matching code separate so they can be unit-tested without Notion.
- Manual checks against a real workspace are done with a dedicated test page.

## Steps

1. Scaffold: pnpm, TypeScript, vitest, Biome, the CLI entry point
2. Type data structures and JSON Schema, loading from `--config -` / `--config-json` / config.ts, the `schema` command. On top of that, the type builders (`doc / prop / h / block`)
3. fetch and normalize (unit-tested with fixtures)
4. Property matching
5. Body (heading tree) matching and error display (for people and `--format json`)
6. Section number and reference matching
7. textlint integration
8. `doc.fromTemplate`
9. `notion-lint agent` (detecting and appending to instruction files)
10. Example of scheduled runs on GitHub Actions: [examples/github-actions/notion-lint.yml](../examples/github-actions/notion-lint.yml) (schedule + `workflow_dispatch`, `NOTION_TOKEN` from a secret, explicit `--config`, `--format github`). Every `--format github` annotation ends with a Notion link, the block's or, failing that, the page's. The workflow builds notion-lint from source because it was written before the first npm release; its comments show how to switch to `npx notion-lint@<version>` after it.
11. Release preparation: the package is published to npm as `notion-lint` (MIT, version 0.1.0 for the first release). `files` ships `dist/` and `schema/` (the textlint presets and prh are dependencies and are resolved from notion-lint's own `node_modules`; `package.json` is read at runtime for the version), plus README, LICENSE, CHANGELOG, and package.json, which npm always adds. `prepack` builds, so `npm pack` works from a fresh clone, and `test/package.test.ts` checks the tarball contents and that the built CLI starts. [.github/workflows/release.yml](../.github/workflows/release.yml) runs on pushed `v*` tags only: `pnpm check`, `pnpm build`, a check that the tag equals the `package.json` version, then `npm publish --provenance --access public` with `NPM_TOKEN`, and a GitHub release from the CHANGELOG section. The maintainer's steps are in [releasing.md](releasing.md).

## Notes

- In Notion API version 2025-09-03, databases are split into "data sources", and queries run against data source IDs. Assume the new API version.
- An integration can read a page only after it is connected (shared) to that page.
- Pass the token through the environment variable `NOTION_TOKEN`, and do not put it in the repository.
- Do not write body notation rules from scratch; use textlint's existing rules (`textlint-rule-preset-ja-technical-writing`, and the notation dictionary `prh`).

## Open questions

- Which Notion workspace, which databases, and which concrete document types to check
- How section numbers and references are actually written (e.g. "Chapter 3", "3.", "3-1"). Decide the initial values of `format` and `patterns` by looking at existing documents
- Whether to automate fixes or post comments on pages (the first release is assumed to be check-only)
