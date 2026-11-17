import type { BlockItem, BodyItem, HeadingItem } from "../normalize/model.js";
import { joinPath } from "../path.js";
import type {
  BlockKind,
  BlockNode,
  BodyNode,
  HeadingNode,
  HeadingsRule,
  NumberingRule,
} from "../schema/config.js";
import type { Regex } from "../schema/helpers.js";
import type { Finding } from "./finding.js";

/**
 * Match the type's `body` skeleton against the page's heading tree.
 *
 * At each level (the page's top level, or the children of a matched heading or block):
 * - Skeleton headings are mapped, in order, to the page's headings by name (exact text, or a
 *   regex). Each name takes the first page heading that matches and is not taken yet.
 * - Headings that are not found are `body.missing` (unless `optional`). Headings that are
 *   found but not in the skeleton's order are `body.order`: the largest set of headings
 *   that is in order is kept, preferring earlier skeleton entries, and the rest are reported.
 * - Page headings that the skeleton does not name are `body.extra` when
 *   `headings.allowExtra` is false. This applies to the top level, and under a heading or
 *   block only when the skeleton gives its `children`.
 * - Block entries (`{ block: "list", min: 1 }`) are matched, in order, against the blocks
 *   that come before the first heading at that level (for a heading's children: the blocks
 *   directly under it, before any sub-heading). Each entry takes the next run of consecutive
 *   blocks of its kind. Empty paragraphs are ignored.
 */
export function checkBody(
  body: BodyNode[] | undefined,
  items: BodyItem[],
  headings: HeadingsRule | undefined,
  numbering: NumberingRule | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const ctx: Context = {
    allowExtra: headings?.allowExtra ?? true,
    titleOf: titleReader(numbering),
    findings,
  };
  if (body !== undefined) matchList(ctx, body, items, "body", { label: "at the top of the page" });
  if (headings?.noSkipLevel === true) checkSkipLevel(items, findings);
  return findings;
}

interface Context {
  allowExtra: boolean;
  titleOf: (heading: HeadingItem) => string;
  findings: Finding[];
}

/** Where a list of items lives, for messages and links. */
interface Owner {
  /** e.g. `under "Decisions"` */
  label: string;
  blockId?: string;
}

function matchList(
  ctx: Context,
  nodes: BodyNode[],
  items: BodyItem[],
  basePath: string,
  owner: Owner,
): void {
  matchHeadings(ctx, nodes, items, basePath);
  matchBlocks(ctx, nodes, items, basePath, owner);
}

// ---------------------------------------------------------------------------
// headings

