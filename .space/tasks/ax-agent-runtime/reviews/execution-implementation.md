# 実行管理・AX patchの確認

2026-10-07。実装担当は w1_design_review、独立したレビュー担当は w1_design_a。親が結果と対象を照合した。対象は `execution/` と `ax-local/patches/` の今回差分。

担当のGo47件、race、vet、buildは成功。AXは固定上流 `ac2332829f22360ff97b0ba34d94dd0dd782f17e` の隔離copyへpatchを適用し、新7件を含むcontroller/substrate race testsとax-server buildに成功した。独立担当も別の一時copyでAX patchの同検証を実行し成功した。

独立担当は送信前Reserve→Gateway応答保存→guest投入の順序、未知Reserve/Settleの再送禁止、ACK再投入時の保存応答との一致、復旧でmailboxを実行しない条件を確認した。AX patchの鍵取得前の注入無効化、default template fallback拒否、Task env/workspace拒否、template比較、crashed Actorの自動復旧禁止も確認し、この範囲の追加必須指摘はなかった。

開始後の既知拒否にresultが伴わない場合、旧PG終了関数がglobal枠を保持するP1を発見した。保存担当がGateway台帳とdeny・実停止証拠から終結する処理を追加し、要求0件・model確定後tool前失効・SDK失敗usage不明の3経路を実PGで検証した。未確定operationは保留する。この修正は保存担当の対象であり、Goのfakeだけを終結契約の合格証拠にしない。

親は作成済imageをローカルkindへ配置し、AX/実行管理とax-runtime workerがReadyであることを確認した。受付を閉じ未解決0の状態で旧offline経路を実行し、診断run `ax-run-6c9ff0f5d969b84a` の成果物回収、egress deny、Actor SUSPENDED・worker未割当、probe成功を確認した。新しいinteractive経路の実AX検証は親unitの未完了条件として残る。

ローカル診断の元記録はGit対象外の `ax-local/.state/runtime-backup-20261007/offline-probe.jsonl`。この診断はDBの通常受付経路を通していない。有料モデル要求は0件。
