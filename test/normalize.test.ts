import { describe, expect, it } from "vitest";
import { normalizePage } from "../src/normalize/index.js";
import type { BodyItem } from "../src/normalize/model.js";
import { meetingNotes, replayFetcher } from "./notion-fake.js";

/** A compact view of a heading tree: headings as `H2 title`, blocks as `type: text`. */
function outline(items: BodyItem[]): unknown[] {
  return items.map((item) => {
    const label =
      item.kind === "heading" ? `H${item.level} ${item.text}` : `${item.type}: ${item.text}`;
    return item.children.length === 0 ? label : [label, outline(item.children)];
  });
}

async function loadPage(id: string) {
  const fetcher = replayFetcher();
  return normalizePage(await fetcher.page(id), await fetcher.blocks(id));
}

describe("normalizePage", () => {
  it("turns properties into plain values", async () => {
    const page = await loadPage(meetingNotes.ids.pageOk);
    expect(page.title).toBe("議事録 2026-11-04 定例");
    expect(page.url).toMatch(/^https:\/\/www\.notion\.so\/.+2a1f7c3e5b6d8011a001000000000001$/);
    expect(page.properties).toEqual({
      名前: { type: "title", text: "議事録 2026-11-04 定例" },
      日付: { type: "date", start: "2026-11-04", end: null },
      参加者: {
        type: "people",
        count: 2,
        hasMore: false,
        ids: ["1d2e3f40-0000-4000-8000-000000000001", "1d2e3f40-0000-4000-8000-000000000002"],
      },
      種別: { type: "select", value: "定例" },
      チケット: { type: "rich_text", text: "OPS-42" },
      公開: { type: "checkbox", checked: true },
      作成日時: { type: "unsupported", apiType: "created_time" },
    });
  });

  it("builds a heading tree; synced blocks are transparent; toggle heading children come first", async () => {
    const page = await loadPage(meetingNotes.ids.pageOk);
    expect(outline(page.body)).toEqual([
      "paragraph: 定例会の議事録です。",
      ["H2 目的", ["paragraph: 今週の進捗を共有する。", "paragraph: "]],
      [
        "H2 決定事項",
        [
          [
            "bulleted_list_item: リリース日を 11 月 20 日にする",
            ["bulleted_list_item: QA は 18 日までに終える"],
          ],
          "bulleted_list_item: 週次の定例は木曜に移す",
        ],
      ],
      ["H2 TODO", ["to_do: 議事録を共有する"]],
      ["H2 メモ", ["paragraph: 次回は 11 月 11 日。"]],
    ]);
  });

  it("nests a lower heading under the nearest higher one, and pops back for a higher one", async () => {
    const page = await loadPage(meetingNotes.ids.pageBad);
    expect(outline(page.body)).toEqual([
      ["H2 目的", ["paragraph: 障害の振り返り。"]],
      ["H2 TODO", ["to_do: 再発防止策をまとめる"]],
      "H2 雑談",
      ["H1 付録", [["H3 詳細", ["paragraph: ログは別ページ。"]]]],
    ]);
  });

  it("reads empty and missing values without throwing", () => {
    const page = normalizePage({
      id: "p",
      properties: {
        n: { type: "number", number: null },
        s: { type: "status", status: null },
        m: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
        r: { type: "relation", relation: [{ id: "x" }], has_more: true },
        u: { type: "url", url: null },
      },
    });
    expect(page.title).toBe("");
    expect(page.properties).toEqual({
      n: { type: "number", value: null },
      s: { type: "status", value: null },
      m: { type: "multi_select", values: ["a", "b"] },
      r: { type: "relation", count: 1, hasMore: true, ids: ["x"] },
      u: { type: "url", text: "" },
    });
  });
});
