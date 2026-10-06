# AXで最初のエージェントを動かす

更新日：2026-10-05。担当・記録更新：Codex。

最初のマイルストーンは完了。2026-10-05 10:27 UTC、AXのエージェントがGeminiを使ってresult.txtを作成し、正確な内容・終了0・verified・正常終了ログを確認した。生成要求2件、概算0.0006905 USD。試験後は通信を閉じた。利用者の追加指示に従って原因調査をAPI送信なしで行い、修正とローカル検証の根拠を揃えてから1回だけ再試験した。条件別の正本は[検証結果](verification.md)。

## 目的と範囲

既存のARM64 kindクラスタ `ax-local` を使い、AX経由でエージェントを1件起動して結果を確認する。利用者から構築・実行確認の依頼を受けた。RAG・長期記憶・独自UI・社内外ツール接続は後続とする。

範囲はローカルレジストリ、Substrate、AX、ARM64実行イメージ、モデル接続、基本的なログと外部通信の検証。既存クラスタを再作成せず、専用kubeconfigを使う。認証情報の値をログ・会話・Gitへ保存しない。

## 工程の選択

標準規模の構築として、既存の段階的な計画を再利用し、版の互換性とARM64の実動作を調査・実装・検証で確認する。構造の新規設計は現時点では不要。認証・通信制御の具体化に独立レビューが必要になった場合は、実装内容と検証結果を渡す。

## 作業単位と状態

| 単位 | 結果と確認方法 | 依存 | 状態 | 確認結果 |
|---|---|---|---|---|
| U1 | DockerレジストリからkindへARM64サンプルを取得・起動しログを見る | 既存kind | 完了 | 合格 |
| U2 | Substrateの主要サービス・WorkerPoolを導入し、ActorをU3で確認 | U1 | 完了 | 合格 |
| U3 | AX CLI・サーバー・ARM64 runnerを用意しTaskを起動する | U2 | 完了 | 基本経路は合格、詳細は検証記録 |
| U4 | 最小のモデル利用タスクの出力・終了結果を確認 | U3、モデル認証 | 完了 | ファイル作成・終了0・使用量・通信遮断を確認 |

各単位の変更と実環境への書き込みは担当1名で順に行う。取得した公式ソースは `ax-local/.sources/`、再利用する設定・スクリプトは `ax-local/`、実行ログは `ax-local/.state/` に置く。中間結果の検証後に次へ進む。

## 受け入れ条件

- A1：AX CLIから試験Taskを作成し、準備完了を確認できる。
- A2：モデルを利用する小さな処理が期待した出力を残し、終了結果を確認できる。
- A3：状態とログから、基盤の起動失敗と処理失敗を区別できる。
- A4：Taskを削除し、固定した版と手順で再実行できる。
- A5：必要な外部接続先を記録し、Actorの通信経路で許可・拒否を確認する。未検証の経路は制御済みとしない。

PodやTaskのRunningだけではA2を満たさない。最新の判定と証拠は [検証結果](verification.md) に集約する。

## 着手時の確認

kind 0.33.0 / Kubernetes 1.36.4 / Linux ARM64のノード1台がReady。Dockerは10 CPU・約8GBメモリ。管理用のkind・kubectlはmiseで有効。既存のユーザー変更は未追跡ファイルとして存在し、維持する。

## 費用条件とモデル試験

[費用のグラウンドルール](../../babel/rules/ax-model-spending.md)を正本とする。2026-10-05、利用者は利用上限・前払いをそれぞれ2,000円にしたと申告した。以前の10 USD条件は置き換える。上限超過だけでなく、成果のない大量送信と予算消化も禁止。モデルAPIなしで調べられる部分を先に進め、失敗・使用量不明・想定外の消費で追加送信を止める。

キーはローカルの受け渡し先 `ax-local/.state/model-api-key` に保存済み。AXの規定パスではない。models.listで認証確認後、stdin経由でSecretへ登録した。利用者の課金画面自体は未確認。入金・自動チャージ・上限変更をエージェントが行ったわけではない。

現在の試験設定は3.1 Flash-Lite、モデル合計3回・ツール2回・入力6000・出力512・合計6512トークン、API再試行0・出力形式の再処理1、create_file/finishだけ、subagents無効、90秒timeout。独立レビューとネットワークなしの最終イメージ検証を実施した。今回追加したattemptedの排他的作成はAgent起動前に行い、失敗後も同じ領域で再実行を拒否する。SDKのturn全体の使用量から概算を記録する。SDKの制限を課金額の厳密な保証とは扱わない。

過去の試験：08:59 UTCの2.5 Flash-Liteは404、09:02 UTCの3.1 Flash-Liteは前払い不足の402。各要求1件、終了1、再試行なし。証拠を保存し、各試験後にegressを閉じた。

利用者の入金後、使用量記録付きimageへ切り替えた。AXのTask specはimmutableでapply更新が拒否されたため、記録済みの旧402 Taskを削除し、新imageで作成した。旧Taskには今回導入するattemptedはなく、新ルール下の失敗markerを解除したものではない。最終imageは `versions.json` のrunner_budget。

09:23 UTCの試験は要求1件、200、入力1123・出力26・思考0、概算0.00031975 USD。モデルはリンクとコードブロックだけを返し、ツール実行はなかった。result.txtとverifiedはなく終了1。attempted・usage.jsonを保存し、start消費とdeny-all復帰を確認した。この時点で追加有料試験を停止した。後述の追加指示を受けて原因調査から再開した。成功済みのライフサイクル確認を理由に有料試験を重複実行しない。

