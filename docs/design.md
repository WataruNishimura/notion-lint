# notion-lint 計画

Notion のページが決められた書式に従っているかを検査する CLI。

## 方針 (2026-11-10 決定)

- 新しいリポジトリ `notion-lint` (このフォルダの下) として作り、実装はそのリポジトリの Orca プロジェクトで行う。
- Node + TypeScript の CLI。Notion API (インテグレーショントークン) でページを取得して判定する。CI や定期実行にも載せられるようにする。
- ESLint のようにルールを並べて ON/OFF する形ではなく、**`notion-lint.config.ts` に文書の「型」(スキーマ) を書き、ページがその型に合うかを検証する**。zod でデータを検証するのに近い。
- 型で表すもの: 見出し構成、プロパティ、本文の表記、テンプレート準拠、章番号と本文中の参照の一致。
- エージェントから使うことを前提にする。型は JSON でも書け、標準入力で渡せる。結果も JSON で返す。

## 設定ファイルのイメージ

```ts
// notion-lint.config.ts
import { defineConfig, doc, prop, h, block, text } from "notion-lint";

// 文書の型
const 議事録 = doc({
  properties: {
    日付: prop.date().required(),
    参加者: prop.people().min(1),
    種別: prop.select(["定例", "臨時"]),
    チケット: prop.richText().pattern(/^[A-Z]+-\d+$/).optional(),
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
});
```

- 型は TypeScript の値なので、共通部分を変数にして使い回したり、`議事録.extend({...})` で派生させたりできる。
- 違反は「どのページの、どのブロック/プロパティが、型のどこに合わないか」を、Notion へのリンク付きで出す。

```
議事録 2026-11-04 定例  https://notion.so/...
  ✖ properties.参加者   1 人以上必要 (0 人)
  ✖ body[1]             見出し「決定事項」がない (「目的」の後に必要)
  ⚠ body > 目的         textlint: 「出来る」→「できる」 (ja-technical-writing/ja-no-weak-phrase)
```

## エージェントからの利用

Claude などのエージェントが、その場で型を組み立てて検査を実行できるようにする。

**型を JSON でも書ける**
- `doc()` などのビルダーは、JSON にできるデータ構造を作るだけにする。そのデータ構造を JSON Schema で定義し、それが正本になる。
- 正規表現は文字列で書く (`{ "pattern": "^[A-Z]+-\\d+$" }`)。関数を渡すような、JSON にできない指定は作らない。
- TS の設定ファイルは人が書きやすくするための層にする。`notion-lint print-config` で JSON に書き出せる。

**受け取り口**

| 指定 | 用途 |
|---|---|
| `--config notion-lint.config.ts` | 人が使うとき |
| `--config -` | 標準入力から JSON を受け取る。エージェントは基本これを使う。長さの上限やシェルのクォートの問題を避けられる |
| `--config-json '{...}'` | 短い型を試すとき |

JSON で渡した型はコードとして実行しない。TS の設定ファイルだけが実行される。

**エージェント向けの出力**
- `notion-lint schema`: 設定の JSON Schema を出力する。エージェントはこれを読んで型を組み立てる。
- `--format json`: 違反ごとに、ページ ID、ブロック ID、型のどこに対応するか (`body[1]`、`properties.参加者` など)、メッセージ、直し方の候補を構造化して出す。
- `--page <URL か ID>`: 設定ファイルの `targets` を使わず、その場で指定したページだけを検査する。
- 終了コード: 0 は違反なし、1 は違反あり、2 は設定エラーや API エラー。設定エラーのときも JSON で、どの項目が Schema に合わないかを返す。

**例**

```sh
echo '{"type":{"body":[{"heading":2,"title":"目的"}]}}' \
  | notion-lint --config - --page https://www.notion.so/xxxx --format json
```

**`notion-lint agent`: エージェント向けの説明を書き込む**

リポジトリのエージェント用指示ファイルを自動で見つけ、notion-lint の使い方を追記する。

- 探す場所: カレントディレクトリから上にたどって最初の Git ルート。Git の外ならカレントディレクトリ。
- 探すファイル (大文字小文字を区別しない): `AGENTS.md`、`AGENT.md`、`CLAUDE.md`、`.claude/CLAUDE.md`。
- 書き込み先の決め方:

| 見つかったもの | 書き込み先 |
|---|---|
| どれか 1 つ | そのファイル |
| `CLAUDE.md` が `@AGENTS.md` を読み込んでいる | `AGENTS.md` だけ (二重に載らないように) |
| 両方あり、読み込み関係がない | 両方 |
| どれもない | 書き込まず、`--create AGENTS.md` などで作るよう案内して終了コード 2 |

- 追記する部分は `<!-- notion-lint:start -->` と `<!-- notion-lint:end -->` で囲む。再実行するとその範囲だけを最新の内容に置き換えるので、何度実行しても重複しない。範囲の外は変更しない。
- オプション: `--target <file>` で書き込み先を指定、`--dry-run` で差分だけ表示、`--print` で本文を標準出力に出すだけ、`--remove` で追記部分を削除。
- 追記する本文は短くする (これらのファイルは毎回エージェントに読み込まれるため)。中身は次の要点だけで、詳細は `notion-lint schema` と `notion-lint --help` に任せる。
  - 型は `notion-lint schema` で JSON Schema を見て組み立て、`--config -` で標準入力から渡す
  - 結果は `--format json` で受け取り、終了コードは 0 / 1 / 2
  - トークンは `NOTION_TOKEN`。値をファイルや出力に書かない
  - リポジトリに `notion-lint.config.ts` があれば、それを優先して使う
  - 本文に notion-lint のバージョンを入れ、古いときに再実行を促せるようにする

