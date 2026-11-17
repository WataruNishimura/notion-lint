// The Japanese example from docs/design.md, as written there (plus the numbering / references imports).
import { block, defineConfig, doc, h, numbering, prop, references, text } from "notion-lint";

// Document type (meeting notes). Japanese headings and property names are checked as written.
const 議事録 = doc({
  properties: {
    日付: prop.date().required(),
    参加者: prop.people().min(1),
    種別: prop.select(["定例", "臨時"]),
    チケット: prop
      .richText()
      .pattern(/^[A-Z]+-\d+$/)
      .optional(),
  },
  // Skeleton of the body. The elements must appear in this order.
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

// A document with numbered chapters: also checks that chapter numbers and references to chapters in the body agree.
const 仕様書 = doc({
  body: [h.h1("概要"), h.h1("要件"), h.h1("設計")],
  numbering: numbering({
    // How headings are written. H1 is "1. Overview", H2 is "1.1 Background".
    format: { h1: "{n}. {title}", h2: "{n}.{n} {title}", h3: "{n}.{n}.{n} {title}" },
    sequential: true, // runs 1, 2, 3 without gaps or duplicates
  }),
  references: references({
    // Forms of references in the body (regular expressions are also allowed)
    patterns: ["{n}章", "{n}節", "{n}「{title}」", "「{title}」を参照"],
    notionLinks: true, // also checks the link text of links to blocks and the heading they point to
  }),
});

// A type can also be made from a template page
const 設計書 = doc.fromTemplate("<テンプレートページ ID>", {
  properties: { 状態: prop.status(["下書き", "レビュー中", "確定"]) },
});

export default defineConfig({
  // Which type applies to which pages
  targets: [
    { dataSource: "<議事録 DB のデータソース ID>", type: 議事録 },
    { dataSource: "<設計書 DB>", where: { 状態: "確定" }, type: 設計書 },
    { page: "<単体ページ ID>", type: 設計書 },
  ],
  // This type is checked one page at a time with --page
  type: 仕様書,
});
