# 導入に使った手順

既存の `ax-local` kindクラスタと専用kubeconfigを使う。以下は2026-10-05に実行した手順を整理したもの。クラスタを消してゼロから復旧する試験は行っていない。通常のTask操作は [README](README.md) を使う。

## 固定したソースとツール

前提はDocker Desktop（ARM64）、mise、kind 0.33.0、kubectl 1.36.4、Git、Python 3、ripgrep（`rg`）。上流ソースと生成CLIはGit対象外のため、別環境では次のコミットを取得してからビルドする。既存checkoutを変更する場合は、未保存の変更がないことを先に確認する。

| checkout | リポジトリ | コミット |
| --- | --- | --- |
| `ax-local/.sources/ax` | https://github.com/google/ax | `ac2332829f22360ff97b0ba34d94dd0dd782f17e` |
| `ax-local/.sources/substrate` | https://github.com/agent-substrate/substrate | `944abe3278b895ccbf5d45555a49dd0f2f6ceae7` |

Substrateの版はAXのgo.modの依存版に合わせた。汎用ツールはmise、生成するCLIは `ax-local/bin/` に置く。以下はリポジトリのルートから同じシェルで実行する。cloneはソースがない場合だけ行う。

```bash
workspace_root="$PWD"
mkdir -p ax-local/.sources ax-local/bin ax-local/.state
git clone https://github.com/google/ax.git ax-local/.sources/ax
git -C ax-local/.sources/ax checkout ac2332829f22360ff97b0ba34d94dd0dd782f17e
git clone https://github.com/agent-substrate/substrate.git ax-local/.sources/substrate
git -C ax-local/.sources/substrate checkout 944abe3278b895ccbf5d45555a49dd0f2f6ceae7
mise install --cd ax-local
bash ax-local/with-env.sh bash ax-local/scripts/prepare-registry.sh
```

`ax-local` クラスタと `ax-local/kubeconfig` が既にあることが前提。新規環境ではレジストリの準備より先に `kind create cluster --config ax-local/kind.yaml --kubeconfig ax-local/kubeconfig` で作成し、`chmod 600 ax-local/kubeconfig` を実行する。既存クラスタにはcreateを再実行しない。

レジストリは `127.0.0.1:5001`、kind内では `kind-registry:5000`。既存クラスタを作り直さず接続する。

## SubstrateとHTTPSゲートウェイ

```bash
cd "$workspace_root/ax-local/.sources/substrate"
bash ../../with-env.sh bash hack/install-ate-kind.sh --deploy-ate-system --rollout-timeout=600s
bash ../../with-env.sh bash hack/install-ate-kind.sh --deploy-atenet --experimental-use-sdsmint --rollout-timeout=600s
bash ../../with-env.sh go build -trimpath -o ../../bin/kubectl-ate ./cmd/kubectl-ate
bash ../../with-env.sh go build -trimpath -o ../../bin/set-egress ../../scripts/set-egress.go
```

既存クラスタを削除する `create-kind-cluster.sh` は使用しない。

## AXサーバーとワーカー

```bash
cd "$workspace_root/ax-local/.sources/ax"
bash ../../with-env.sh go build -trimpath -o ../../bin/ax ./cmd/ax
set -o pipefail
bash ../../with-env.sh kubectl kustomize ../../deploy --load-restrictor=LoadRestrictionsNone |
  bash ../../with-env.sh ko resolve -f - > ../../.state/ax-resolved.yaml
bash ../../with-env.sh kubectl apply -f ../../.state/ax-resolved.yaml
bash ../../with-env.sh kubectl rollout status -n ax-system deployment/ax-server --timeout=180s

cd "$workspace_root/ax-local/.sources/substrate"
bash ../../with-env.sh ko resolve -f ../../deploy/workerpool.yaml > ../../.state/workerpool-resolved.yaml
bash ../../with-env.sh kubectl apply -f ../../.state/workerpool-resolved.yaml
bash ../../with-env.sh kubectl rollout status -n ax-demo deployment/ax-local --timeout=180s
```

Kustomizeの読込範囲を広げるのは、固定した公式ソースのax-server.yamlをローカル設定から参照するため。RedisのDeployment/Serviceは公式deploy/redis.yamlから取得し、重複するNamespace文書を除いた。上流ソースのコードは変更していない。

## ARM64のrunner

