# AX code profile: P1 patch と局所検証

2026-10-07、担当 A。対象は `codex/agent-workbench` の未コミット差分。既存設計と HQ1 を引き継ぎ、固定 code image の cold start と host quota lifecycle を実装した。AX Actor の配備・実動作、8 MiB 搬送、公開 cleanup 証拠は、この単位の合格に含めない。

## 成果物と固定版

- `ax-local/patches/code-runtime-ax.patch`: AX `ac2332829f22360ff97b0ba34d94dd0dd782f17e` に、既存 `credential-free-atespace.patch` の後から適用する。
- `ax-local/patches/code-runtime-substrate.patch`: Substrate `944abe3278b895ccbf5d45555a49dd0f2f6ceae7` に適用する。
- `prepare-code-runtime.sh`: 固定上流を別 directory へ archive し、上記を重ねる。共有 `.sources/` は編集しない。
- `verify-code-runtime.sh` と `code_runtime_*_test.go.txt` 8 ファイル: 再構築、Go race、Linux 固有試験、Linux binary build。
- `Dockerfile.code-ax-server`、`Dockerfile.code-substrate`: 固定 base image のビルド入口。今回 Docker image はビルド・公開していない。

| 成果物 | SHA-256 |
| --- | --- |
| code-runtime-ax.patch | `f8f7b17a42f0002b192bc3d000f3f7842f1e5a875af89b976b4f70cb665a5fd4` |
| code-runtime-substrate.patch | `12294893a3b8fca834d723372f87d2ed8b82d8745f85b300b9796f47d6b3fae0` |
| prepare-code-runtime.sh | `6eeb61c611562c1a35c5a0034f9700070ebbda86ccceae1efe30e3cdcb3751aa` |
| verify-code-runtime.sh | `ddd1c40cc41e1c6a8ae7dfd7ec2441a390119242079f932824f8478178e2c0fa` |

## 固定 profile

AX の `AX_CODE_IMAGE` と Substrate の build-time `codeprofile.ImageReference` は、同じ `registry/name@sha256:...` を必須とする。image config ID `6d983...` をこの値へ流用しない。設定欠落、別 image、別 atespace、余分な環境変数・volume・capability・command は拒否する。

- atespace は `ax-code`。`AX_DISABLE_CREDENTIAL_ATESPACES` にも含める。Task の環境は空にし、モデル鍵と `AX_TASK_YAML` を持たせない。
- ActorTemplate の常駐 command は `[/usr/local/bin/ax-task-runner]`。guest ProcessService と readyz を提供する。
- 次単位の TaskSpec/manifest command は `[python3,/opt/ax-code/runner.py,wait]` とする合意で、常駐 command と区別する。今回の patch は TaskSpec.command の専用 validator や新 runner CLI をまだ持たない。
- sandbox は `gvisor-default`、1 CPU / 384 MiB、guest PID 上限候補は 64。trusted parent の cap は KILL / SYS_CHROOT / SETUID / SETGID / SETPCAP のみ。未信頼 child の全 cap 0 と既存制限は変更しない。
- cold start 専用。code template の golden 作成を skip し、SourceTag、snapshot を持つ Resume、RestoreWorkload、FULL checkpoint、同 Actor UID の再実行を拒否する。

quota は今回の小さい `host-quota-v1` の値を維持する。アップロードの 8 MiB 上限と同一視しない。

| mount | bytes | inodes | uid:gid | mode |
| --- | ---: | ---: | --- | --- |
| input | 65,536 | 16 | 0:0 | 0755 |
| tmp | 8,388,608 | 128 | 65532:65532 | 0700 |
| output | 1,048,576 | 32 | 65532:65532 | 0700 |
| state | 65,536 | 32 | 0:0 | 0700 |

ateom は自分の mount namespace で tmpfs を作り、size/inodes/owner/mode/空状態と nodev/nosuid/noexec を検査する。OCI には固定 bind mount として渡す。通常 Volume API と mount propagation は変更しない。設定不一致時は runsc create 前に停止する。runsc は既存固定 `gvisor-a64916f9813ce7e4841a30480a599337f7dda07b421c6bf0123db2212aa7d1df/runsc` のみ。

## HQ1 と cleanup

1. worker は起動時に node 共通 BasePath 内の worker UID lock を取得し、終了まで保持する。世代 UUID を生成し、lock 取得済みの完全な marker を atomic に公開してから mount へ進む。作成途中の一時ファイルを孤児 marker と判定しない。
2. marker は actor UID / worker UID / 世代 / image digest / profile / bundle path だけを保持する。受付、認可、費用、再送権の正本は PG のまま。
3. node 上の未完了 marker の worker lock が取得可能なら、旧 worker の状態が不明として code・通常 Runtime・golden を含む新規受付を閉じる。正常な別 worker の生存 lock は妨げない。自動 takeover や PID だけの生存判定はしない。
4. atelet は actor lock と node/worker/actor guard を `resetActorDirs` より前に実施する。code Terminate の NotFound だけでは削除成功にしない。
5. code 停止は networking 閉鎖、runsc guest/pause delete、list 空、worker 内の残存 executable process なし、quota の通常 unmount、bundle mount の通常 unmount、readback、network cleanup の順。失敗した段階より後へ進まない。lazy detach は使わない。
6. process 不在確認は worker が private PID namespace の PID 1 であることを要求する。`/proc` に別 executable があれば hold。名前を変えた sentry/gofer を見逃す名前照合は使わない。外部診断 exec が残っている場合も保守的に停止証拠を拒否する。
7. 全完了後に immutable な `.done` を保存して `.pending` を消す。`.done` は同 actor UID の再利用を拒否する。marker の自動削除・旧世代の自動復旧は実装しない。