将来、MCP サーバーとして同じ機能 (`schema` / `check`) を公開することもできる。CLI と同じ中身を呼ぶだけにする。初版は CLI のみ。

## 構成

```
config.ts 読み込み → fetch (Notion API) → normalize (内部表現) → 型と照合 → report → 終了コード
```

| 層 | 内容 |
|---|---|
| config | `jiti` などで `notion-lint.config.ts` を読む。`doc / prop / h / block / text` のビルダーが型の定義 (内部ではただのデータ構造) を作る |
| fetch | `@notionhq/client`。ページ ID、またはデータソース＋条件で対象を集める。子ブロックを再帰取得し、ページネーションとレート制限 (平均 3 req/s 程度) に対応する |
| normalize | API の JSON を、見出し・段落・リストなどのブロック木とプロパティの辞書に変換する。照合部は API の形を直接見ない |
| validate | プロパティは項目ごとに検査。本文は「型の骨格」と「ページの見出し木」を順に突き合わせる (余分な見出しは `allowExtra` に従う)。本文テキストは Markdown 化して textlint に渡す |
| report | 人が読む形式、JSON、GitHub Actions のアノテーション |

## 本文の照合の考え方

- ページの見出しで木を作る (見出しの下のブロックはその見出しの子)。
- 型の `body` 配列を先頭から順に、ページの見出しと名前で対応づける。順序が違う・足りない・余分、をそれぞれ別の違反として出す。
- 見出し名の一致は完全一致を基本とし、`h.h2(/^決定事項/)` のように正規表現も書ける。
- `doc.fromTemplate` はテンプレートページを取得して同じ形の `body` を自動生成する。テンプレートを直すと型も変わる。

## 章番号と参照の照合

Notion の見出しには自動の章番号がないので、番号は見出しの文字列に手で書かれている前提で検査する。

**章番号 (`numbering`)**
- 見出しの文字列を `format` で番号とタイトルに分ける。書式に合わない見出しは違反にする。
- 番号が見出しの階層と合っているか (H2 の「2.1」は直前の H1 が「2.」か)、抜けや重複がないかを見る。

**参照 (`references`)**
- 本文 (段落、リスト、表、コールアウトなど) から `patterns` に合う箇所を拾い、ページの見出し一覧と照合する。

| 本文の例 | 照合の内容 | 違反の例 |
|---|---|---|
| 「3章を参照」 | 3 番の章がある | 章が 2 つしかない |
| 「2.1「背景」で述べた」 | 2.1 の見出しが「背景」 | 2.1 は「目的」、「背景」は 2.2 |
| 「「背景」を参照」 | 「背景」という見出しがある | 見出しが「経緯」に改名されていた |
| ブロックへのリンク「2.1 背景」 | リンク先の見出しが 2.1「背景」 | 章を入れ替えた後もリンクの文字列が古い |

- 番号とタイトルが食い違うときは「2.1 は『目的』です。『背景』は 2.2 です」のように直し方を示す。
- 別ページへの参照 (ページメンション、他ページのブロックへのリンク) は、リンク先が存在して読めるかまでを見る。リンク先の章番号の照合は、そのページも検査対象のときだけ行う。
- 本文中の「3章」が別の文書の 3 章を指すことはあるので、`ignore` で除外語や除外範囲を指定できるようにする。

## テスト

- Notion API の応答 JSON をフィクスチャとして保存し、vitest でネットワークなしに検査する。
- 型のビルダーと照合部は Notion なしで単体テストできるように分ける。
- 実ワークスペースでの確認は、テスト用ページを用意して手動で行う。

## 進め方

1. 雛形: pnpm、TypeScript、vitest、Biome、CLI の入口
2. 型のデータ構造と JSON Schema、`--config -` / `--config-json` / config.ts の読み込み、`schema` コマンド。その上に型のビルダー (`doc / prop / h / block`)
3. fetch と normalize (フィクスチャで単体テスト)
4. プロパティの照合
5. 本文 (見出し木) の照合とエラー表示 (人向けと `--format json`)
6. 章番号と参照の照合
7. textlint 連携
8. `doc.fromTemplate`
9. `notion-lint agent` (指示ファイルの検出と追記)
10. GitHub Actions での定期実行例

## 注意点

- Notion API は 2025-09-03 版でデータベースが「データソース」に分かれ、クエリは data source ID に対して行う。新しい API 版を前提にする。
- インテグレーションは対象ページに接続 (共有) しないと読めない。
- トークンは環境変数 `NOTION_TOKEN` で渡し、リポジトリに入れない。
- 本文の表記ルールは自前で書かず、textlint の既存ルール (`textlint-rule-preset-ja-technical-writing`、表記ゆれ辞書 `prh`) を使う。

## 未決事項

- 実際に検査したい Notion のワークスペース、データベース、具体的な文書の型
- 章番号と参照の実際の書き方 (「第3章」「3.」「3-1」など)。既存の文書を見て `format` と `patterns` の初期値を決める
- GitHub リポジトリの持ち主と公開範囲 (例: `WataruNishimura/notion-lint`、private)
- 自動修正やページへのコメント投稿をするか (初版は検査のみの想定)
- npm パッケージとして公開するか、自分用ツールにとどめるか
