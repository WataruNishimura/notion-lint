import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { TextlintKernel, type TextlintKernelRule } from "@textlint/kernel";
import { moduleInterop } from "@textlint/module-interop";
import markdownPlugin from "@textlint/textlint-plugin-markdown";
import type { BodyItem } from "../normalize/model.js";
import type { TextRule } from "../schema/config.js";
import type { Severity, Suggestion } from "../schema/result.js";
import { toMarkdown } from "./markdown.js";

/**
 * textlint integration for the body text (`text.textlint` in a type).
 *
 * `prepareTextlint` loads the presets, rules and prh dictionaries once per type, before any
 * page is fetched, so a missing package or file is a config error right away. `lintBody`
 * converts a page body to Markdown, runs the textlint kernel on it, and maps each message
 * back to the block it came from.
 */

/** A preset, rule, or dictionary that cannot be found: a config error (exit code 2). */
export class TextlintSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextlintSetupError";
  }
}

export interface TextFinding {
  blockId: string | null;
  /** `body` or `body > <heading> > <heading>`. */
  path: string;
  /** textlint's rule ID, e.g. `ja-technical-writing/ja-no-weak-phrase`. */
  rule: string;
  message: string;
  severity: Severity;
  suggestions: Suggestion[];
}

export interface PreparedTextlint {
  lintBody(body: BodyItem[]): Promise<TextFinding[]>;
}

type RuleOptions = Record<string, unknown>;

interface PresetModule {
  rules?: Record<string, unknown>;
  rulesConfig?: Record<string, boolean | RuleOptions>;
}

/** Severity given to rules whose options do not set one (see "Severity" in the README). */
const DEFAULT_SEVERITY = "warning";

const PRESET_PREFIX = "textlint-rule-preset-";
const RULE_PREFIX = "textlint-rule-";

/**
 * Load what a type's `text.textlint` asks for. `baseDir` is the directory of the config file
 * (the current directory for JSON configs). Packages are resolved from there first, then from
 * notion-lint's own dependencies, so the bundled presets work without installing them.
 * `configPath` is where the rule sits in the config (used in error messages).
 */
