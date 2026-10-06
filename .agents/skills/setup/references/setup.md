# プロジェクトへの導入と更新

## 実行するコマンド

`setup`は`bun <このスキル>/scripts/setup.ts`の略記。グローバルコマンドを前提にしない。

```text
setup plan --project /absolute/path/to/project --json
setup apply --project /absolute/path/to/project --json
setup status --project /absolute/path/to/project --json
```

GitHub Copilot in VS Codeでは、各コマンドに`--product copilot`を指定する。

```text
setup plan --project /absolute/path/to/project --product copilot --json
setup apply --project /absolute/path/to/project --product copilot --json
setup status --project /absolute/path/to/project --product copilot --json
```

`--product`は`codex`・`claude-code`・`copilot`を受け付ける。省略時はこのスキルのassets/setup-manifest.jsonに記載された製品を使う。既定と異なる製品は、同じassets内のsetup-manifest.<product>.jsonから読み取る。未同梱の製品や、プラグイン名・版数・製品が一致しないmanifestは拒否する。

| コマンド | 動作 |
| --- | --- |
| `plan` | 同梱内容、前回の管理記録、現在のファイルを比較し、変更予定と衝突を返す |
| `apply` | 全件を事前確認し、衝突がなければ配置・更新して管理記録を保存する |
| `status` | 現在の同梱内容との差、ローカル変更、未完了の適用、ロックの有無を返す |

planとstatusは対象プロジェクトへ書き込まない。初回起動ではスキル自身のscripts/node_modules内に、依存定義の確認結果を記録する。外部依存のない構成なので、パッケージのダウンロードは行わない。Bun 1.4.2以上とscriptsへの書き込み権限が必要。

このスキルのassets/setup-manifest.jsonが、この製品で配置するファイルを指定する。配置元の文書・テンプレートもassetsに含まれる。setupと他のkotoスキルは同じ親ディレクトリに配置する。

## 配置先と保持する内容

| 内容 | 配置先 |
| --- | --- |
| 共通知識・ルール | `.space/babel/`直下のtype別ディレクトリ |
| 同梱されたCodex用のエージェント定義 | `.codex/agents/` |
| Codexの指示 | `AGENTS.md`内の管理ブロック |
| Claude Codeの指示 | `CLAUDE.md`内の管理ブロック |
| GitHub Copilotの指示 | `.github/copilot-instructions.md`内の管理ブロック |
| 前回配置した内容のハッシュ | `.space/setup/<plugin>-<product>.json` |

Claude Codeのエージェントはプラグインのagentsとして提供される。setupではCodexのagents配置先へコピーしない。

指示テンプレートの`{{SKILL_ROOT}}`はsetupと他のkotoスキルが並ぶ親ディレクトリ、`{{BABEL_BUNDLE}}`は利用先の`.space/babel/`の絶対パスに置き換わる。スキルの配置場所が変わった場合もplanで差を確認し、applyで参照を更新する。

指示ファイルでは、次の開始・終了マーカーに挟まれた部分だけを管理する。マーカー外の既存指示、別のプラグインの指示、利用先独自の文書は保持する。

```markdown
<!-- koto:setup:koto:codex:start -->
この製品の指示
<!-- koto:setup:koto:codex:end -->
```

コピー先に未管理の別内容があれば衝突として止める。同じ内容の既存ファイルは管理対象に登録できる。二回目以降は前回のハッシュと現在値を比較する。前回と異なっていても、同じ管理方式で現在の管理部分が今回の同梱内容と完全に一致する場合は、その内容を新版として管理記録へ採用できる。それ以外の管理部分の編集・削除、マーカーの破損・重複は衝突になる。管理ブロック外だけの編集は更新を妨げない。

共有する`index.md`は既存の見出し・説明・独自項目を保持し、不足する項目だけを追加する。配布側の項目が更新された場合、前回配置時からその項目が変わっていなければ更新する。両側で同じ項目が変更された場合は衝突として止める。`log.md`と`LICENSE`は存在しない場合だけ配置し、既存内容やその後の編集を保持する。

配布元からなくなったファイルは`retain`と表示し、利用先から削除しない。管理記録も保持する。ソースと配置先の親方向参照、絶対パス指定、symlink、許可された配置先の外への書き込みは拒否する。

## agent-gearからの切り替え

