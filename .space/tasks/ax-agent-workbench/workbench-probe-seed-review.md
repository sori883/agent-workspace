# Workbench probe seed の独立レビュー

2026-10-07、担当 A。基点 `ede929e`、未コミットの親作成 `web/scripts/workbench-probe.ts` と `web/tests/fixtures/workbench-input.xlsx` を読み取り確認した。A はこの 2 ファイルを作成していない。同一モデルの別担当によるレビューであり、モデルの多様性はない。ソース編集、seed 実行、DB 接続、AX 操作、モデル送信は行っていない。

**現判定：code_profile の固定値追加は、親/B が実経路で確認した python_disabled の原因に対応する。** 新schema/rootの作成後、起動前のprofile・完全なimage referenceのreadback一致を条件として渡す。前回の「必須修正なし」はNULL初期値の見落としを含み、実code経路の合格ではなかった。

## 対象版

| 対象 | SHA-256 |
| --- | --- |
| web/scripts/workbench-probe.ts | `d0da4f6bfb1d9df55439491dcf37c9441d62ccc0974619b6e41aa60b213092fb` |
| web/tests/fixtures/workbench-input.xlsx | `57fc8b3217b18140278226478ecb3ee1ebef5b27c8ad5f15cbb7a6aa15b8a8d6` |

呼び出す `auth-migrate.ts` / `data-migrate.ts`、auth schema v1–v2、data schema v1–v8、Workspace/File/Workbench repository、executionFunctions を必要範囲で確認した。B の Go probe は fixture 入力契約だけ照合し、本体の独立レビューは C の担当へ残した。

## 確認結果

- **schema・事前拒否**：script 13–19 行。未知オプションと位置引数を拒否し、schema は `ax_workbench_probe_` + 英小文字/数字/underscore 8–40 文字、image は明示的な `@sha256:` 64 hex に限定。schema 長は PostgreSQL identifier 上限内で、SQL/options に区切り文字を注入できない。`public`、未指定 image、未指定 AUTH_CONFIG_FILE、schema と完全一致しない `--execution-role` は Pool 作成前に拒否する。
- **再実行**：23 行の `CREATE SCHEMA` は IF NOT EXISTS を使わない。同じ名前が存在すれば、その後の migration / seed / grant より前に停止する。途中失敗でも schema は残り、無言の再利用や削除をしない。
- **public からの分離**：19、25–39 行。操作 Pool の search_path は新 schema だけ。auth DDL はその schema へ作り、data migrations は `current_schema()` を捕捉して `schema, pg_temp` の関数 search_path を固定する。migration 内の REVOKE も current_schema の関数だけを列挙する。確認対象の SQL に `public.*` 書込みや role 作成/属性変更はない。admin Pool の変更は指定 schema と専用 role への CONNECT に限定する。DB 名も identifier quoting を行う。既存 public の ACL は変更しない。
- **専用 role の検査**：21–22 行。存在と LOGIN を要求し、SUPERUSER / CREATEROLE / CREATEDB / REPLICATION / BYPASSRLS、他 role の member である状態を schema 作成前に拒否する。パスワード列を読まない。親が別操作で新規作成する role が前提であり、既存の個別 ACL や object 所有権を網羅的に監査する処理ではない。
- **SQL 権限**：24、40–46 行。PUBLIC の新 schema/table/function 権限を取り除き、schema と同名の専用 role へ CONNECT、USAGE、固定 executionFunctions の EXECUTE だけを付与する。列挙は `n.nspname=$1` に限定し、現在の migration で定義される対象関数数との一致を要求する。regprocedure signature の名前省略時も、実行 Pool は新 schema を解決する。テーブル直接権限、API の start/作成関数、既存 public 関数への grant はない。seed の grant 先に `ax_execution` を残していない。
- **preview と入力**：28、33–39 行。trial_enabled=false、mode=preview、allow_model 未指定。現版は code_profile=host-quota-8m-v1 も明示する。runtime/code image は引数の pinned reference を保存する。CSV は `amount/100/200`、XLSX は 4,995 bytes、単一 sheet の `amount/10/20`。zip 内 9 entry を読み、macro/外部 relationship/埋込み object はなく、計算式もない。実ユーザー内容を seed へ取り込む経路はない。
- **秘密の表示**：17–19、39、47 行。認証 config と DB 資格情報は Pool にのみ渡し、stdout は schema/合成 owner・workspace/root/file ID/hash/pinned image/fixture。乱数由来の token fingerprint も stdout へ出さない。接続設定や生鍵の console 出力はない。
- **Go fixture 契約**：`execution/cmd/workbench-probe/probe.go` の version 1 / scenario csv-xlsx、instruction、input_1/2、CSV 15 bytes と XLSX 4,995 bytes の SHA に一致する。seed が許す schema は Go の許可集合にも含まれる。Go へ渡すファイルは stdout 全体でなく `.fixture` 部分を使う。