export function prepareTextlint(
  rule: NonNullable<TextRule["textlint"]>,
  baseDir: string,
  configPath: string,
): PreparedTextlint {
  const loader = new Loader(baseDir);
  const rules = new Map<string, TextlintKernelRule>();
  const overrides = rule.rules ?? {};

  for (const [i, name] of (rule.presets ?? []).entries()) {
    const moduleName = presetModuleName(name);
    const preset = loader.load<PresetModule>(
      moduleName,
      `${configPath}.presets[${i}]: textlint preset "${name}" is not installed`,
    );
    const shortName = name.replace(/^.*?textlint-rule-preset-/, "");
    for (const [ruleName, ruleModule] of Object.entries(preset.rules ?? {})) {
      const id = `${shortName}/${ruleName}`;
      const configured = preset.rulesConfig?.[ruleName] ?? true;
      if (configured === false) continue;
      rules.set(id, makeRule(id, moduleInterop(ruleModule) as never, configured));
    }
  }

  for (const [id, setting] of Object.entries(overrides)) {
    const existing = rules.get(id);
    if (setting === false) {
      rules.delete(id);
    } else if (existing !== undefined) {
      rules.set(id, { ...existing, options: withSeverity(setting === true ? {} : setting) });
    } else if (!id.includes("/") || id.startsWith("@")) {
      const ruleModule = loader.load<unknown>(
        ruleModuleName(id),
        `${configPath}.rules["${id}"]: textlint rule "${id}" is not installed`,
      );
      rules.set(id, makeRule(id, moduleInterop(ruleModule) as never, setting));
    } else {
      throw new TextlintSetupError(
        `${configPath}.rules["${id}"]: no rule "${id}" in the configured presets (presets: ${(rule.presets ?? []).join(", ") || "none"})`,
      );
    }
  }

  const rulePaths: string[] = [];
  for (const [i, dictionary] of (rule.prh ?? []).entries()) {
    const file = path.resolve(baseDir, dictionary);
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new TextlintSetupError(
        `${configPath}.prh[${i}]: prh dictionary not found: ${file} (paths are relative to ${baseDir})`,
      );
    }
    rulePaths.push(file);
  }
  if (rulePaths.length > 0) {
    const prh = loader.load<unknown>(
      "textlint-rule-prh",
      `${configPath}.prh: textlint-rule-prh is not installed`,
    );
    rules.set("prh", makeRule("prh", moduleInterop(prh) as never, { rulePaths }));
  }

  const kernelRules = [...rules.values()];
  const kernel = new TextlintKernel();
  return {
    async lintBody(body) {
      const doc = toMarkdown(body);
      if (doc.markdown.trim() === "" || kernelRules.length === 0) return [];
      const result = await kernel.lintText(doc.markdown, {
        ext: ".md",
        filePath: "page.md",
        plugins: [{ pluginId: "markdown", plugin: markdownPlugin }],
        rules: kernelRules,
      });
      return result.messages.map((message): TextFinding => {
        const source = doc.lines[message.line - 1];
        const headings = source?.headings ?? [];
        const suggestions: Suggestion[] = [];
        const fix = message.fix;
        if (fix !== undefined) {
          const [start, end] = fix.range;
          const original = doc.markdown.slice(start, end);
          suggestions.push({
            message:
              original === "" ? `insert "${fix.text}"` : `replace "${original}" with "${fix.text}"`,
            replacement: fix.text,
          });
        }
        return {
          blockId: source?.blockId ?? null,
          path: ["body", ...headings].join(" > "),
          rule: message.ruleId,
          message: `${message.message} (${message.ruleId})`,
          severity: message.severity === 2 ? "error" : "warning",
          suggestions,
        };
      });
    },
  };
}

function makeRule(
  ruleId: string,
  rule: TextlintKernelRule["rule"],
  setting: boolean | RuleOptions,
): TextlintKernelRule {
  return { ruleId, rule, options: withSeverity(setting) };
}

function withSeverity(options: boolean | RuleOptions): RuleOptions {
  const base = typeof options === "object" ? options : {};
  return { ...base, severity: base.severity ?? DEFAULT_SEVERITY };
}

/** `ja-technical-writing` -> `textlint-rule-preset-ja-technical-writing`; scoped names too. */
function presetModuleName(name: string): string {
  if (name.includes(PRESET_PREFIX)) return name;
  if (name.startsWith("@")) {
    const [scope, rest] = name.split("/", 2);
    return `${scope}/${PRESET_PREFIX}${rest}`;
  }
  return `${PRESET_PREFIX}${name}`;
}

/** `no-todo` -> `textlint-rule-no-todo`; `@scope/name` -> `@scope/textlint-rule-name`. */
function ruleModuleName(name: string): string {
  if (name.startsWith("@")) {
    const [scope, rest = ""] = name.split("/", 2);
    return rest.startsWith(RULE_PREFIX) ? name : `${scope}/${RULE_PREFIX}${rest}`;
  }
  return name.startsWith(RULE_PREFIX) ? name : `${RULE_PREFIX}${name}`;
}

/** Resolves packages from the config's directory, then from notion-lint's own dependencies. */
class Loader {
  private readonly requires: NodeJS.Require[];

  constructor(baseDir: string) {
    this.requires = [createRequire(path.join(baseDir, "noop.js")), createRequire(import.meta.url)];
  }

  load<T>(name: string, notFound: string): T {
    for (const req of this.requires) {
      let resolved: string;
      try {
        resolved = req.resolve(name);
      } catch {
        continue;
      }
      try {
        return req(resolved) as T;
      } catch (error) {
        throw new TextlintSetupError(
          `Cannot load ${name} (${resolved}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new TextlintSetupError(
      `${notFound}. Install ${name} in the project of the config file, or in notion-lint`,
    );
  }
}