function matchHeadings(ctx: Context, nodes: BodyNode[], items: BodyItem[], basePath: string): void {
  const pageHeadings = items.filter((item): item is HeadingItem => item.kind === "heading");
  const taken = new Set<HeadingItem>();

  // skeleton heading -> page heading (first untaken match in page order)
  const entries: { index: number; node: HeadingNode; item: HeadingItem | undefined }[] = [];
  nodes.forEach((node, index) => {
    if (!("heading" in node)) return;
    const item = pageHeadings.find(
      (h) => !taken.has(h) && titleMatches(node.title, ctx.titleOf(h)),
    );
    if (item !== undefined) taken.add(item);
    entries.push({ index, node, item });
  });

  const found = entries.filter((e) => e.item !== undefined);
  const inOrder = longestInOrder(found.map((e) => pageHeadings.indexOf(e.item as HeadingItem)));
  const kept = new Set(inOrder.map((i) => found[i]));

  entries.forEach((entry, i) => {
    const path = joinPath(basePath, entry.index);
    const name = describeTitle(entry.node.title);
    const { item, node } = entry;
    if (item === undefined) {
      if (node.optional === true) return;
      const before = entries.slice(0, i).findLast((e) => e.item !== undefined);
      const after = entries.slice(i + 1).find((e) => e.item !== undefined);
      const where =
        before !== undefined
          ? `after "${(before.item as HeadingItem).text}"`
          : after !== undefined
            ? `before "${(after.item as HeadingItem).text}"`
            : undefined;
      const title = typeof node.title === "string" ? node.title : undefined;
      ctx.findings.push({
        path,
        rule: "body.missing",
        message: `heading ${name} is missing${where === undefined ? "" : ` (required ${where})`}`,
        suggestions: [
          {
            message: `Add an H${node.heading} heading ${name}${where === undefined ? "" : ` ${where}`}`,
            ...(title === undefined ? {} : { replacement: title }),
          },
        ],
        blockId: null,
        ...(before?.item === undefined ? {} : { nearBlockId: before.item.id }),
      });
      return;
    }

    if (!kept.has(entry)) {
      const before = entries.slice(0, i).findLast((e) => kept.has(e));
      const after = entries.slice(i + 1).find((e) => kept.has(e));
      // Some other entry is always kept, since the kept set is a longest in-order one.
      const anchor = (before ?? after)?.item as HeadingItem;
      const where = `${before !== undefined ? "after" : "before"} "${anchor.text}"`;
      ctx.findings.push({
        path,
        rule: "body.order",
        message: `heading "${item.text}" is out of order (the type puts it ${where})`,
        suggestions: [{ message: `Move "${item.text}" ${where}` }],
        blockId: item.id,
      });
    }

    if (item.level !== node.heading) {
      ctx.findings.push({
        path,
        rule: "body.level",
        message: `heading "${item.text}" is H${item.level}; the type expects H${node.heading}`,
        suggestions: [{ message: `Change "${item.text}" to an H${node.heading} heading` }],
        blockId: item.id,
      });
    }

    if (node.children !== undefined) {
      matchList(ctx, node.children, item.children, joinPath(path, "children"), {
        label: `under "${item.text}"`,
        blockId: item.id,
      });
    }
  });

  if (!ctx.allowExtra) {
    for (const heading of pageHeadings) {
      if (taken.has(heading)) continue;
      ctx.findings.push({
        path: basePath,
        rule: "body.extra",
        message: `heading "${heading.text}" is not in the type`,
        suggestions: [
          { message: `Remove "${heading.text}", or rename it to a heading the type names` },
        ],
        blockId: heading.id,
      });
    }
  }
}

/**
 * Indexes (into `positions`) of a longest strictly increasing subsequence. Among equally
 * long ones, earlier entries are preferred.
 */
export function longestInOrder(positions: number[]): number[] {
  const length: number[] = [];
  const previous: number[] = [];
  positions.forEach((pos, i) => {
    length[i] = 1;
    previous[i] = -1;
    for (let j = 0; j < i; j++) {
      if ((positions[j] as number) < pos && (length[j] as number) + 1 > (length[i] as number)) {
        length[i] = (length[j] as number) + 1;
        previous[i] = j;
      }
    }
  });
  let end = -1;
  length.forEach((len, i) => {
    if (end === -1 || len > (length[end] as number)) end = i;
  });
  const out: number[] = [];
  for (let i = end; i !== -1; i = previous[i] as number) out.unshift(i);
  return out;
}

function titleMatches(title: string | Regex, text: string): boolean {
  if (typeof title === "string") return title.trim() === text;
  return new RegExp(title.pattern, title.flags).test(text);
}

function describeTitle(title: string | Regex): string {
  return typeof title === "string" ? `"${title}"` : `/${title.pattern}/${title.flags ?? ""}`;
}

/**
 * The heading text that skeleton titles are compared with. When the type has `numbering`,
 * a section number written in the heading's format is removed first ("1.2 Background" ->
 * "Background"). Checking the numbers themselves is not implemented yet.
 */
function titleReader(numbering: NumberingRule | undefined): (heading: HeadingItem) => string {
  const formats = new Map<number, RegExp>();
  for (const [key, format] of Object.entries(numbering?.format ?? {})) {
    if (format === undefined) continue;
    const escaped = format.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const source = escaped.replace(/\\\{n\\\}/g, "\\d+").replace(/\\\{title\\\}/, "(?<title>.+)");
    formats.set(Number(key.slice(1)), new RegExp(`^${source}$`, "u"));
  }
  return (heading) => {
    const title = formats.get(heading.level)?.exec(heading.text)?.groups?.title;
    return (title ?? heading.text).trim();
  };
}