旧名のプラグインを無効にし、kotoを導入した後、新しい会話でkotoのsetupを使う。対象プロジェクトで`plan`、`apply`、`status`の順に実行する。Copilotでは各コマンドに`--product copilot`を指定する。

kotoの管理記録がまだなければ、同じ製品の`.space/setup/agent-gear-<product>.json`を読み、前回配置した内容を照合する。旧名の管理ブロックはその位置でkotoのブロックに置き換え、ブロック外の指示を保持する。更新後は`.space/setup/koto-<product>.json`を使い、旧管理記録と旧vendor内のファイルは削除しない。タスクとプロジェクト固有の知識も保持する。

旧名の管理記録がない、管理部分が編集されている、新旧のブロックが両方ある、マーカーが破損している場合は衝突として止まる。既存の記録・編集内容を保全してから解決し、管理ファイルを一括削除して再導入しない。

旧名のいずれかの製品にpendingがあれば、先にその元の版で適用を完了する。kotoのapplyは`koto.lock`と`agent-gear.lock`の両方で書き手を排他する。中断後にロックが残った場合も、両方のPID・時刻と全ての書き手の停止を確認してから、残っているロックだけを除く。旧名のsetupへ戻して更新を続けず、以後はkotoを使う。

## 旧vendor配置からの更新

以前の`.space/babel/vendor/<plugin>/`へ導入済みの場合も、新版のplan・applyで`.space/babel/`直下に共通知識を配置し、指示の検索先を更新する。旧vendorのファイルと管理記録は保持し、自動削除しない。配布元にない独自文書は自動移動しないので、旧vendorへ独自に保存した知識がある場合は、必要な文書を確認してBabel側へ統合する。

移行する配布文書にローカル編集・削除がある場合や、Babel側に異なる同名文書がある場合は、全配置を止めて衝突を返す。元の内容を保全し、共通文書へ反映する差分とプロジェクト固有の知識を整理してから再実行する。旧版のpendingが残っている場合は、先にその版で適用を完了する。

## 結果の読み方

通常もJSONを返し、`--json`では一行にする。成功は`ok: true, data`、失敗は`ok: false, error`。dataのactionsにはcreate・update・unchanged・retain、conflictsには配置先と理由が入る。pendingは途中の適用記録、lockedは書き手のロックがあることを示す。

planやstatusの成功は「比較できた」ことを意味し、衝突がないことを意味しない。必ずconflictsも確認する。終了コードは0=処理成功、1=入出力・起動失敗、2=入力・形式・パス違反、3=衝突・ロック・途中失敗。

衝突があるapplyは、配置先を一件も書き換えず停止する。該当ファイルと配布元を比較し、残したい内容を先に保全する。管理状態を消したり、強制上書きしたりして解決したことにしない。必要な差分の統合を決めた後に再実行する。

## 中断と再開

applyは`.space/setup/<plugin>.lock`で同じプラグインの書き手を排他する。稼働中の処理のロックを削除しない。

複数ファイルの配置は一つのファイルシステムトランザクションではない。各ファイルを一時ファイルから置換し、途中の予定を`.space/setup/<plugin>-<product>.pending.json`へ保存する。途中失敗はPARTIALとして、完了した配置先と原因を返す。

再開時は、全対象が「適用前」または「適用後」の内容であることを照合し、残りを適用する。中断後に追加のローカル編集があれば再び止める。pendingは手編集・削除せず、同じ配布版でapplyを再実行する。配布版を変更した場合は、先に元の版で未完了の適用を終える。

異常終了でロックが残った場合は、statusとロック内のPID・時刻を確認し、関連する全ての書き手が停止したことを確かめてから、その`.space/setup/<plugin>.lock`だけを除く。初回起動中は子プロセスがある場合もある。停止が確認できない状態ではロックを奪わない。

同じホストのローカルファイルを対象にする。ネットワーク共有、電源断、別プロセスが同じファイルを同時に編集する状況での完全な一括適用は保証しない。適用中にプラグインのファイルを入れ替えない。

同じプロジェクトへCodex・Claude Code・Copilotの複数製品を導入した場合、Babel内の配布文書は共有し、管理記録は製品ごとに持つ。一方で配布文書を更新し、他方も同じ内容の新版へ更新する場合、既に配置された内容と完全に一致することを確認して管理記録を更新する。異なるローカル編集は上書きせず停止する。製品ごとに別の版を維持する場合も、各製品の配置記録と内容の差を確認する。
