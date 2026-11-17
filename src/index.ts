/**
 * Public API, used by `notion-lint.config.ts`:
 *
 * ```ts
 * import { defineConfig, doc, prop, h, block, text, numbering, references } from "notion-lint";
 * ```
 */
export {
  BlockBuilder,
  type Buildable,
  block,
  type ConfigInput,
  DocBuilder,
  type DocInput,
  type DocTypeInput,
  defineConfig,
  doc,
  HeadingBuilder,
  type HeadingOptions,
  h,
  type Input,
  type NodeInput,
  numbering,
  prop,
  type ReferencesOptions,
  references,
  type TargetInput,
  type TextlintOptions,
  text,
} from "./builders/index.js";
export { type CheckDeps, check } from "./check/command.js";
export type {
  BlockItem,
  BodyItem,
  HeadingItem,
  PageModel,
  PropertyValue,
} from "./normalize/model.js";
export { createNotionApi, NOTION_VERSION, type NotionApi } from "./notion/api.js";
export {
  type FetcherOptions,
  NotionApiError,
  NotionFetcher,
  type PageFetcher,
  type RawBlockTree,
} from "./notion/fetch.js";
export {
  BLOCK_KINDS,
  type BlockKind,
  type BlockNode,
  type BodyNode,
  type Config,
  ConfigSchema,
  type DocType,
  HEADING_LEVELS,
  type HeadingLevel,
  type HeadingNode,
  type HeadingsRule,
  type NumberingRule,
  type PropertyType,
  type PropSpec,
  type ReferencesRule,
  type Target,
  type TemplateSource,
  type TextRule,
} from "./schema/config.js";
export type { Regex } from "./schema/helpers.js";
export {
  type CheckResult,
  type ErrorResult,
  ExitCode,
  exitCodeFor,
  type Note,
  type PageResult,
  type Result,
  ResultSchema,
  type Severity,
  type Suggestion,
  type Violation,
} from "./schema/result.js";
export {
  type ConfigIssue,
  configJsonSchema,
  resultJsonSchema,
  type ValidationResult,
  validateConfig,
} from "./schema/validate.js";
