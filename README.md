# notion-lint

A CLI that checks whether Notion pages match the document "types" written in `notion-lint.config.ts`: properties, heading structure, notation in the body, and templates.

See [docs/design.md](docs/design.md) for the design.

> Currently implemented: loading and validating the config, and the `schema` / `print-config` / `agent` commands. Fetching from the Notion API and matching (the body of `check`) are not implemented yet. `check` validates the config and then returns a `not_implemented` error (exit code 2).

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
