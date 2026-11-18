# Changelog

All notable changes to notion-lint are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

To add an entry: put it under `## Unreleased` while a change is in review. On release, rename that
heading to the version and date, and add a new empty `## Unreleased` above it. The release
workflow copies the section whose heading starts with the tag's version into the GitHub release.

## Unreleased

### Added

- `where` on formula, rollup and files properties, sent to Notion as a query filter where the
  result type is known and always checked locally too.
- `dataSource` accepts a database ID or URL. A database with one data source is resolved; with
  several, the run exits with code 2 and lists their names and IDs. `--page` does the same for an
  ID that is not a page: every page of the database or data source is checked.
- `{page}` in `references.patterns`: text references that name another page, such as a page
  mention followed by a section number (`@Spec 3.2`) or `仕様書の3章`, are matched against the
  headings of that page when it is checked in the same run.
- textlint runs on table cells (reported on the row block, with the row and column) and on
  formatted text: bold, italic and link text are linted; inline code, equations, mentions and
  URLs are not.

## 0.1.0 - 2026-11-18

First release.

### Added

- Config: `notion-lint.config.ts` (and `.mts`, `.js`, `.mjs`, `.json`), JSON on standard input
  (`--config -`) or as an argument (`--config-json`), validated against a JSON Schema. Builders
  `doc`, `prop`, `h`, `block`, and `text` create the document types (#1).
- Commands `schema` (JSON Schema of the config or of the `--format json` result) and
  `print-config` (#1).
- `notion-lint agent`: writes how to use notion-lint into the repository's agent instruction file
  (`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `.claude/CLAUDE.md`) between marker comments (#3).
- `notion-lint check` (#4):
  - Fetches pages from the Notion API (`NOTION_TOKEN`), by `--page` or by the `targets` in the
    config (a page, or a data source with conditions), with pagination and rate limiting.
  - Matches properties (type, required, options, ranges, patterns) and the body (heading tree,
    block types, order, `allowExtra`).
  - Output as text for people, JSON (`--format json`) with structured fix suggestions, or GitHub
    Actions annotations (`--format github`). Exit codes: 0 no violations, 1 violations, 2 config,
    argument, or Notion API error.
- `doc.fromTemplate`: the body skeleton is built from the headings of a template page (#5).
- textlint integration for body text, with presets such as `ja-technical-writing` and prh
  dictionaries (#6).
- Section numbers and references: `numbering` and `references` checks (#7).
- Cross-page reference checks: links to other pages or blocks are checked against the headings of
  the other checked pages (#8).
- An example workflow that runs notion-lint on a schedule with GitHub Actions
  (`examples/github-actions/`) (#9).
- Server-side `where` filters built from the data source schema, and full values of long
  properties (people, files, relation, title, rich_text) (#10).
- Config and Notion API errors (exit code 2) are reported as `::error` annotations with
  `--format github`.
- npm package metadata, an MIT license, and a release workflow (publish with provenance).

Features of the pull requests that are still open when 0.1.0 is cut (`fetch-extras` and
`text-extras`) will be added to this entry when they merge.
