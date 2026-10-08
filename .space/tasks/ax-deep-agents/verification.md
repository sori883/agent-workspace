# 登録スキルのファイル保存・搬送の検証

対象は `498abb96` を基点とする `codex/skill-file-storage` の未コミット差分。2026-10-08に、保存設計の先行実装を確認している。Deep Agents本体への切替・新モデル接続・大容量の入出力移行は今回の合格対象に含めない。

## 保存と復元

- [専用RustFSの検証](../../../ax-local/object-storage/verification.md)：固定1.0.1、匿名アクセス拒否、用途別の最小権限、条件付きPUT、コンテナ再作成後の原本・IAM保持、バックアップ復元。kind内からのHTTP到達も確認。
- [管理APIとデータ層](evidence/storage-data.md)：専用PG schemaによる予約・再送・CAS・権限失効・不変版・欠損と破損拒否。実RustFSを使った署名付き保存・公開・読み戻し。
- [PGと原本の対整合復元](evidence/storage-paired-restore.md)：43表37行と共有・本人用2定義の10 objectを削除・復元。全行・本文・hash・認可metadata一致。PGだけの復元では原本欠損を拒否。同じPC内の復旧確認で、別媒体への保全ではない。

## 自動・ブラウザ回帰

Nodeとworkerdの同一API経路で保存・公開・読取が成功。workerdでは `Request.redirect='error'` を使えず接続失敗したため、`manual`で応答の3xxを拒否する方式に修正した。リダイレクト先へは追従しない。

全Web試験は最初212件中210成功、1skip、1失敗。失敗はschema版の期待値が9のままだった点であり、11へ更新後に該当Workspace22件は成功。追加修正後の一括試験は218件中217成功、実ストレージ明示実行用1skip、失敗0。Node/workerdの7件を含む。保存担当の単独再試験で起きたmigration lock timeoutは準備段階の競合であり、この直列の全体実行では解消した。実RustFS試験は別に成功済み。型検査・production build・ブラウザの登録回帰5件も成功した。

固定SDKを含むDockerイメージ・ネットワークなし・capabilitiesなしで、Runtime34件を全成功（skipなし）。ファイル原本の主本文と補助資料を、実SDKと模擬mailboxで読込み、資格情報をpromptへ含めずscriptを実行しない経路を含む。初回30件の成功後、パス・容量・BOM・終了処理の修正を加えた最終版で再実施した。

Go設定の資格ファイル権限、ローカルHTTPの明示例外、旧回答待ちimageの許可されたAdapterへの振り分けも局所テストで確認した。

## 独立レビューと対応

保存の作成者とは別のgpt-6-astra担当と、gpt-6.1-sol担当が相互の指摘を見ずにレビューした。Aは保存・認可・復元、BはAPI・Go・Runtime・SQLを中心に担当。各報告の対象は作業中の差分であり、実AX配備の確認を代替しない。

| 指摘 | 対応 |
| --- | --- |
| A：読取中の管理者降格後も未公開draftを返す | 最終の編集権限を確認し、失効時は本文を返さない回帰を追加 |
| A：ストレージ未設定でも公開commitが先に進む | 原本を読む前に公開候補を取得し、外部原本に接続できなければ確定前に停止 |
| A：公開確定後の本文取得中に所属が失効する | 本文返却前に公開版の現在認可を再確認。確定した版は保持 |
| B：復元後promptが40KiBを超える | 実ファイルから復元してモデル送信前に計測。確定した入力超過として0使用量・通常停止にする修正・回帰試験・独立再レビュー済み |
| B：ファイルとフォルダのパスが衝突する | 保存入口とRuntimeでprefix衝突を拒否する修正・回帰試験・独立再レビュー済み |
| B：補助ファイル先頭BOMが消えてhash不一致 | 復号時にBOMを保持する修正・回帰試験・独立再レビュー済み |

## 実AXで発見した終了処理の不具合

最初の無料previewは保存・公開・搬送・SDKへの本文投入・結果回収が成功したが、AXのSuspendが失敗した。ateletはUID0/GID0・capabilitiesなしで動作し、同UIDのskillディレクトリ0555内のファイルを削除できなかった。snapshot保存とworkload終了後にresetActorDirsで失敗したため、単純なSuspendの再送も既にないpauseコンテナを停止できず失敗した。結果・使用量はPGに確定済みであり、resume/start/モデル送信は再実行していない。

ファイル0444は維持し、ディレクトリを0700へ修正した。同UID ownerに対する0555は改ざん防止の独立した境界ではなく、毎回のhash・サイズ・no-follow・hardlink拒否がモデルへ渡す本文の検査になる。stage・seal・開始後cancel・完了後の削除回帰、ファイル差替えの拒否を追加し、B担当が独立確認した。Goの停止応答不明回復も、保存済結果を保持しモデルを再送しない回帰を確認した。

## 既存データ移行と初回試験の復旧

受付とWeb/API・旧controllerを止めてapp PG dumpと原本bucketを対で保全し、schema 9から11と限定関数権限を適用した。既存root20・segment33・run52・公開版9・定義5、合計119行は追加互換フラグ以外の全内容hashが一致した。全20rootは旧context互換のまま、回答待ちに必要な2種類の旧runtime imageをallowlistへ保存した。

初回試験のActorは、Substrateのworker全assignmentと全AtespaceのActor逆参照を照合し、確認用Actorだけと確定した後に、そのworker Podを通常削除した。workersyncによるCRASHED・worker割当解除を確認し、正式RevertActorとSuspendTaskでSUSPENDEDへ回復した。直接DBでActor状態を作り替えていない。元controllerの終了と通信経路退役・操作の終結、正式APIによる停止・egress拒否を確認して、元generationのrecoveryを許可した。保存済result/usageを再利用して依頼はstopped、runはresolved、未解決runは0になった。再開・新しいモデル操作は行っていない。管理用の一時tokenファイルとport-forwardは撤去した。

## 修正版の実AX確認と引渡し

[最終確認の記録](evidence/storage-local.json)。修正版runtimeの新しい依頼で、実Keycloakへのログイン→本人用合成スキル登録→公開→明示選択→無料previewを1回開始→回答待ち→画面から停止→スキルの利用終了が成功した。PGの定義は原本参照のみ、descriptorはcontext v2のmetadataのみ、実際のモデル操作mailboxには原本由来の合成指示が入っていた。公開版やdescriptorへ秘密の接続設定を含めていない。

Go controllerの保存した結果・cleanupに加えて、独立したinspectでAX Suspended・Actor SUSPENDED・worker未割当・egress拒否を確認した。2件の合成スキルは利用終了にし、元からあった定義は変更していない。受付はopen、AI接続は有効、未解決runと使用中slotは0。修正後のPodはcontrollerの再起動なしで処理を終えた。

今回の外部モデル呼出しは0件。previewの固定応答による配線確認であり、モデルの判断精度・指示追従の確認ではない。料金上限と通常利用のAI接続方針は変更していない。保存実装のSS-01〜04はこの結果で受け入れ対象とし、Deep Agents移行のDA-01〜07は未完了のまま保持する。

登録済みの旧JSON版は保持し、次の下書き保存で原本方式へ移る。大きい入力・成果物の保存先変更、本番クラウド提供元の選定・遠隔バックアップ・Deep Agents本体への切替は今回の対象外である。
