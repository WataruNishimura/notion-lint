import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ExitCode } from "../schema/result.js";
import { VERSION } from "../version.js";
import { chooseTargets, findInstructionFiles, findRoot } from "./detect.js";
import { unifiedDiff } from "./diff.js";
import { removeSection, renderSection, upsertSection } from "./section.js";

export interface AgentIo {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
}

class UsageError extends Error {}

function fail(io: AgentIo, message: string): ExitCode {
  io.stderr(`${JSON.stringify({ ok: false, error: { kind: "usage", message } }, null, 2)}\n`);
  return ExitCode.Error;
}

const display = (io: AgentIo, file: string): string =>
  (path.relative(io.cwd, file) || file).split(path.sep).join("/");

/** `notion-lint agent`: add, refresh, or remove the notion-lint section in agent instruction files. */
export function agentCommand(args: string[], io: AgentIo): ExitCode {
  let values: {
    target?: string | undefined;
    create?: string | undefined;
    "dry-run"?: boolean | undefined;
    print?: boolean | undefined;
    remove?: boolean | undefined;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        target: { type: "string" },
        create: { type: "string" },
        "dry-run": { type: "boolean" },
        print: { type: "boolean" },
        remove: { type: "boolean" },
      },
      strict: true,
    }));
    if (values.print && (values.remove || values["dry-run"] || values.target || values.create)) {
      throw new UsageError("--print cannot be combined with other options");
    }
    if (values.remove && values.create !== undefined) {
      throw new UsageError("--remove and --create cannot be used together");
    }
  } catch (error) {
    return fail(io, (error as Error).message);
  }

  if (values.print) {
    io.stdout(`${renderSection("\n", VERSION)}\n`);
    return ExitCode.Ok;
  }

  const root = findRoot(io.cwd);
  let targets: string[];
  if (values.target !== undefined) {
    const file = path.resolve(io.cwd, values.target);
    if (!existsSync(file)) return fail(io, `--target file does not exist: ${values.target}`);
    targets = [file];
  } else {
    targets = chooseTargets(findInstructionFiles(root));
  }

  let created: string | undefined;
  if (targets.length === 0) {
    if (values.remove) {
      io.stdout("No agent instruction file found; nothing to remove.\n");
      return ExitCode.Ok;
    }
    if (values.create === undefined) {
      return fail(
        io,
        `No agent instruction file (AGENTS.md, AGENT.md, CLAUDE.md, .claude/CLAUDE.md) found in ${root}. Nothing was written. Create one with: notion-lint agent --create AGENTS.md`,
      );
    }
    created = path.resolve(root, values.create);
    targets = [created];
  }

  const dryRun = values["dry-run"] === true;
  // Compute everything first so that an error in one file writes nothing at all.
  const plans: { file: string; before: string; after: string }[] = [];
  for (const file of targets) {
    const before = file === created ? "" : readFileSync(file, "utf8");
    const after = values.remove ? removeSection(before) : upsertSection(before);
    if (after instanceof Error) return fail(io, `${display(io, file)}: ${after.message}`);
    plans.push({ file, before, after });
  }

  for (const { file, before, after } of plans) {
    const name = display(io, file);
    if (dryRun) {
      const diff = unifiedDiff(name, before, after);
      io.stdout(diff === "" ? `unchanged: ${name}\n` : diff);
      continue;
    }
    if (before === after && file !== created) {
      io.stdout(`unchanged: ${name}\n`);
      continue;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, after, "utf8");
    const verb = values.remove ? "removed section from" : file === created ? "created" : "updated";
    io.stdout(`${verb}: ${name}\n`);
  }
  return ExitCode.Ok;
}
