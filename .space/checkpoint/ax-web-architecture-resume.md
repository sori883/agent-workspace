# AX Web概略設計の引き渡しと再開

更新：2026-10-06T00:42:01+09:00。ユーザーの依頼は、現在の設計・見積もりをPRでマージし、次回の作業の準備をして今日は区切ること。設計文書のPR #3はマージ済み。追って既存ナレッジ・スキル等の公開も明示承認されたため、この記録を含めてGitへ保存する。Webの実装は未着手で、次の開始指示を受けてから進める。

## 保存状態

- 作業場所：`/Users/const/sori883/agent-workspace`。追加worktreeは使用していない。
- PR #3反映直後のブランチ：`main`。その時点のHEAD：`9bef7183fdff215cc687d5bb37042f2fd7c63da6`。`origin/main`と一致。
- [PR #3](https://github.com/sori883/agent-workspace/pull/3)：MERGEDをGitHubから確認。2026-10-06 00:40:06 JSTにマージ。
- 作業ブランチ：`codex/web-architecture-handoff`、元コミット：`10cac5eb88e755a179b87b2f133a2f64871c1799`。squashでmainへ反映した。
- PR #3で公開した変更：READMEと設計・見積もりの3ファイル。追加公開の対象は上記ナレッジ・スキル・設定・作業記録。
- PR #3時点では`.agents/`、`.codex/`、`.space/`、`AGENTS.md`を未追跡のまま保持した。その後、利用者が既存ファイル全体のpushを明示承認したため、`codex/share-workspace-knowledge`ブランチでこのcheckpointも含めて保存する。公開方針はOKF `rules/pr-delivery`に反映済み。
- 追加公開の作業開始時のHEADは上記PR #3のマージコミット。再開時は`git status`と現在の`main`/`origin/main`を確認し、この記録の古いHEADへ戻さない。
- Git除外対象の依存パッケージ・キャッシュ・秘密情報・ローカル実行状態・生ログは強制追加しない。236ファイルの追加候補について秘密情報パターン、秘密情報を示すファイル名、バイナリ、symlinkを確認し、該当なし。これはスキル全機能の動作保証ではない。
- 追加公開時の検証：OKF 28概念はstrict/driftとも合格（エラー・警告・リンク切れ・孤立0）。JSON 6件・TOML 5件・TypeScript 39件はBunで構文確認済み。`git diff --cached --check`はOKF文書のYAML行末空白・EOF空行60件を検出した。既存保存形式を保持し、書式だけの一括修正は追加していない。アプリや全スキルの動作試験は今回行っていない。

## 完了した内容と検証

- [概略設計](../../docs/web-architecture.md)：React Router SSR/BFF、共通バックエンド内のAX操作、AX内Pythonエージェント、共通認証とRAGの権限境界、AWSへの仮配置を整理。
- [概算](../../docs/web-mvp-estimate.md)：ローカルWeb版4〜8人日、共通認証込み6〜12人日。1人日8時間の作業量であり、AIの経過時間を約束するものではない。
- PR対象の3ファイルを自己確認。ローカルリンク10件、コードフェンス、個人パス・資格情報パターン、`git diff --cached --check`を確認。固定版Substrateのremote・SHAとDaemonSet/hostPort/hostPathを照合し、公開URLを修正した。
- 認証境界とEKS要件の既存の独立レビューを再利用。実環境の試験やMermaid描画の自動検証を行ったことにはしない。
- 既存CIは`ax-local/**`等のパス限定で、今回の文書変更は対象外。PRのchecksは0件、mergeable、CLEANを確認後、対象HEADを指定して通常のsquash mergeを実施。admin bypassは使用していない。
- 公開版への参照とマージ結果をOKF `knowledge/ax-agent-platform-direction`に反映。`validate --strict --drift`：28 concepts、error/warning/broken link/orphan 0、gate passed。
- アプリ試験・モデルAPIへの送信・AWSリソース作成は今回実施していない。新たな実装や費用の発生するモデル実行は開始していない。

## 次に進む単位

最初の候補はW1だけ（0.5〜1人日）。React Router Framework ModeのSSR/BFFとHono/TypeScript共通APIをローカルで起動し、ブラウザ→BFF→共通APIの疎通を確認する。AXは模擬応答を使い、実AX接続・モデル呼び出しはW1の完了条件にしない。

再開時の最初の操作は、`git status --short`とHEADを確認し、上記の公開設計・概算、およびOKFの費用・PRルールを読むこと。その上でW1のディレクトリ配置・起動方法・入出力と最小の検証条件を決める。今回の公開許可に含まれない新しい未追跡ファイルは、内容を確認してからstageする。

W2以降は既存Python処理を共通バックエンド内部で再利用する前提の概算。ファイル台帳・ロック、HTTP二重送信、開始の結果不明、API再起動、通信遮断・Task停止の失敗を扱う設計が必要。SSRの描画やGETから実行を始めない。Web土台の完成とAX接続の完成を区別する。

## 維持する条件と未決事項

- モデル利用上限・前払い各2,000円は使い切る予算ではない。無駄な反復送信は禁止。まず送信なしで調べ、既存の費用台帳・使用量不明時の停止・失敗後の再実行制限を維持する。秘密値を出力しない。
- ローカルは単一利用者・単一backend・同時1件。公開前の認証がない状態ではloopback、ローカルsession・要求元検証・CSRF対策を前提にする。
- Hono、Keycloak、AWS配置は仮案。CognitoやEntra IDとの連携も将来の選択肢。RAG、記憶、MCP、追加モデル対応、AWS構築はW1に含めない。
- クラウド適合・本番運用・クラウド費用は未検証。RDSは将来案で、現在はローカルファイル台帳。
- 今回起動したバックグラウンド処理はすべて終了。既存の子エージェント3件はcompletedを確認した。既存Docker/kind等は変更・停止しておらず、この引き渡しで稼働状態を再検査していない。
- 自動再開、リマインダー、別チャットの作成は行っていない。

内部の経緯は [元の設計記録](../tasks/ax-web-architecture/design.md) と [元の概算記録](../tasks/ax-web-architecture/estimate.md) に保持し、今後の設計・見積もりの更新先は公開版とする。
