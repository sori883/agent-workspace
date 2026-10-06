---
name: setup
description: Install or update the plugin's common knowledge, agent definitions, and managed instruction blocks in an explicitly selected project. Use when introducing koto to a project, checking its installed files, or applying a plugin update while preserving local instructions and edits.
---

# setup

利用先プロジェクトへ、同梱する共通知識・エージェント定義・指示を配置する。プラグインを導入しただけでは、プロジェクト内の文書は更新されない。

1. 対象プロジェクトと利用製品を特定し、同梱するCLIで`plan --project <対象>`を実行する。GitHub Copilot in VS Codeでは、plan・apply・statusのすべてに`--product copilot`を追加する。利用先を推測して書き込まない。
2. 変更先と衝突を確認する。既存の指示ファイルでは、このプラグインの管理ブロック外を保持する。配置済みファイルのローカル編集は自動上書きしない。
3. 依頼が配置・更新を含み、衝突がなければ`apply`を実行する。調査だけの依頼では`plan`または`status`で報告する。
4. `status`で配置と管理記録を確認し、配置先・保持したローカル文書・残った衝突を報告する。

CLIは`bun <このスキル>/scripts/setup.ts`。Bun 1.4.2以上を使い、`--project`を毎回指定する。配置するファイルはこのスキルのassetsから読み、スキルへの参照はsetupと同じ階層の各スキルを指す。実行時の準備はスキルのscripts内で行い、利用先のpackage.jsonや依存を変更しない。

操作、保存先、衝突時と中断時の扱いは[導入と更新](references/setup.md)を参照する。文書の配置後に、必要な共通知識を読み込んで利用する。ファイルの配置だけで全内容がAIへ読み込まれたとは扱わない。
