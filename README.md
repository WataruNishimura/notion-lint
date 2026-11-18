# notion-lint

A CLI that checks whether Notion pages match the document "types" written in `notion-lint.config.ts`: properties, heading structure, notation in the body, and templates.

See [docs/design.md](docs/design.md) for the design.

> Currently implemented: loading and validating the config, the `schema` / `print-config` / `agent` commands, and `check` with property and body (heading tree) matching. `doc.fromTemplate` (the body skeleton is built from a template page's headings), section numbers and references (`numbering`, `references`), and textlint (`text`).

## Install

After the first release (0.1.0), notion-lint is on npm. It needs Node 22 or later.

```sh
npm install --global notion-lint   # then run `notion-lint`
npx notion-lint --help             # or run it without installing
```

Until then, or to run an unreleased version, build it from source:

```sh
git clone https://github.com/WataruNishimura/notion-lint.git
cd notion-lint
pnpm install
pnpm build
node dist/cli.js --help
```

To release a new version, see [docs/releasing.md](docs/releasing.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## `notion-lint check`

```sh
export NOTION_TOKEN=...   # token of an integration connected to the pages
notion-lint --page https://www.notion.so/Meeting-0123456789abcdef0123456789abcdef
notion-lint --format json          # check the config's targets; JSON for agents
notion-lint --format github        # GitHub Actions annotations
```

```
議事録 2026-11-05 臨時  https://www.notion.so/...
  ✖ properties.参加者     needs at least 1 person (0 found)
  ✖ body[1]               heading "決定事項" is missing (required after "目的")
  ✖ headings.noSkipLevel  H3 "詳細" follows H1 "付録" (skips H2)

✖ 3 problems (3 errors, 0 warnings) in 1 of 2 pages
```

- Pages come from `--page` (with the config's `type`) or from `targets`: a `page`, or every page of a `dataSource` (Notion API 2025-09-03 data source ID) whose properties equal the `where` values.
- Requests are paced to about 3 per second. A 429 response is retried after its Retry-After delay, and 429 / 5xx responses are retried up to 5 times.
- `--format json` prints the shape in [schema/result.schema.json](schema/result.schema.json) (`notion-lint schema result`): for each page, violations with `pageId`, `blockId`, `path` in the type (`properties.<name>`, `body[1]`, `body[1].children[0]`), `rule`, `severity`, `message`, `suggestions`, and a Notion `url`. `notes` lists information that is not a violation, such as a part of a type that a version does not check yet (`rule: "skipped"`); notes do not change `ok` or the exit code. Every part of a type is checked now, so `notes` is empty.
- A missing `NOTION_TOKEN` or a Notion API error exits with code 2 (`error.kind` is `api`). The token is never printed.

Body text with textlint (`text.textlint`):

- The body is converted to Markdown (headings, paragraphs, nested lists, to-dos, quotes, callouts, and tables as GFM tables; code blocks, equations and dividers are left out) and linted with the textlint kernel, with no shell command. Each message becomes a violation on its block: `blockId`, a `path` such as `body > <heading> > <sub-heading>` (`body` before the first heading), `rule` as textlint names it (`ja-technical-writing/ja-no-weak-phrase`, `prh`), and the message followed by the rule name. When textlint offers a fix, it is a suggestion with `replacement`.
- `presets` are resolved as `textlint-rule-preset-<name>`, `rules` as `textlint-rule-<name>` (a `<preset>/<rule>` key changes or, with `false`, switches off a preset rule), and `prh` dictionary paths relative to the config file (the current directory for JSON from `--config-json` or standard input). Packages are looked up from the config file's directory first, then in notion-lint's own dependencies; `textlint`, `textlint-rule-preset-ja-technical-writing` and `textlint-rule-prh` are installed with notion-lint. A preset, rule or dictionary that cannot be found exits with code 2 before any page is fetched.
- Severity: textlint findings are `warning` by default, as in the design example. A rule configured with `{ "severity": "error" }` reports `error`; textlint's `info` also maps to `warning`. Warnings still count as violations (exit code 1).
- Inside a block, bold, italic and other formatted text is linted as plain text, and so is link text; URLs are not linted. Inline code, inline equations and mentions become code spans, which textlint rules do not read as prose (Notion writes a mention's text, so it cannot be fixed in the block). Markdown syntax characters in the text are escaped.
- A message in a table cell is reported on the table row block (its `blockId` and URL), and the message starts with the row and column: `row 2, column 2: 出来る => できる ...`. Rows and columns count from 1, and the first row is row 1.

How the body is matched:

- The page's blocks form a heading tree: blocks under a heading, up to the next heading of the same or a higher level, are its children. Synced blocks and columns are transparent; child pages are not part of the body.
- The type's `body` headings are mapped in order to the page's headings by name (exact text, or `{ "pattern": ... }`). Rules: `body.missing`, `body.order` (the longest in-order run is kept, the rest are reported), `body.level`, and `body.extra` when `headings.allowExtra` is false (at the top level, and under headings whose `children` are given). `headings.noSkipLevel` reports `headings.skipLevel`.
- Block entries such as `{ "block": "list", "min": 1 }` are matched in order against the blocks before the first sub-heading at that level; each takes the next run of consecutive blocks of its kind (`body.min`, `body.max`). Empty paragraphs are ignored.
- With `numbering`, a section number written in the heading's `format` is removed before names are compared.
- A checkbox property with `required: true` must be checked.
- Page objects hold at most 25 items of a `people`, `files`, `relation`, `title` or `rich_text` value. When a property the type (or a `where`) names may be cut short, the full value is read with the page property endpoint, so `min` and `max` are exact for any length.
- `where` is sent to Notion as a query filter when the data source's schema allows it: status / select / url / email / phone / title / rich_text / number / date `equals`, multi_select `contains`, checkbox `equals`, and people / relation `contains` (the value must be an ID). Conditions that cannot be translated (a property the data source lacks, a formula or rollup whose result type no sample page shows, a value of the wrong shape) are applied locally, and every condition is applied locally to the returned pages as well, so the filter only saves requests. People and relation conditions need an ID.
- `where` on formula, rollup and files properties:
  - **formula**: compared as its result. A number result equals the number, a boolean result takes `true` / `false`, and a string or date result equals the text (a date as `2026-12-01`). The server filter is `formula.number` / `formula.checkbox` / `formula.string` / `formula.date`. The schema does not give the result type, so up to 10 pages are read once per data source to see it; if they show none, the condition stays local.
  - **rollup**: a number or date result is compared like a number or date property (`rollup.number` / `rollup.date`). For an array, the page is in scope when some item equals the value (`rollup.any` with the item's own type filter; a title item is filtered as `rich_text`). Arrays of title, rich_text, url, email, phone_number, select, status, multi_select, number, checkbox and date items are sent to the server. An array of 25 items or more may be cut short, so it is not used to drop a page locally. `every` / `none` are not available. An incomplete rollup never matches.
  - **files**: `true` means the property has at least one file (`is_not_empty`) and `false` means it has none (`is_empty`). Text is a file name that must equal one of the files' names; the server only narrows it to non-empty properties.
- `dataSource` also takes a database ID or URL (`https://www.notion.so/<workspace>/<title>-<id>?v=<view>`, with or without dashes, a slug or a `?v=` view). The ID is first used as a data source ID, so a data source ID costs no extra request. If Notion says there is no such data source (404 / 400), it is read as a database: one data source is used, and with several the run exits with code 2 and lists each name and ID. Resolutions are cached for the run. A `?p=` row peek in the URL is ignored.
- `--page` (and a `page` target) also takes a database or data source. The ID is first read as a page, so a page costs no extra request. On 404 / 400 it is resolved like a `dataSource` target and every page of it is checked with the config's `type` (no `where`); several data sources exit with code 2 and list them. If nothing is readable, the error for the page is reported.

Section numbers (`numbering`):

```json
{ "numbering": { "format": { "h1": "{n}. {title}", "h2": "{n}.{n} {title}" }, "sequential": true } }
```

- Each heading at a level with a `format` is split into a number and a title. `{n}` is one part of the number; whitespace in a format matches any whitespace. Levels without a format are not checked. Headings inside toggles and other blocks count, in document order.
- `numbering.format`: the heading does not fit its level's format. The suggestion is the heading rewritten with the number it should have (`"2.5 Scope"`).
- `numbering.hierarchy`: the number does not continue its parent section (an H2 "4.1" under the H1 "3."), or a sub-section number such as "1.1" comes before any numbered parent.
- `numbering.sequence` (with `sequential`, the default): sibling sections must run 1, 2, 3 under each parent. A gap ("skips 2.3"), a repeat, or a number that goes back is reported once, and counting continues from the number written, so one mistake does not cascade.

References (`references`):

```json
{
  "references": {
    "patterns": ["see chapter {n}", "see section {n}", "{n} \"{title}\"", "see \"{title}\""],
    "notionLinks": true,
    "ignore": ["RFC 9110, see chapter", { "pattern": "chapter [0-9]+ of RFC [0-9]+" }]
  }
}
```

- `patterns` are searched in the text of paragraphs, list items, to-dos, toggles, quotes, callouts, and table cells (not code blocks or headings). A template matches case-insensitively. `{n}` is a section number whose parts are joined by `.` or by the separators the `numbering` formats use. A `{title}` between punctuation such as quotes takes the text up to the closing character; an unquoted `{title}` only matches titles of headings on the page, so it cannot report a missing heading. A regex pattern uses the named groups `n`, `title` and `page`. When several patterns match the same text, the first pattern wins, except that patterns with `{page}` are tried first.
- `{page}` names another page, for references such as `@Spec 3.2` (`"{page} {n}"` after a page mention), `仕様書の3章` (`"{page}の{n}章"`), or `section 3 of "Spec"` (`'section {n} of "{page}"'`). It is a page mention, or the title of a page checked in the same run, compared ignoring case and one pair of quotes or brackets around it. An unquoted `{page}` only matches mentions and checked page titles; a quoted one takes any text. When that page is checked (with a body), the number and title are matched against its headings with the same rules, and the message names the page (`"Spec 4": on the page "Spec", there is no section 4`). Nothing is fetched for it. When the page is not checked, nothing is matched (a mention is still checked for existence with `notionLinks`), and a title that several checked pages share is skipped, never guessed. An unquoted name of a page that is not checked is not recognised, so a shorter pattern such as `section {n}` may still match that text; quote the page name or use `ignore`.
- `references.number`: the section does not exist (`"see chapter 4": there is no section 4`). `references.mismatch`: number and title disagree (`"2.1 "Background"": 2.1 is "Purpose"; "Background" is 2.2`), with suggestions that fix either the number or the title. `references.title`: no heading has that title.
- Without `numbering`, a heading that starts with a number like "2.1 " or "2. " still counts as that section, so number references can be checked.
- `ignore`: a reference that overlaps an occurrence of an ignored string (case-sensitive) or a match of an ignored regex is skipped.
- `notionLinks`: a text link to a heading on the same page must read as that heading. Link text that starts with a section number must have the heading's current number (and title, if it has one); link text that is another heading's title is also stale. Other link text, such as "here", is not checked. A link to a block that is no longer on the page is reported. All of these are `references.link`. Mentions are not checked for text, since Notion keeps their text up to date.
- `notionLinks` also checks links to other pages: page mentions, links to pages or to blocks on them, and `link_to_page` blocks. Each target is retrieved once per run (`GET /v1/blocks/{id}`), and `references.target` is reported when it does not exist, cannot be read by the integration, or is in the trash. Other API errors stop the check (exit code 2). When the target page is also checked in the same run, it is not retrieved again: a text link to a block on it is matched against its headings, numbered by its own type (`references.link`, as for links on the same page). Page mentions and links to a page only need the page to exist.
- Every reference violation has the `blockId` of the block that holds the reference.

## `notion-lint agent`

Adds a short section on how to use notion-lint to the repository's agent instruction file, so agents pick it up.

```sh
notion-lint agent                           # add or refresh the section
notion-lint agent --dry-run                 # show a diff only
notion-lint agent --print                   # print the section to standard output only
notion-lint agent --remove                  # remove the section
notion-lint agent --target docs/AGENTS.md   # write to this file
notion-lint agent --create AGENTS.md        # create the file when none exists
```

- The root is the first Git root found walking up from the current directory (outside Git, the current directory). Files are matched case-insensitively: `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `.claude/CLAUDE.md`.
- One file found: that file. A file that imports another found file with an `@AGENTS.md` line is skipped, so the text is not loaded twice. Several files with no import: all of them. None: nothing is written and the exit code is 2.
- The section sits between `<!-- notion-lint:start -->` and `<!-- notion-lint:end -->` and contains the notion-lint version. Running again replaces only that range; everything outside it stays byte for byte the same.
- `--create` creates the file in the repository root, and only when no instruction file exists.

## Usage

```sh
# JSON Schema of the config (agents read this to build a type)
notion-lint schema
# JSON Schema of the --format json output
notion-lint schema result

# Load a config and print it as JSON (TS configs work too)
notion-lint print-config --config notion-lint.config.ts

# Ways to pass a config
notion-lint --config notion-lint.config.ts         # for people (executed)
echo '{"type":{"body":[{"heading":2,"title":"Purpose"}]}}' \
  | notion-lint --config - --page <URL or ID> --format json   # JSON on standard input
notion-lint --config-json '{"type":{...}}' --page <URL or ID>  # JSON in an argument
```

- JSON (standard input, `--config-json`, `.json` files) is never executed as code. Only `.ts` / `.mts` / `.js` / `.mjs` config files are executed.
- If no config is given, the first of `notion-lint.config.ts`, `.mts`, `.js`, `.mjs`, or `.json` found in the current directory is used.
- If a config does not match the schema, the exit code is 2 and the mismatched fields are returned as JSON. `check --format json` writes it to standard output; other cases write it to standard error.

```json
{
  "ok": false,
  "error": {
    "kind": "config",
    "message": "The config does not match the JSON Schema (1 issue(s)). Run notion-lint schema to see the schema",
    "source": "stdin",
    "issues": [
      {
        "path": "type.body[0].heading",
        "pointer": "/type/body/0/heading",
        "keyword": "enum",
        "message": "must be one of: 1, 2, 3",
        "params": { "allowedValues": [1, 2, 3] }
      }
    ]
  }
}
```

Exit codes: 0 means no violations, 1 means violations were found, and 2 means a config error, invalid arguments, or a Notion API error. With `--format github`, an exit-2 error is written to standard output as an `::error title=notion-lint error` annotation.

## Scheduled runs on GitHub Actions

[examples/github-actions/notion-lint.yml](examples/github-actions/notion-lint.yml) is a workflow that runs `notion-lint check --format github` on a `schedule` (cron) and on `workflow_dispatch`, with [a small config](examples/github-actions/notion-lint.config.json). Copy it to `.github/workflows/` in the repository that holds your config, and change the parts marked `CHANGE` (cron time, notion-lint version, config path). The example builds notion-lint from source; comments in it show how to switch to `npx notion-lint@0.1.0` after the first release.

- Create the repository secret `NOTION_TOKEN`. The workflow passes it as an environment variable; never write it in a file.
- With `--format github`, each violation is an annotation (`::error` or `::warning`) that ends with a Notion link: the block when the violation has one, otherwise the page. The workflow also writes the one-line result to the run's summary page.
- Exit code 0 passes the job. Exit code 1 (violations) and 2 (config error, invalid arguments, or Notion API error) both fail it, so GitHub's usual failed-workflow notification reports both. Violations appear as annotations. With `--format github`, exit code 2 is also an `::error` annotation titled `notion-lint error`: the message, the mismatched config fields, and, for a config file, `file=` set to that file. Its message names the page or data source when the error is about one. Other formats keep their own error output (text on standard error, JSON as described above). A comment in the workflow shows how to keep the job green when there are only violations.
- The example sits under `examples/`, so this repository's own CI does not run it (it has no Notion token). Its syntax was checked with actionlint.

## Config file

```ts
// notion-lint.config.ts
import { block, defineConfig, doc, h, prop } from "notion-lint";

const meetingNotes = doc({
  properties: {
    date: prop.date().required(),
    attendees: prop.people().min(1),
    ticket: prop.richText().pattern(/^[A-Z]+-\d+$/).optional(),
  },
  body: [h.h2("Purpose"), h.h2("Decisions", { children: block.list().min(1) })],
});

export default defineConfig({
  targets: [{ dataSource: "<data source ID>", type: meetingNotes }],
});
```

Builders only create data that can be written as JSON. The output of `print-config` matches the JSON you would write by hand. Regular expressions are stored as `{ "pattern": "...", "flags": "..." }` (for properties, as the `pattern` / `flags` fields). Japanese heading and property names are checked as written; see the meeting-notes example in [docs/design.md](docs/design.md). The shape of the config is described in [schema/notion-lint.schema.json](schema/notion-lint.schema.json).

## Development

Requires Node 22 or later and pnpm.

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check
pnpm check         # all three of the above (the tests also build and pack the package)
pnpm build         # outputs to dist/
pnpm dev schema    # run the CLI without building
```

- The source of truth for the config's JSON Schema is `src/schema/config.ts` (TypeBox). The TypeScript types are derived from it with `Static`.
- After changing `src/schema`, run `pnpm schema:write` to regenerate `schema/*.schema.json` (tests fail if they are stale).