// ---------------------------------------------------------------------------
// blocks

const KIND_LABELS: Record<BlockKind, string> = {
  any: "block",
  paragraph: "paragraph",
  list: "list item",
  bulleted_list_item: "bulleted list item",
  numbered_list_item: "numbered list item",
  to_do: "to-do",
  toggle: "toggle",
  quote: "quote",
  callout: "callout",
  code: "code block",
  table: "table",
  image: "image",
  divider: "divider",
};

function kindMatches(kind: BlockKind, type: string): boolean {
  if (kind === "any") return true;
  if (kind === "list") return type === "bulleted_list_item" || type === "numbered_list_item";
  return kind === type;
}

function isBlank(item: BlockItem): boolean {
  return item.type === "paragraph" && item.text === "" && item.children.length === 0;
}

function plural(n: number, label: string): string {
  return n === 1 ? `1 ${label}` : `${n} ${label}s`;
}

function matchBlocks(
  ctx: Context,
  nodes: BodyNode[],
  items: BodyItem[],
  basePath: string,
  owner: Owner,
): void {
  const firstHeading = items.findIndex((item) => item.kind === "heading");
  const leading = (firstHeading === -1 ? items : items.slice(0, firstHeading)).filter(
    (item): item is BlockItem => item.kind === "block" && !isBlank(item),
  );

  let cursor = 0;
  nodes.forEach((node, index) => {
    if (!("block" in node)) return;
    const path = joinPath(basePath, index);
    const run = nextRun(leading, cursor, node);
    if (run.length > 0) cursor = leading.indexOf(run[0] as BlockItem) + run.length;
    checkCount(ctx, node, run, path, owner);
    if (node.children !== undefined) {
      for (const block of run) {
        matchList(ctx, node.children, block.children, joinPath(path, "children"), {
          label: `inside the ${block.type.replace(/_/g, " ")}${block.text === "" ? "" : ` "${block.text}"`}`,
          blockId: block.id,
        });
      }
    }
  });
}

/** The first run of consecutive blocks of the node's kind at or after `cursor`. */
function nextRun(blocks: BlockItem[], cursor: number, node: BlockNode): BlockItem[] {
  const start = blocks.findIndex((b, i) => i >= cursor && kindMatches(node.block, b.type));
  if (start === -1) return [];
  let end = start;
  while (end < blocks.length && kindMatches(node.block, (blocks[end] as BlockItem).type)) end++;
  return blocks.slice(start, end);
}

function checkCount(
  ctx: Context,
  node: BlockNode,
  run: BlockItem[],
  path: string,
  owner: Owner,
): void {
  const label = KIND_LABELS[node.block];
  const min = node.min ?? 1;
  if (run.length < min) {
    ctx.findings.push({
      path,
      rule: "body.min",
      message: `needs at least ${plural(min, label)} ${owner.label} (${run.length} found)`,
      suggestions: [{ message: `Add ${plural(min - run.length, label)} ${owner.label}` }],
      blockId: run[0]?.id ?? null,
      ...(owner.blockId === undefined ? {} : { nearBlockId: owner.blockId }),
    });
  }
  if (node.max !== undefined && run.length > node.max) {
    ctx.findings.push({
      path,
      rule: "body.max",
      message: `allows at most ${plural(node.max, label)} ${owner.label} (${run.length} found)`,
      suggestions: [],
      blockId: run[0]?.id ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// headings.noSkipLevel

function checkSkipLevel(items: BodyItem[], findings: Finding[]): void {
  let previous: HeadingItem | undefined;
  const visit = (list: BodyItem[]) => {
    for (const item of list) {
      if (item.kind === "heading") {
        if (previous !== undefined && item.level > previous.level + 1) {
          findings.push({
            path: "headings.noSkipLevel",
            rule: "headings.skipLevel",
            message: `H${item.level} "${item.text}" follows H${previous.level} "${previous.text}" (skips H${previous.level + 1})`,
            suggestions: [
              { message: `Change "${item.text}" to an H${previous.level + 1} heading` },
            ],
            blockId: item.id,
          });
        }
        previous = item;
      }
      visit(item.children);
    }
  };
  visit(items);
}
