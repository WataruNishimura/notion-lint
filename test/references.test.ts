import { describe, expect, it } from "vitest";
import { notionLinks, notionTarget } from "../src/normalize/index.js";
import type { BodyItem, NotionLink, PageModel } from "../src/normalize/model.js";
import type { NumberingRule, ReferencesRule } from "../src/schema/config.js";
import { checkReferences, compileTemplate, outsideLinks } from "../src/validate/references.js";

const PAGE = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const h = (level: number, text: string, children: BodyItem[] = []): BodyItem => ({
  kind: "heading",
  id: id(),
  level,
  text,
  children,
});
const p = (text: string, links?: NotionLink[], type = "paragraph"): BodyItem => ({
  kind: "block",
  id: id(),
  type,
  text,
  children: [],
  ...(links === undefined ? {} : { links }),
});

const numbering: NumberingRule = { format: { h1: "{n}. {title}", h2: "{n}.{n} {title}" } };

const page = (body: BodyItem[]): PageModel => ({
  id: PAGE,
  url: "https://www.notion.so/Spec-11111111222243338444555555555555",
  title: "Spec",
  properties: {},
  body,
});

const headings = () => {
  const purpose = h(2, "2.1 Purpose");
  const background = h(2, "2.2 Background");
  const body = [
    h(1, "1. Overview"),
    h(1, "2. Requirements", [purpose, background]),
    h(1, "3. Design"),
  ];
  return { body, purpose, background };
};

const check = (rule: ReferencesRule, text: string, type = "paragraph") => {
  const block = p(text, undefined, type);
  const { body } = headings();
  return checkReferences(rule, numbering, page([...body, block])).map((f) => {
    expect(f.blockId).toBe(block.id);
    return [f.rule, f.message, f.suggestions.map((s) => s.replacement ?? s.message)];
  });
};

describe("compileTemplate", () => {
  it("turns {n} and a quoted {title} into named groups", () => {
    const regex = compileTemplate('see {n} "{title}"', [], "\\d+(?:\\.\\d+)*");
    const match = regex.exec('Please See 2.1  "Background" first');
    expect(match?.groups).toEqual({ n: "2.1", title: "Background" });
  });

  it("matches an unquoted {title} only against the page's headings", () => {
    const regex = compileTemplate("see {title}", ["Background", "Design"], "\\d+");
    expect(
      [..."see Background, see Design notes, see Backgrounds".matchAll(regex)].map((m) => m[0]),
    ).toEqual(["see Background", "see Design"]);
  });
});

describe("checkReferences", () => {
  const sections: ReferencesRule = { patterns: ["see chapter {n}", "see section {n}"] };
  const titled: ReferencesRule = { patterns: ['{n} "{title}"', 'see "{title}"'] };

  it("accepts references to sections and headings that exist", () => {
    expect(check(sections, "See chapter 3 and see section 2.2.")).toEqual([]);
    expect(check(titled, 'As 2.1 "Purpose" says; see "Design" and see "2.2 Background".')).toEqual(
      [],
    );
  });

  it("reports a section number that does not exist", () => {
    expect(check(sections, "see chapter 4, see section 2.3")).toEqual([
      ["references.number", '"see chapter 4": there is no section 4', []],
      ["references.number", '"see section 2.3": there is no section 2.3', []],
    ]);
  });

  it("reports a number and a title that disagree, with the fix", () => {
    expect(check(titled, '2.1 "Background" describes this')).toEqual([
      [
        "references.mismatch",
        '"2.1 "Background"": 2.1 is "Purpose"; "Background" is 2.2',
        ['2.2 "Background"', '2.1 "Purpose"'],
      ],
    ]);
    expect(check(titled, '2.1 "Context" describes this')).toEqual([
      [
        "references.mismatch",
        '"2.1 "Context"": 2.1 is "Purpose"; there is no heading "Context"',
        ['2.1 "Purpose"'],
      ],
    ]);
    expect(check(titled, '4.1 "Background" and 4.2 "Context"')).toEqual([
      [
        "references.number",
        '"4.1 "Background"": there is no section 4.1; "Background" is 2.2',
        ['2.2 "Background"'],
      ],
      [
        "references.number",
        '"4.2 "Context"": there is no section 4.2 and no heading "Context"',
        [],
      ],
    ]);
  });

  it("reports a title-only reference to a heading that does not exist", () => {
    expect(check(titled, 'see "Context" and see "background"')).toEqual([
      ["references.title", '"see "Context"": there is no heading "Context"', []],
      [
        "references.title",
        '"see "background"": there is no heading "background"',
        ['see "Background"'],
      ],
    ]);
  });

  it("searches list items, callouts, and table cells, but not code", () => {
    expect(check(sections, "see chapter 9", "bulleted_list_item")).toHaveLength(1);
    expect(check(sections, "see chapter 9", "callout")).toHaveLength(1);
    expect(check(sections, "a\nsee chapter 9", "table_row")).toHaveLength(1);
    expect(check(sections, "see chapter 9", "code")).toEqual([]);
  });

  it("accepts regex patterns with named groups", () => {
    const rule: ReferencesRule = { patterns: [{ pattern: "第(?<n>\\d+)章を参照" }] };
    expect(check(rule, "第3章を参照。第5章を参照。")).toEqual([
      ["references.number", '"第5章を参照": there is no section 5', []],
    ]);
  });

  it("skips matches that overlap ignored words or ranges", () => {
    const rule: ReferencesRule = {
      patterns: ["see chapter {n}"],
      ignore: ["RFC 9110, see chapter", { pattern: "\\(ISO [^)]*\\)" }],
    };
    expect(
      check(rule, "RFC 9110, see chapter 15. (ISO 9001 see chapter 8) But see chapter 7."),
    ).toEqual([["references.number", '"see chapter 7": there is no section 7', []]]);
  });

  it("reads leading numbers of headings when there is no numbering rule", () => {
    const body = [h(1, "1 Overview"), h(2, "1.1 Scope"), p("see section 1.1, see section 1.2")];
    const findings = checkReferences({ patterns: ["see section {n}"] }, undefined, page(body));
    expect(findings.map((f) => f.message)).toEqual(['"see section 1.2": there is no section 1.2']);
    expect(findings[0]?.path).toBe("references.patterns[0]");
  });
});