```bash
cd "$workspace_root/ax-local/.sources/ax"
bash ../../with-env.sh env GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o ../../bin/ax-task-runner ./cmd/ax-task-runner

cd "$workspace_root"
bash ax-local/with-env.sh docker build --platform linux/arm64 -t localhost:5001/ax-task-runner:ac2332829f-arm64 -f ax-local/runner/Dockerfile ax-local
bash ax-local/with-env.sh docker push localhost:5001/ax-task-runner:ac2332829f-arm64
```

初回の生成digestはversions.jsonに記録した。再ビルドでdigestが変わった場合は、`runner/Dockerfile.local-trust` のFROMを今回のdigestへ更新してから次へ進む。ベースイメージとAntigravityの版は固定しているが、APT・Pythonの間接依存を含む全ビルド入力を完全固定したものではない。

```bash
bash ax-local/with-env.sh kubectl get clustertrustbundle egress-mitm.ate.dev:mitm:primary-bundle -o jsonpath='{.spec.trustBundle}' > ax-local/.state/egress-ca.crt
bash ax-local/with-env.sh docker build --platform linux/arm64 -t localhost:5001/ax-task-runner:ac2332829f-arm64-local-trust -f ax-local/runner/Dockerfile.local-trust ax-local
bash ax-local/with-env.sh docker push localhost:5001/ax-task-runner:ac2332829f-arm64-local-trust
```

この派生イメージには公開CAと、費用を抑えた試験用の `runner/model-smoke.py` が入る。専用dockerignoreでキーの保存ファイルを除外している。生成digestを確認し、変更があれば `tasks/*.yaml` とversions.jsonを更新する。2026-10-05のモデル試験用イメージはversions.jsonの `runner_budget` に記録した。Taskはdigestを指定しているため、タグをpushするだけでは使うイメージは変わらない。証明書検証を無効にする設定は使わない。

以後はREADMEのTask起動・ログ・通信確認を行う。既存のイメージがレジストリに残っていれば、毎回の再ビルドは不要。

## モデル試験のオフライン確認

プロジェクトルートで、versions.jsonのrunner_budgetを使って実行する。実キーと外部ネットワークを使わず、ローカルスタブだけでSDKを動かす。

```bash
runner_image=$(python3 -c 'import json; print(json.load(open("ax-local/versions.json"))["runner_budget"])')
bash ax-local/with-env.sh docker run --rm --network none \
  --mount "type=bind,src=$PWD/ax-local/runner/verify-model-smoke.py,dst=/tmp/verify.py,readonly" \
  --entrypoint python "$runner_image" /tmp/verify.py
```

7ケースがpassedになり終了0となる。試験対象は固定したイメージ内のmodel-smoke.pyで、ホスト側の未ビルド変更を検証したことにはならない。実モデルの試験は通信許可後に通常Actorへstartを1回だけ渡し、result・exit-status・verified・usageを確認して通信をdeny-allへ戻す。成功済みTaskの再開ではモデルを再実行しない。

## タスクCLI用イメージ

初期試験で使ったrunner_budgetイメージを土台に、指示と入力を受け取る実行コードを追加する。以下はリポジトリのルートで実行する。別環境で土台をビルドした場合は `runner/Dockerfile.task` のFROMもそのdigestへ更新する。

```bash
bash ax-local/with-env.sh docker build --platform linux/arm64 \
  -t localhost:5001/ax-task-runner:task-cli \
  -f ax-local/runner/Dockerfile.task ax-local
bash ax-local/with-env.sh docker push localhost:5001/ax-task-runner:task-cli
bash ax-local/with-env.sh docker image inspect localhost:5001/ax-task-runner:task-cli \
  --format '{{json .RepoDigests}}'
```

取得したdigestを `versions.json` の `runner_task` へ設定する。新しいCLIはこの値を使ってTaskを作る。通信設定の読戻し確認を使うため、`set-egress.go` を変更した場合は上のSubstrate手順で `bin/set-egress` も再ビルドする。

```bash
runner_image=$(python3 -c 'import json; print(json.load(open("ax-local/versions.json"))["runner_task"])')
bash ax-local/with-env.sh docker run --rm --network none \
  --mount "type=bind,src=$PWD/ax-local/tests/verify_task_sdk.py,dst=/tmp/verify-task-sdk.py,readonly" \
  --entrypoint python "$runner_image" /tmp/verify-task-sdk.py
```

外部ネットワークと実キーを使わず、イメージ内のSDKとHTTPスタブで12ケースを確認する。人工的な使用量は実API利用として数えない。ホスト側と共通の実行処理は `python3 -m unittest discover -s ax-local/tests -p 'test_*.py' -v` で確認できる。
