# notion-lint

Notion のページが、`notion-lint.config.ts` に書いた文書の「型」(プロパティ、見出し構成、本文の表記、テンプレート) に合っているかを検証する CLI。

設計は [docs/design.md](docs/design.md) を参照。

> 現在は設定の読み込みと検証、`schema` / `print-config` コマンドまで。Notion API からの取得と照合 (`check` の中身) は未実装で、`check` は設定を検証したあと `not_implemented` のエラー (終了コード 2) を返す。

## 使い方

```sh
# 設定の JSON Schema (エージェントはこれを読んで型を組み立てる)
notion-lint schema
# --format json の出力の JSON Schema
notion-lint schema result

# 設定を読み込んで JSON にする (TS の設定ファイルも可)
notion-lint print-config --config notion-lint.config.ts

# 設定の渡し方
notion-lint --config notion-lint.config.ts         # 人が使うとき (実行される)
echo '{"type":{"body":[{"heading":2,"title":"目的"}]}}' \
  | notion-lint --config - --page <URL か ID> --format json   # 標準入力の JSON
notion-lint --config-json '{"type":{...}}' --page <URL か ID>  # 引数の JSON
```

- JSON (標準入力、`--config-json`、`.json` ファイル) はコードとして実行しない。実行されるのは `.ts` / `.mts` / `.js` / `.mjs` の設定ファイルだけ。
- 設定を省略すると、カレントディレクトリの `notion-lint.config.ts` (`.mts` / `.js` / `.mjs` / `.json`) を使う。
- 設定が Schema に合わないときは終了コード 2 で、合わない項目を JSON で返す (`check --format json` は標準出力、それ以外は標準エラー出力)。

```json
{
  "ok": false,
  "error": {
    "kind": "config",
    "message": "設定が JSON Schema に合いません (1 件)。notion-lint schema で Schema を確認できます",
    "source": "stdin",
    "issues": [
      {
        "path": "type.body[0].heading",
        "pointer": "/type/body/0/heading",
        "keyword": "enum",
        "message": "次のどれかである必要があります: 1, 2, 3",
        "params": { "allowedValues": [1, 2, 3] }
      }
    ]
  }
}
```

終了コード: 0 は違反なし、1 は違反あり、2 は設定エラー・引数の誤り・API エラー。

## 設定ファイル

```ts
// notion-lint.config.ts
import { block, defineConfig, doc, h, prop } from "notion-lint";

const 議事録 = doc({
  properties: {
    日付: prop.date().required(),
    参加者: prop.people().min(1),
    チケット: prop.richText().pattern(/^[A-Z]+-\d+$/).optional(),
  },
  body: [h.h2("目的"), h.h2("決定事項", { children: block.list().min(1) })],
});

export default defineConfig({
  targets: [{ dataSource: "<データソース ID>", type: 議事録 }],
});
```

ビルダーは JSON にできるデータを作るだけで、`print-config` の出力は同じ内容を JSON で手書きしたものと一致する。正規表現は `{ "pattern": "...", "flags": "..." }` (プロパティでは `pattern` / `flags` の項目) として持つ。設定の形は [schema/notion-lint.schema.json](schema/notion-lint.schema.json) を参照。

## 開発

Node 22 以上と pnpm を使う。

```sh
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check
pnpm check         # 上の 3 つ
pnpm build         # dist/ に出力
pnpm dev schema    # ビルドせずに CLI を実行
```

- 設定の JSON Schema の正本は `src/schema/config.ts` (TypeBox)。TS の型はそこから `Static` で導く。
- `src/schema` を変えたら `pnpm schema:write` で `schema/*.schema.json` を書き直す (古いとテストが落ちる)。
