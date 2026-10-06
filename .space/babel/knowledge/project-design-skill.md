---
type: knowledge
title: デジタル庁デザインスキルをプロジェクト内で参照する
description: デザインスキルと公式資料をプロジェクト内に配置し、明示したデータ保存先で参照する構成と更新方法
code_refs: 
  - .agents/skills/apply-digital-agency-design-system/
tags: 
  - デザイン
  - スキル
  - DADS
sources: 
  - resource: .agents/skills/apply-digital-agency-design-system/SKILL.md
  - resource: .agents/skills/apply-digital-agency-design-system/NOTICE.md
  - resource: https://github.com/Hideki-Kobayashi/apply-digital-agency-design-system/tree/b03b825a8f362fbe3d17571bdf13ff8f8fa2879e
generated: 
  by: agent:codex
  at: 2026-10-06T01:16:57.795Z
---
# プロジェクト内での参照

2026年10月6日、利用者は次のウェブサイト制作に備えてデジタル庁デザインのスキル導入を依頼し、続けてファイルをプロジェクト内へ置くよう指定した。個人用のスキルフォルダと資料保存先から、`.agents/skills/apply-digital-agency-design-system/` へ移した。

スキルはHideki-Kobayashiによる非公式版であり、デジタル庁による提供・承認を示さない。配布元コミット、公式資料の版と取得元、利用条件は同ディレクトリの `NOTICE.md` と `LICENSE` に記録している。

公式Markdown 145件は `references/dads/current/` に置き、原文を保持する。`SKILL.md` 内の全コマンドは `--data-dir "<skill-root>/references/dads"` を指定する。スクリプト単体の既定値は配布元のまま個人用データ保存先を指すため、この引数を省略しない。PythonスクリプトとUIメタデータは配布元から変更していない。

更新はスキル記載の手順で行う。`ax` は公式ページやZIPを取得するための任意の道具で、2026年10月6日の導入環境では未導入だった。公式ZIPを取得済みなら `--archive-file` で導入でき、保存済み資料の参照には不要。

[成果物の実際の動作を確かめる](../principles/prove-it-works.md)に沿って、スキル形式の検証、プロジェクト内資料を対象にしたstatus、移動前後の全ファイルのハッシュ一致を確認した。
