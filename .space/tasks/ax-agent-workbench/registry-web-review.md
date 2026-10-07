# 登録画面・APIの独立レビュー

2026-10-07、担当B。基準 `ede929ea87af8173af128e7b8706c11d1a9b16f6`、`codex/agent-workbench` の親担当による未コミット差分をレビューした。Bが実装した保存層は独立レビューの対象に数えない。結果はR1の1件。親が修正を採用し、変更後のUIソースまで照合済み。追加の必須指摘はない。

## R1 / P2：下書きの名前を公開版の名前として選択させる

- 箇所：`web/app/components/definition-editor.tsx` の `loadSkills` / picker（初回確認時111〜119、152行）。
- 発生条件：スキルを `old-name` として第1版公開し、下書きだけ `new-name` へ改名する。作者またはadminがagent編集画面でスキルを探す。
- 症状：一覧の `item.name` は編集者向けの下書き名なので、画面は「new-name（第1版）」を表示する。しかし選択IDは `latest_version.id` であり、固定される内容は `old-name` の公開版。利用者が選ぶ公開内容と表示名が一致しない。
- 必須修正：公開版本文のnameをsummaryへ含め、pickerと選択済みラベルに使う。下書きだけ改名した回帰を追加する。
- 対応：親が採用。親の追加依頼によりBが `latest_version.name` を保存層へ追加した。DBのget/listは公開版本文からnameを返し、下書き改名後も変わらないことを16件のDB試験で再確認した。親のUIは152行の表示・ボタン名・選択済みラベルを `item.latest_version.name` へ変更し、`library.spec.ts` に未公開名がpickerに出ない条件を追加した。
- 判定：コード上は解消。ブラウザ回帰の実行結果は親の検証記録に従う。追加した保存層コードはBの自己確認であり、独立確認とは扱わない。

## 確認範囲

`web/api/{app.ts,runtime.ts,definition-service.ts}`、`web/app/lib/{definitions.server.ts,definition-copy.ts,library-page.server.ts}`、`web/app/routes/library*`、`definition-editor.tsx`、`routes.ts`、`workspace.tsx`、`app.css`、`definition-transfer.ts`、API試験・ブラウザ試験を読んだ。必要な周辺として既存security、workspace scope、HTTP読取上限も照合した。

- APIは既存service credentialと検証済み本人tokenを使い、ownerを認証context、Workspaceを必須headerから取得する。payloadのowner/workspace混入、未知field、重複queryを拒否する。Runtimeは同じDBへDefinitionRepositoryを注入する。
- BFFのmutationはJSON本文の192 KiB上限、Origin/HostとCSRFを通ってAPIへ進む。応答はno-store。512 KiBの応答枠には、最大128 KiBのdraftと公開版本文の両方が収まる。
- createは画面URLのdraft UUID、update/publish/archiveは生成したkeyとrevisionを送る。結果不明では送信packetを保持し、入力を固定して同じpacketを再確認する。既知の入力・認可・競合エラーと不明503を分けている。
- 共有の公開範囲変更は新規コピーとして扱い、既存visibilityを変更しない。編集不可の場合は入力formを出さず保存内容を表示する。作業fileや会話・結果の参照をコピーpayloadへ含めない。
- 公開は保存済みdraftだけを対象にし、未保存変更がある間は公開ボタンを無効にする。skill依存はversion IDを保持し、再読込みでも同じ版を表示する。
- UIの本文はReactのtextとして表示し、登録scriptを評価しない。入力はmaxlengthによる切り詰めをせず、容量と制約を表示する。

確認したAPI診断は `npx tsx --test tests/definition-api.test.ts`、1/1成功。本人解決、large text、no-store、入力混入、Origin、token、Workspace必須、revision型、上限とエラー伝達を通した。親が実行中のブラウザ試験は本担当では重複起動していない。

## 根拠・限界

契約は [registry-contract.md](registry-contract.md)。OKF bundleは `.space/babel`。既読の `knowledge/ax-web-foundation`、`decisions/systems/ax/auth-foundation`、`portable-api-postgres`、`workspace-access`、`agent-runtime` と `rules/ax-model-spending` の本人所有・共通API境界・費用制約を継承した。追加path検索は `web/app/components/definition-editor.tsx` と `web/api/app.ts` を実施し、該当する既読文書との適合を確認した。

DADSのローカルstatusはinstalled=true、check_due=false。`foundations/layout/index.md` と `components/input-text/index.md`、`components/textarea/index.md` の関連箇所を参照し、既存レイアウトの再利用、label/補助文、文字数上限、切り詰めなし、静的エラー表示を照合した。ブラウザによる視覚・キーボード・320px・axeの実測は親担当の証拠を使う。DADS/WCAGの完全適合は判定していない。

初期レビューは読み取り専用で行い、製品修正はR1を受けて親が明示した保存層4ファイルに限った。稼働DB、AX、有料送信、commit/PRは操作していない。独立レビューは親担当のWeb実装に限り、自作保存層の安全性を独立に承認するものではない。
