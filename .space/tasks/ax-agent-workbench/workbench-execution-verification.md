# Workbench execution 検証

- 担当: B / `execution/` の Go 実行管理。基準 `ede929ea87af8173af128e7b8706c11d1a9b16f6`、branch `codex/agent-workbench` の未コミット差分。
- 対象 26 ファイルのパス・SHA256一覧を連結した digest: `fd6d0bfc2151a9fecc3d89ed1f94377bd338e69b847040b2153e757760ad1344`。
- 2026-10-07。稼働 DB、AX、外部モデル、コミット/PR 操作は実施していない。検証のモデルは固定応答または局所 HTTP fixture。

## 実装

- v1 の Request / Result / mailbox と256 output token予算は維持し、v2専用型・claim復号・controller経路を追加。PGが発行したrequest/descriptor canonical SHA、固定Task manifest/image、execution policy、profileを照合する。
- Runtimeはモデル1回・提案1件。Runtimeの実停止とegress deny確定後、PG finishだけが次attemptを作成する。Goは同じ claim/heartbeat/intent/evidence/collect/finish を使い、別queueやAPI再受付を作らない。
- code入出力各4件/8MiB、source4KiB、32KiB chunkを逐次転送。出力はmanifest/hashを照合しPGへbegin/chunk/seal、その後停止とhost cleanupを記録する。結果が不明なStart/settle/output importは再送せず保留。finish ACKのみ同じ完了結果を一度読み直す。
- definition bundleは公開版ID・canonical byte SHAに固定。Runtime metadata入力最大16件、history最大17件/本文合計16KiB、descriptor40KiB。人の回答も含む最新PG契約へ追従。
- Runtimeとcodeは専用atespace/direct mTLS接続。code Task commandは `python3 /opt/ax-code/runner.py wait`、ActorTemplateは上流PID1 `ax-task-runner`。code templateの鍵なしenv、gVisor、固定resources/caps/volumes/snapshot設定を検査する。
- `ActorStatus`のserver-owned field12を既存protoのunknown bytesから上限付き復号する。actor UID、worker UID、UUID generation、固定image digest/profile、cleaned=trueと、Actor SUSPENDED/worker未割当を照合。欠落・重複・異型・画像不一致は成功にしない。SQL証拠はimage fullrefへ写す。
- `workbench`設定は `enabled`, `model_enabled`, `python_enabled`, `code_image`。bool省略はfalse。runtimeは既存interactive設定を使用。modelには既存model_gatewayも必要。実機検証用 `inspect --code` はhost cleanupまで検査する読み取り専用経路。

## 局所検証

- Go 1.27.1 / darwin arm64。`cd execution && go test -race ./... && go vet ./... && go build ./...` 成功。トップレベルtest 93件（subtestを別集計しない）。`git diff --check -- execution` 成功。
- 8MiB入力・8MiB出力をそれぞれ256chunkで転送し、byte SHA一致、PG seal→cleanup→finishの順序を確認。
- Runtime mailbox2回、settle後のみACK、ACK喪失時は保存済同replyだけ再投入、Start ACK喪失/出力ACK喪失で保留、finish ACK喪失は同完了のreadback、heartbeat喪失後の追加副作用禁止を確認。
- code gate閉鎖でCreateなし、入力取得時の権限失効でStartなし/cleanup、host cleanup未確認でslot解放なし、recoveryでCreate/Resume/Start再送なしを確認。
- v1/v2混在拒否、descriptor改変、余分なfield、異なるatespace、提案source/出力名/容量/重複alias、canonical base64/chunk境界、UTF8 literal escapeを確認。v2の512 token拡張がv1へ入らないことも確認。
- Cの専用PostgreSQLで生成した合成claimとagent/skill公開版chunkを `controller/testdata/` へ固定。Goでstrict shape、PG canonical descriptor SHA、公開本文bytes SHAの実値一致を確認。こちらから実DBへは接続していない。

## 統合で確認する事項

- Go期待ACKはstage-begin/stage-chunk=`{run_id,state:'staged'}`、stage-seal='sealed'、code-start='started'。Aからcode runnerをこのshapeへ統一済みとの連絡を受領。status/collect/outputも合意shape。実Actorの結合確認は親が担当する。
- 実Actorの8MiB往復、worker終了・通常unmount・quota mount撤去・永続化完了がfield12へ伝播すること、DB→controller→Runtime→code→新Runtimeの連続経路は親/Aの実機検証へ引き継ぐ。
- 今回のGo試験成功は実Actor隔離・実モデル課金・配備成功の証明ではない。稼働移行とgate開放は親が総合検証の結果に基づいて行う。

OKFは編集していない。既存の単一slot/不明時hold/所有者境界/費用guardを引き継ぎ、今回の知識化は親へ委ねる。

## 追加修正と再検証（同日）

親承認により、結合レビューの2点と層間境界を修正した。変更は `controller/workbench.go` とその試験、`native/workbench.go` / `workbench_protocol.go` と native 試験。最終27ファイルのdigestは `a32cd5f37fa621438419659d6b641e0f55a18d4f99053afd9a29ac744711a915`。冒頭の26ファイル版を置き換える検証結果である。

