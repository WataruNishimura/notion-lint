// The example from docs/design.md, as written there (plus the numbering / references imports).
import { block, defineConfig, doc, h, numbering, prop, references, text } from "notion-lint";

// 文書の型
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
  // 本文の骨格。上から順に並ぶことを要求する
  body: [
    h.h2("目的"),
    h.h2("決定事項", {
      children: block.list().min(1), // 見出しの下に箇条書きが 1 つ以上
    }),
    h.h2("TODO", { children: block.todo() }),
    h.h2("メモ").optional(),
  ],
  headings: { noSkipLevel: true, allowExtra: true }, // 型にない見出しを許すか
  text: text.textlint({ preset: "ja-technical-writing", prh: "./prh.yml" }),
});

// 章立てのある文書: 章番号と、本文中の章への参照が一致しているかも見る
const 仕様書 = doc({
  body: [h.h1("概要"), h.h1("要件"), h.h1("設計")],
  numbering: numbering({
    // 見出しの書き方。H1 は「1. 概要」、H2 は「1.1 背景」
    format: { h1: "{n}. {title}", h2: "{n}.{n} {title}", h3: "{n}.{n}.{n} {title}" },
    sequential: true, // 1, 2, 3 と抜けや重複なく続く
  }),
  references: references({
    // 本文中の参照の書き方 (正規表現も可)
    patterns: ["{n}章", "{n}節", "{n}「{title}」", "「{title}」を参照"],
    notionLinks: true, // ブロックへのリンクの文字列とリンク先の見出しも照合する
  }),
});

// テンプレートページから型を作ることもできる
const 設計書 = doc.fromTemplate("<テンプレートページ ID>", {
  properties: { 状態: prop.status(["下書き", "レビュー中", "確定"]) },
});

export default defineConfig({
  // どのページにどの型を当てるか
  targets: [
    { dataSource: "<議事録 DB のデータソース ID>", type: 議事録 },
    { dataSource: "<設計書 DB>", where: { 状態: "確定" }, type: 設計書 },
    { page: "<単体ページ ID>", type: 設計書 },
  ],
  // 仕様書は --page で 1 ページずつ検査する
  type: 仕様書,
});