## 実行担当へ残す条件

seed は新 schema にある受付を作るまでで、AX を実行しない。別 schema の実行枠は public と共有されないため、この静的確認は稼働 AX の排他・旧 workload 停止を証明しない。親の既存 preflight と Go probe 側の gate を維持する。

seed 全体は一つの transaction ではない。失敗時は専用 schema の途中状態を保存し、同名の再実行を拒否する実装である。失敗後に自動 drop/reseed せず、親が内容を確認する。実行後の public 内容・既存 role ACL 不変、専用 role の指定 schema 関数権限、root が preview であることは実 DB で確認する。これらを実測済みとは報告していない。

## 差分再確認

初回版 `d6582637…` から、`--execution-role` 必須・属性/所属の事前検査・専用 role への CONNECT/USAGE/EXECUTE・関数数照合を追加した版 `95c71198…` を再読した。fixture bytes と preview 受付は不変。今回も実 DB には接続していない。親による新規 role 作成、私有 password ファイル保存、Pod 一時 Secret への受け渡しは、この seed のソースレビューとは別の操作である。

## 実経路での訂正と1行修正の再確認

2026-10-08、親/Bの実測報告：初回はRuntime seq1後、code未開始のままpython_disabledで停止し、Runtime停止/denyを確認した。schema-v8.sql:4のcode_profile初期値NULLをseed旧版が設定せず、start:199–200でNULLのままrootへ固定していた。次のPython作成:136/357はhost-quota-8m-v1との完全一致を要求する。Aの旧レビューはこのNULL初期値を見落とした。これは本担当が実AXで再現したという意味ではない。

新SHA `d0da4f6b…` の変更は seed 28行の `code_profile='host-quota-8m-v1'` 追加のみ。SQL条件と一致し、public/role/秘密の境界は変えない。rootのimage/profileはimmutableなので、既存failed rootを変更せず新schemaへ進む判断は正しい。

実起動前には、専用schemaのcontrolと新rootについて、profileがhost-quota-8m-v1、python_enabled=true、trial_enabled=false、mode=previewであることを読み戻す。runtime/code imageは引数の形式だけでなく、親のbuild記録とGo設定、AX_CODE_IMAGE・Substrate固定値に一致する完全なrepo@sha256 referenceを照合する。seed単体には外部のbuild記録を入力する契約がないため、この照合は親の起動前手順に必要。seedへ局所的に追加するなら、UPDATE RETURNINGで1行と固定profile/imageを確認し、start前に拒否する形が最小となる。

Go controller/workbench.go:40はclaim.Imageと設定imageの不一致を外部create前に拒否する。従って形式が正しい別digestを渡しても固定境界を迂回する根拠はないが、NULLprofileのような次区間での設定不備を事前readbackで発見する必要がある。本担当は新seedを実行しておらず、実測は親へ残す。

## 知識の照合