1. code templateのenvが空のため、AX Resumeだけではtrusted waitは起動しない。Resume intent内で AX Resume → TaskのRunning/Ready読戻し → `ProcessService.StartProcess([python3,/opt/ax-code/runner.py,wait])` を一度だけ送る。残時間を最大300秒のprocess timeoutとして渡し、完了streamは待たない。fixed upstream env の `guest/process/service.go:40` でもStartProcessがRPC contextに依存しないtracker起動であることを読取確認した。Runtimeの起動方法は変えていない。
2. StartProcess ACK時点でready.jsonがまだ無い場合は、code-statusだけをReadyTimeout内で再観測する。Resume/trusted wait/code-startを再送しない。StartProcess ACK不明は保留とし、recoveryでもwaitを再起動しない。
3. 保存成功resultとsealed outputsがあるPython Taskの停止後、cleanup保存ACK喪失やfinish前中断からのrecoveryは実停止を先に観測し、停止済みguestからOutputManifestを読み直さない。egress/停止/host cleanupを再観測してfinishへ渡す。未封印出力の成功判定は引き続きPGが拒否する。
4. 定義はagent0..1＋skill0..8、history17件以下かつcanonical JSONの合計16KiBへ統一。本文だけの長さ判定を残さない。

修正前に `runner_not_ready`、trusted wait ACK不明の保留不足、停止済み出力の `guest_stopped`、準備直後の `ready_file_missing`、9件skill受理を局所回帰で確認。修正後は同じ回帰が成功した。既決Resumeからの再Start拒否も確認した。

最終 `go test -race ./... && go vet ./... && go build ./...` は成功（top-level 101件）。`git diff --check -- execution` 成功。fixed RPC、未確定RPCの単一送信、正常8MiB転送、停止済み回収、旧v1互換までを無課金fixtureで再確認した。新たな実DB/AX/有料送信は行っていない。独立再確認はC、実Actor結合は親へ引き継ぐ。

## probe3 の code 起動前観測を修正（2026-10-08）

親の実AX結果は、Runtime完了後の code Resume intent が未確定のまま、stage未実施で保留になった。`ax-local/.state/workbench-build-arg973la/probe3/worker.log` は guest readyz 200、RunWorkload成功、task commandなしの待機を示す。親のAXログ読取では phase Running / workspaceReady false が確認された。固定上流 reconciler の Ready は worker port 80 へのHTTP観測、又はrouter経由の観測から決まる。採用済みの直接mTLS 443経路の到達性とは異なるため、前節1の Running/Ready 要求はこの構成では不適切だった。

コード区間だけ、起動前条件を Task identity・phase Running と `ObserveCodeProcessService` の読取成功へ変更した。後者は既存 `guestClient` により実Actor RUNNING・worker割当・SPIFFE/mTLSを検証し、固定の未存在process IDへ GetProcessを送る。成功又はNotFoundでサービス実在を確認する。Unavailable、Unimplemented、認証失敗を成功にせず、ReadyTimeout内はこの読取だけを再観測する。trusted waitのStartProcessは従来のResume intent内で一度だけ、ACK不明時は保留を維持する。旧Runtime/v1、TLS条件、Create/Resume/Startの再送禁止は変えていない。

Redでは、AX Ready=falseかつProcessService利用可のケースが `observation_timeout`、ProcessService不可でも開始するケースが `missing process service accepted`、観測を挟まないケースが `readiness retry did not stay read-only` で失敗した。修正後に同じ3件が成功。native側でも読取のみ・actor header束縛、サービス未登録/不可/認可拒否、停止済みActorを起こさない条件を追加確認した。

- `go test -race ./controller ./native ./cmd/workbench-probe -count=1`：104トップレベルtest成功（53 / 39 / 12、subtest別集計なし）。
- 同3 packageの `go vet` と差分チェック成功。
- controller/probe command の `go build` 成功。
- 対象5ファイルのsorted SHA行連結snapshot：`6a23bf908b5cde60930f9c7d79da96e3f86b22d58b88a139583e2a10c8e9e4ea`。対象は `controller/workbench.go`、`controller/workbench_test.go`、`native/workbench.go`、`native/workbench_test.go`、`native/adapter_test.go`。

Go担当は稼働DB/AXへ接続していない。実imageのPID1がTask設定なしでもProcessServiceを登録するかはA/親が別途確認中で、この修正は未登録サービスを成功にしない。実Actorでの再検証と停止確認、Cの独立差分確認は親へ引き継ぐ。OKFは変更していない。

同日の追加確定：Aがcode imageの局所起動で、Task設定なしは readyz成功でもGetProcess=Unimplemented、固定 `server-task.json` をPID1の `--task-file` に渡すとGetProcess=NotFoundとなることを確認した。親承認に従い、Goのcode template validatorは `[/usr/local/bin/ax-task-runner,--task-file,/opt/ax-code/server-task.json]` の完全一致へ変更した。固定JSON・image・AX/Substrate側はA所有。TaskSpecのPython wait、templateの空env、Runtime/v1の起動条件は不変である。JSONはdebugを有効にする起動設定だけで、実runの認可・identity正本として使わない。

新argv受理テストを先に変更し、旧validatorで `valid code template rejected` のRedを確認した。validator更新後は新argv受理・旧argv拒否・書込可能な別path拒否が成功。上記104件/race、vet、両command build、差分チェックを更新版で再実行し成功した。追加した `native/runtime_template.go` を含む最終6ファイルsnapshotは `9984c31c1abb6cd93e6925a1e9aa523bfdfe996febb766a24e242e296b422173`。実Actorの結合結果はまだこの担当の確認範囲に含めない。
