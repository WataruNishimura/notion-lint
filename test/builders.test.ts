import { describe, expect, it } from "vitest";
import {
  block,
  defineConfig,
  doc,
  h,
  numbering,
  prop,
  references,
  text,
  validateConfig,
} from "../src/index.js";
import designExample from "./fixtures/design-example.config.js";
import { readFixtureJson } from "./helpers.js";

describe("builders", () => {
  it("build the design doc example into the same data as the hand-written JSON", () => {
    expect(designExample).toStrictEqual(readFixtureJson("design-example.json"));
    expect(validateConfig(designExample)).toEqual({ ok: true, config: designExample });
  });

  it("produce plain data that survives a JSON round trip unchanged", () => {
    expect(JSON.parse(JSON.stringify(designExample))).toStrictEqual(designExample);
  });

  it("store a RegExp as { pattern, flags }", () => {
    const config = defineConfig({
      type: doc({
        properties: {
          チケット: prop.richText().pattern(/^[a-z]+-\d+$/iu),
          メール: prop.email().pattern("@example\\.com$", "i"),
          URL: prop.url().pattern("^https://"),
        },
        body: [h.h2(/^決定事項/), h.h3(/^メモ$/i)],
        references: references({ patterns: ["{n}章", /(?<n>\d+)節/u], ignore: [/別紙\d+/] }),
      }),
    });
    expect(config).toStrictEqual({
      type: {
        properties: {
          チケット: { type: "rich_text", pattern: "^[a-z]+-\\d+$", flags: "iu" },
          メール: { type: "email", pattern: "@example\\.com$", flags: "i" },
          URL: { type: "url", pattern: "^https://" },
        },
        body: [
          { heading: 2, title: { pattern: "^決定事項" } },
          { heading: 3, title: { pattern: "^メモ$", flags: "i" } },
        ],
        references: {
          patterns: ["{n}章", { pattern: "(?<n>\\d+)節", flags: "u" }],
          ignore: [{ pattern: "別紙\\d+" }],
        },
      },
    });
    expect(validateConfig(config).ok).toBe(true);
  });

  it("cover every property and block kind", () => {
    const config = defineConfig({
      type: doc({
        name: "全部",
        properties: {
          a: prop.title().required(),
          b: prop.number().min(0).max(10),
          c: prop.multiSelect(["x", "y"]).min(1).max(2),
          d: prop.status(),
          e: prop.checkbox(),
          f: prop.files().max(3),
          g: prop.relation().min(1),
          h: prop.phoneNumber().optional(),
        },
        body: [
          h.h1("概要", {
            children: [
              block.paragraph(),
              block.bulleted().max(5),
              block.numbered(),
              block.toggle().children(block.code(), block.image().optional()),
              block.quote(),
              block.callout(),
              block.table(),
              block.divider(),
              block.any().optional(),
            ],
          }),
          h.h2("詳細", { optional: true }).children(h.h3("補足")),
        ],
      }),
    });
    expect(config.type).toStrictEqual({
      name: "全部",
      properties: {
        a: { type: "title", required: true },
        b: { type: "number", min: 0, max: 10 },
        c: { type: "multi_select", options: ["x", "y"], min: 1, max: 2 },
        d: { type: "status" },
        e: { type: "checkbox" },
        f: { type: "files", max: 3 },
        g: { type: "relation", min: 1 },
        h: { type: "phone_number", optional: true },
      },
      body: [
        {
          heading: 1,
          title: "概要",
          children: [
            { block: "paragraph" },
            { block: "bulleted_list_item", max: 5 },
            { block: "numbered_list_item" },
            { block: "toggle", children: [{ block: "code" }, { block: "image", min: 0 }] },
            { block: "quote" },
            { block: "callout" },
            { block: "table" },
            { block: "divider" },
            { block: "any", min: 0 },
          ],
        },
        { heading: 2, title: "詳細", optional: true, children: [{ heading: 3, title: "補足" }] },
      ],
    });
    expect(validateConfig(config).ok).toBe(true);
  });

  it("are immutable: chaining returns a new builder", () => {
    const base = prop.people();
    const strict = base.min(2);
    expect(base.toJSON()).toStrictEqual({ type: "people" });
    expect(strict.toJSON()).toStrictEqual({ type: "people", min: 2 });
  });

  it("extend a doc, merging properties and headings by key", () => {
    const base = doc({
      properties: { 日付: prop.date().required(), 種別: prop.select(["定例"]) },
      body: [h.h2("目的")],
      headings: { noSkipLevel: true },
    });
    const derived = base.extend({
      properties: { 種別: prop.select(["臨時"]), 参加者: prop.people().min(1) },
      headings: { allowExtra: false },
      text: text.textlint({ preset: ["a", "b"], rules: { "no-todo": true } }),
    });
    expect(derived.toJSON()).toStrictEqual({
      properties: {
        日付: { type: "date", required: true },
        種別: { type: "select", options: ["臨時"] },
        参加者: { type: "people", min: 1 },
      },
      body: [{ heading: 2, title: "目的" }],
      headings: { noSkipLevel: true, allowExtra: false },
      text: { textlint: { presets: ["a", "b"], rules: { "no-todo": true } } },
    });
    expect(base.toJSON().properties?.種別).toStrictEqual({ type: "select", options: ["定例"] });
  });

  it("accept plain data mixed with builders", () => {
    const config = defineConfig({
      type: {
        body: [{ heading: 2, title: "目的" }, h.h2("背景")],
        numbering: numbering({ format: { h2: "{n}. {title}" } }),
      },
    });
    expect(config).toStrictEqual({
      type: {
        body: [
          { heading: 2, title: "目的" },
          { heading: 2, title: "背景" },
        ],
        numbering: { format: { h2: "{n}. {title}" } },
      },
    });
  });
});