Run 失敗、正常 Terminate、DATA checkpoint 後、graceful shutdown に同じ code cleanup を適用する。途中失敗は marker を残し、正常終了や worker 空きに読み替えない。公開 `ActorStatus.code_cleanup` は次単位であり、このローカル marker を controller の停止証拠として公開済みとは扱わない。

## 再現方法と検証結果

リポジトリ root、Go 1.27.1、既存の秘密を持たない Linux image を使う。検証はネットワークなしの一時 Docker container で行い、稼働サービスへ接続しない。

```sh
CODE_TEST_IMAGE=ax-code-spike:local ax-local/patches/verify-code-runtime.sh
```

macOS では Linux 固有 test binary を cross compile し、指定済み local image の config ID を解決して実行する。今回利用した既存 image は `sha256:6d9837961abc3e28164a7db1ab54d62cd67e222dc4496c195ad98b35099fd8d7`。Linux kernel mount syscall は fake に置換した局所試験であり、実 tmpfs mount / 実 Actor の証明ではない。

- 追加の top-level 試験は 31 件。profile 厳密照合、golden skip、SourceTag/Restore 拒否、正常 Runtime 差分なし、marker 原子公開、生存別 worker、孤児・破損・同 UID 再利用拒否、reset 前 guard、cleanup 順序と各段階の失敗、Linux mount/残存 process の検査を含む。
- AX controller/substrate の race と build、Substrate codeprofile/codequota/ocispec/atelet/controlapi の race を対象にした。既存 credential-free と通常 Runtime の既存試験も含む。
- Linux codequota 全 16 件と ateom-gvisor の既存試験を含む Linux binary、ateapi/atelet/ateom-gvisor の Linux build を検証する。
- 初期実装では protobuf field 名と OCI pids 型の compile error が発生し修正した。atelet の一時 directory を使う既存 2 試験も失敗し、quota root の導出と「marker root 不在の読取りでは作成しない」処理に修正して解消した。
- 上記 SHA の最終版で再現スクリプトは終了コード 0、全対象成功。終了行は `Code profile local verification passed. No AX Actor or host mount lifecycle was exercised.`。最終実行ログは作業用 `/tmp/ax-code-verify-final.log`（永続成果物ではない）。共有 AX/Substrate `.sources/` はどちらも差分なし。

親の direct runsc 12 契約試験と nodev 実効確認は [runsc-probe.md](runsc-probe.md) を参照する。その確認は launcher/image の証拠で、この新しい AX/worker patch の実 Actor 成功とは別である。

## 実 Actor 担当への引き渡し

```sh
ax-local/patches/prepare-code-runtime.sh /absolute/new/source-directory
```

生成された `ax/` と `substrate/` を build context とする。Substrate Dockerfile の `COMPONENT` は ateapi / atelet / ateom-gvisor、`CODE_IMAGE` は親が確定する registry manifest digest。3 binary に同値を埋め込む。AX は同値を `AX_CODE_IMAGE` で指定する。実 worker の SPIFFE 起動引数を失わない配置は親の所有とする。

以下を満たすまで code 経路を開放しない。

1. manifest digest を確定し、code runner image と全 binary の固定値を照合する。今回 Dockerfile は未ビルドなので、実 build と image の確認が必要。
2. 5 cap のままで常駐 runner が port 80 を bind できるか、固定 runsc で確認する。失敗時は cap を無断追加せず、設計へ戻す。
3. worker が private PID namespace の PID 1 であり、cleanup 時に他 executable が残らない配置を実測する。必要な worker が未対応のまま同 node に混在して code を受け付けないよう配置を固定する。
4. 実 Actor で 4 quota の値/flags、runsc stop、worker 未割当、host mount 解除、次 Actor へのデータ非継承を確認する。mount 途中、ready 前、終了後、unmount、checkpoint、worker 急死・再起動の失敗時に新規受付が閉じることを確認する。
5. code の golden/SourceTag/restore 拒否と、通常 Runtime の snapshot/cleanup が維持されることを実 Actor で確認する。
6. 後続の 8 MiB chunk staging と公開 cleanup 証拠を実装・検証する。今回の小 profile と公開証拠なしの版では Runtime→code→Runtime の完了判定を有効にしない。

この記録は P1 の実装と局所検証の引き渡し。親の全体受け入れ、配備許可、任意コードの実運用合格を代行しない。OKF 更新と稼働操作は親が担当する。