describe("notionLinks", () => {
  const rule: ReferencesRule = { patterns: ["see section {n}"], notionLinks: true };
  const link = (text: string, blockId: string | null, pageId = PAGE): NotionLink => ({
    kind: "link",
    text,
    pageId,
    blockId,
  });

  it("accepts links whose text names the linked heading", () => {
    const { body, purpose, background } = headings();
    const block = p("x", [
      link("2.1 Purpose", purpose.id),
      link("Background", background.id),
      link("2.2", background.id),
      link("here", purpose.id),
      link("this page", null),
    ]);
    expect(checkReferences(rule, numbering, page([...body, block]))).toEqual([]);
  });

  it("reports stale link text, and links to blocks that are gone", () => {
    const { body, purpose, background } = headings();
    const block = p("x", [
      link("2.1 Background", background.id),
      link("Purpose", background.id),
      link("1.1 Purpose", purpose.id),
      link("2.4 Gone", "00000000-0000-4000-8000-999999999999"),
    ]);
    const findings = checkReferences(rule, numbering, page([...body, block]));
    expect(findings.map((f) => [f.rule, f.path, f.message, f.suggestions[0]?.replacement])).toEqual(
      [
        [
          "references.link",
          "references.notionLinks",
          'link "2.1 Background" points to the heading "2.2 Background"',
          "2.2 Background",
        ],
        [
          "references.link",
          "references.notionLinks",
          'link "Purpose" points to the heading "2.2 Background"',
          "2.2 Background",
        ],
        [
          "references.link",
          "references.notionLinks",
          'link "1.1 Purpose" points to the heading "2.1 Purpose"',
          "2.1 Purpose",
        ],
        [
          "references.link",
          "references.notionLinks",
          'link "2.4 Gone" points to a block that is no longer on this page',
          undefined,
        ],
      ],
    );
    expect(findings.every((f) => f.blockId === block.id)).toBe(true);
  });

  it("does not check links when notionLinks is off", () => {
    const { body, background } = headings();
    const block = p("x", [link("1.1 Old", background.id), link("Other", null, OTHER)]);
    const off = { patterns: rule.patterns };
    expect(checkReferences(off, numbering, page([...body, block]))).toEqual([]);
    expect(outsideLinks(off, page([...body, block]))).toEqual([]);
    expect(outsideLinks(rule, page([...body, block])).map((l) => l.link.pageId)).toEqual([OTHER]);
  });
});

describe("Notion links in rich text", () => {
  it("reads page and block IDs from Notion URLs", () => {
    expect(
      notionTarget("/2a1f7c3e5b6d8011a001000000000001#3b9c0d1e2f3a8000b000000000000002"),
    ).toEqual({
      pageId: "2a1f7c3e-5b6d-8011-a001-000000000001",
      blockId: "3b9c0d1e-2f3a-8000-b000-000000000002",
    });
    expect(
      notionTarget("https://www.notion.so/team/Spec-2a1f7c3e5b6d8011a001000000000001"),
    ).toEqual({
      pageId: "2a1f7c3e-5b6d-8011-a001-000000000001",
      blockId: null,
    });
    expect(notionTarget("https://example.com/2a1f7c3e5b6d8011a001000000000001")).toBeUndefined();
  });

  it("joins a link split by formatting, and reads page mentions", () => {
    const url = "/2a1f7c3e5b6d8011a001000000000001#3b9c0d1e2f3a8000b000000000000002";
    const richText = [
      { type: "text", plain_text: "2.1 ", text: { content: "2.1 ", link: { url } }, href: url },
      {
        type: "text",
        plain_text: "Purpose",
        text: { content: "Purpose", link: { url } },
        href: url,
      },
      { type: "text", plain_text: " and ", text: { content: " and ", link: null }, href: null },
      {
        type: "mention",
        plain_text: "Other page",
        mention: { type: "page", page: { id: "99999999-2222-4333-8444-555555555555" } },
        href: "https://www.notion.so/99999999222243338444555555555555",
      },
      {
        type: "text",
        plain_text: "web",
        text: { content: "web", link: { url: "https://example.com" } },
        href: "https://example.com",
      },
    ];
    expect(notionLinks(richText)).toEqual([
      {
        kind: "link",
        text: "2.1 Purpose",
        pageId: "2a1f7c3e-5b6d-8011-a001-000000000001",
        blockId: "3b9c0d1e-2f3a-8000-b000-000000000002",
      },
      { kind: "mention", text: "Other page", pageId: OTHER, blockId: null },
    ]);
  });
});
