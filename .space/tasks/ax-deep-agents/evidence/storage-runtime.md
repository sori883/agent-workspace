# AXへのスキル原本搬送と停止境界

2026-10-08、`498abb96` を基点とする先行実装。担当は `/root/map_skill_storage_boundaries`、統合と実環境は統括担当。

## 実装

新規の依頼はcontext v2で許可された版・manifest・ファイルmetadataとloaded pathsを固定する。古い依頼はcontext v1と以前のruntime imageを保持する。PGの限定関数は現在認可と固定descriptorの一致を調べ、Goは取得前後の認可確認・S3署名・size/hash照合を行って、実際に選んだファイルだけAXへ渡す。

Pythonのtrusted runnerはファイルを0444・ディレクトリを0700で配置する。SKILL.mdと補助資料は通常ファイル・hardlinkなし・symlink非追跡・サイズ・SHA-256を読込みごとに確認する。固定descriptorを書き換えずモデル入力だけを復元し、source設定や資格情報はモデルへ渡さない。scriptsは実行しない。既存の実行証拠には従来どおり実際に渡した本文が残る。

復元したpromptをSDK subprocess起動前に40KiBと比較し、超過は `skill_context_too_large`・使用量0・費用0で回収する。この判定までに行った別区間のモデル使用量は取り消さない。

## 検証

- Go全体・race・vetに成功。追加修正後のnative/controller対象群も成功。
- PGの4境界試験が成功。現在認可、本文と補助資料の段階読込、固定版での新Task入力、旧v9の互換、旧agent選択拒否、モデル未送信時の0費用・失敗理由・実行枠解放を確認。
- 最新Python35件は、固定SDKを含むDocker内・networkなし・capabilitiesなしで全成功、skipなし。開発ホスト単独ではSDK未導入による11skipがあるため、最終判定はDocker結果を使用。
- 旧0555ディレクトリの通常削除失敗を再現し、stage・seal・開始後中断・完了後の4状態で0700の削除成功を確認。SKILL.mdを同じサイズの0444別内容へ差し替えてもprompt生成と開始を拒否する。
- GoのSuspend応答不明では、保存済結果と使用量を保持し、モデル・guest処理を再送せず、正式な停止証拠がなければ保留する回帰を追加。

A/B担当が実装を独立レビューした。BはBOM・path collision・40KiB事前計測と終了時権限の修正後を再確認し、新しい必須指摘なし。実AXでの最終結果と復旧は親の [統合確認](../verification.md) に記録する。

CIのumask 077によるmode差を受け、書込み後のfdをfchmod(0444)で確定する1行を追加した。専用回帰はRED→GREEN、全offline236件（環境依存62skip）とDocker35件（skipなし）が成功。独立レビューBで追加指摘なし。