既読の `rules/ax-model-spending`、`decisions/systems/ax/auth-foundation`、`decisions/systems/ax/portable-api-postgres` の費用・役割分離を引き継いだ。OKF CLI で `web/scripts/workbench-probe.ts` の path search を行い、返った `knowledge/ax-web-foundation` の DB 正本・API/実行ロール分離・未知結果を再送しない境界を現在ソースへ照合した。bundle は `.space/babel`。OKF、他担当の記録、製品コードは変更していない。

## 8 MiB scenario と root readback の独立再確認

2026-10-08、担当 B。親が作成した seed script を読み取りレビューした。B は Go probe の作者だが、この TypeScript seed の作者ではない。対象 script の SHA-256 は `c3dc6312545851eb9499470706f32cc9aea65ab4deeca7f9a79b6c8ea894a626`。照合先は Go probe 5 ファイルの snapshot `6b1cd80bd74e310c2acd0016b5ef3e911a57e3c9591a8dafc98fe78fcafc310f`。

**判定：この追加差分に必須修正の指摘なし。** 先行する A の実測・評価は履歴として残し、今回の結論は現ソースと以下の独立確認に基づく。

- `workbench-probe.ts:13–22`：scenario は `csv-xlsx` を既定値とする固定 3 択。instruction、入力名、順序、各サイズが Go と一致する。未知 scenario は DB 設定読取・接続前に拒否する。
- `:18–21` のデータ生成部分だけを TypeScript transpile 後に Node VM で評価した。script 本体を import せず、Pool、認証設定、migration、seed は実行していない。CSV/XLSX、単一 8,388,608 bytes、非整列 4 件計 8,388,608 bytes の全 7 ファイルを SHA-256 で比較し、Go `scenarios.go` の固定値と一致した。4 件のサイズは 1,048,577 / 2,097,155 / 3,145,733 / 2,097,143 bytes。式 `(offset + 17 * (index + 1)) % 256` は Go 契約の 256-byte block の反復と同値である。未知 scenario の拒否も同じ限定評価で確認した。
- `:36,47–49`：code profile を control へ明示し、作成済み root から runtime/code image・profile・preview mode を読み戻して完全一致を確認する。`schema-v8.sql:199–200` がこの値を root へ固定するため、以前の NULL profile の受付を成功として返す経路は塞がっている。外部 build 記録・AX/Substrate 設定との digest 一致は親の preflight が引き続き必要。
- `:24–34,50–56`：schema/role 名の許可文字と完全一致、制限 LOGIN role の属性・membership 検査、既存 schema の再利用拒否、新 schema の search_path、PUBLIC 権限除去、同 schema の固定 execution 関数だけへの grant を維持する。scenario により SQL identifier、権限、接続先が変わる経路はない。既存 role の個別 ACL・所有 object の全監査は追加されておらず、新規専用 role を別途作る前提は変わらない。
- `:47,57`：合成 owner、固定入力、preview、乱数由来の grant fingerprint を使い、出力は合成 ID・メタデータ・digest・固定 image/profile に限る。DB 接続設定や token fingerprint の出力を追加していない。実行権限は専用 schema に限定するが、AX 全体の同時実行をこの script 単独では証明しない。

`web/node_modules/.bin/tsc --noEmit` は終了 0。既存 route 型を使い、typegen による生成物変更は行っていない。scenario 構築の限定評価と型検査は無課金・DB 接続なしで実施した。live seed、AX、image build/配備、実 role 権限確認は未実施である。親の単一 recovery job の事前 readback と通常 controller `-once` 再利用は、この seed の変更範囲外である。

追加の OKF path search は `web/scripts/workbench-probe.ts` に対して行い、`knowledge/ax-web-foundation` の DB 正本と API/実行ロール分離を照合した。既読の費用・未確定送信を再送しない制約を継続する。今回編集したのはこのレビュー記録だけで、製品コード・OKF・共有状態は変更していない。