## 根拠を得てからの修正と再試験

利用者は追加指示で、厳密にAPI送信なしで原因を調べ、根拠が得られれば低額の試験を進めてよいと承認した。2,000円上限・無駄な大量送信禁止は維持する。

Dockerのnetwork noneとローカルHTTPスタブで、出力形式retry=0がGemini要求のtool mode=NONEになることを再現。1ならAUTOになった。workspace_onlyだけではcreate_fileがfail-closedで拒否されることも確認した。明示allowに加えてTargetFileの実体パスが試験用result.txt以外なら明示denyする修正を行った。API retry=0と総モデル呼び出し上限3は維持。

修正前Redと修正後7ケース、最終イメージでの同じ7ケースが対応する。独立レビューも合格。旧失敗TaskをSuspendedで保持し、修正版ax-model-smoke-v2を新規作成した。10:27 UTCの実試験は2要求とも200、入力2396・出力61・思考0、概算0.0006905 USD。ファイルの正確なバイト列、終了0、verified、正常終了ログを確認し、egressを[]へ戻した。試験用ファイルのホスト側コピーはax-local/.state/agent-result.txt。

A4のライフサイクルはモデルなしTaskでの既存検証を再利用し、成功後の有料再実行は行わなかった。RAG・記憶・外部ツール・独自UIは将来のマイルストーンとして保持する。

## 実装・検証の経過

2026-10-05：U1はローカルレジストリ経由のJobがCompleteとなり、`ax-local-registry-ok: linux/arm64` を出力した。レジストリは127.0.0.1:5001だけに公開し、kindネットワークから接続する。Docker Desktopのcredential helperが公開イメージの取得時に停止したため、専用の匿名Docker設定を `with-env.sh` で使う。通常のDocker設定は変更していない。

AXは `ac2332829f22360ff97b0ba34d94dd0dd782f17e`、SubstrateはAXの依存版と一致する `944abe3278b895ccbf5d45555a49dd0f2f6ceae7` を取得した。Go 1.27.1 / ko 0.19.1をmiseでプロジェクト指定して導入した。公式 `hack/install-ate-kind.sh --deploy-ate-system --rollout-timeout=600s` を専用kubeconfigで実行し、成功した。実行証拠は `ax-local/.state/substrate-install.log`。

U2の導入は成功。AX、Redis、1台のgVisor WorkerPoolを導入した。AX用Secret権限は `ax-demo/gemini-api-secret` のgetだけに制限し、独立レビューでも許可・拒否を実測した。AX CLIのapply/resumeで `ax-smoke` を起動し、実Actor名付きログで `AX_SMOKE_OK` と `task command completed successfully` を確認した。`ax ssh` でも成果物を取得できた。

HTTPはポリシー未設定でgateway拒否、`example.com` だけ許可すると200、`example.org` は403だった。標準のTLS passthrough構成ではホスト名ルールだけではHTTPSが通らない（公式networking E2Eにも記載）。モデルAPI用に、公式の `--experimental-use-sdsmint` を適用する。IP許可方式は接続先のIP変動と許可範囲が問題になるため、このローカル試験では採用しない。公式機能の再利用であり独自gatewayは作らない。CAはsandboxイメージだけへ追加し、Macの信頼設定は変更しない。撤回は通常の `--deploy-atenet` 再適用と元のrunnerイメージへの切替。

独立レビューで、workspace goalはgolden actorで先に走り、bootstrap失敗でもReadyになりうる点を確認した。モデル試験はTask commandを開始合図まで待機させ、通常Actorへのポリシー設定後に公式Antigravity bootstrapを起動して、出力ファイルと終了を確認する。Secret値はActorTemplateのenvとしてSubstrate側にも保存されるため、Kubernetes RBACだけで全保存経路を隔離したとは扱わない。

最終状態：Substrate/AXの導入は成功。goldenと通常Taskが競合したため、ワーカーを1GiB・1 CPU上限の2台へ変更した。試験Task ax-smokeはRunning/Readyで保持し、egress許可は空へ戻した。サンプルのKubernetes Jobはログを保存して削除した。全26 PodはRunning/Readyまたは正常完了、再起動数0。AXとSubstrateのソースcheckoutは変更なし。

操作は [README](../../../ax-local/README.md)、導入の再実行は [rebuild.md](../../../ax-local/rebuild.md)。費用ルール追加前には全25文書のstrict・drift検査がエラー・警告0件で通過した。今回のルール追加後も全26文書のstrict・drift検査がエラー・警告・壊れたリンク・孤立・driftのすべて0件で通過した。

## 参照

2026-10-05 20:41日本時間、最初のエージェント実行までを [PR #1](https://github.com/sori883/agent-workspace/pull/1) としてmainへマージした。コミットは `7d023e85ab622bf16940ed721f9082bf107e6e70`。ローカルmainへ反映済み。公開対象は33ファイルで、APIキー・kubeconfig・生ログ・上流ソース・生成バイナリ・個人用スキル・内部記録を除外した。公開用検証要約は `ax-local/verification.md`。

PR準備時のnetwork none回帰7ケース、shell/Python/JSON/gofmt/ローカル文書リンク/diff検査、sourceとimageのSHA一致、既存成功Taskの結果を再確認した。独立レビューの前提ツール不足1件は修正し最終指摘0件。GitHub CIは未設定。モデルAPI追加送信なし。後続の汎用タスクCLIは未実装で、このPRに含めていない。

- [構想と最初のゴール](../../babel/knowledge/ax-agent-platform-direction.md)
- [kind環境](../../babel/knowledge/ax-local-kind-environment.md)
