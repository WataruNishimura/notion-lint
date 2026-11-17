# notion-lint

A CLI that checks whether Notion pages match the document "types" written in `notion-lint.config.ts`: properties, heading structure, notation in the body, and templates.

See [docs/design.md](docs/design.md) for the design.

> Currently implemented: loading and validating the config, the `schema` / `print-config` / `agent` commands, and `check` with property and body (heading tree) matching. `doc.fromTemplate` (the body skeleton is built from a template page's headings). Section numbers and references (`numbering`, `references`) are not checked yet: `check` skips them and reports an info note (see below).

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
- `--format json` prints the shape in [schema/result.schema.json](schema/result.schema.json) (`notion-lint schema result`): for each page, violations with `pageId`, `blockId`, `path` in the type (`properties.<name>`, `body[1]`, `body[1].children[0]`), `rule`, `severity`, `message`, `suggestions`, and a Notion `url`. `notes` lists parts of a type that were skipped (`rule: "skipped"`, `path` such as `targets[0].type.numbering`); notes do not change `ok` or the exit code.
- A missing `NOTION_TOKEN` or a Notion API error exits with code 2 (`error.kind` is `api`). The token is never printed.

Body text with textlint (`text.textlint`):

- The body is converted to Markdown (headings, paragraphs, nested lists, to-dos, quotes, callouts; code, equations, tables and dividers are left out) and linted with the textlint kernel, with no shell command. Each message becomes a violation on its block: `blockId`, a `path` such as `body > <heading> > <sub-heading>` (`body` before the first heading), `rule` as textlint names it (`ja-technical-writing/ja-no-weak-phrase`, `prh`), and the message followed by the rule name. When textlint offers a fix, it is a suggestion with `replacement`.
- `presets` are resolved as `textlint-rule-preset-<name>`, `rules` as `textlint-rule-<name>` (a `<preset>/<rule>` key changes or, with `false`, switches off a preset rule), and `prh` dictionary paths relative to the config file (the current directory for JSON from `--config-json` or standard input). Packages are looked up from the config file's directory first, then in notion-lint's own dependencies; `textlint`, `textlint-rule-preset-ja-technical-writing` and `textlint-rule-prh` are installed with notion-lint. A preset, rule or dictionary that cannot be found exits with code 2 before any page is fetched.
- Severity: textlint findings are `warning` by default, as in the design example. A rule configured with `{ "severity": "error" }` reports `error`; textlint's `info` also maps to `warning`. Warnings still count as violations (exit code 1).
- Only the plain text of each block is converted, so inline code and link markup are not seen by textlint.

How the body is matched:

- The page's blocks form a heading tree: blocks under a heading, up to the next heading of the same or a higher level, are its children. Synced blocks and columns are transparent; child pages are not part of the body.
- The type's `body` headings are mapped in order to the page's headings by name (exact text, or `{ "pattern": ... }`). Rules: `body.missing`, `body.order` (the longest in-order run is kept, the rest are reported), `body.level`, and `body.extra` when `headings.allowExtra` is false (at the top level, and under headings whose `children` are given). `headings.noSkipLevel` reports `headings.skipLevel`.
- Block entries such as `{ "block": "list", "min": 1 }` are matched in order against the blocks before the first sub-heading at that level; each takes the next run of consecutive blocks of its kind (`body.min`, `body.max`). Empty paragraphs are ignored.
- With `numbering`, a section number written in the heading's `format` is removed before names are compared. The numbers themselves are not checked yet.
- A checkbox property with `required: true` must be checked. People, files, and relation lists longer than 25 are truncated by the API, so `min` is not reported for them.

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

Exit codes: 0 means no violations, 1 means violations were found, and 2 means a config error, invalid arguments, or a Notion API error.

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
pnpm check         # all three of the above
pnpm build         # outputs to dist/
pnpm dev schema    # run the CLI without building
```

- The source of truth for the config's JSON Schema is `src/schema/config.ts` (TypeBox). The TypeScript types are derived from it with `Static`.
- After changing `src/schema`, run `pnpm schema:write` to regenerate `schema/*.schema.json` (tests fail if they are stale).
