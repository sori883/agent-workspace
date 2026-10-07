# 作業単位と統合順

共通の目的と未決事項は[task.md](task.md)、保存・実行の構造は[design.md](design.md)。進行状態と受け入れは `orch/` を正本にし、親が記録を代行する。費用や共有権限の未回答を、時間経過によって承認済みにはしない。

| 単位 | 所有・入力 | 確認する成果と後続 |
| --- | --- | --- |
| design | 親が候補A/B・独立調査・比較を統合 | 保存とAX内実行の骨組み、確定要件と未決事項を区別。既に比較を終え、任意コードの公開は未確認として残す |
| python-spike | A：新規 `ax-local/code_runtime/`、`ax-local/runner/Dockerfile.code`、対応する新規試験・code専用patch案、`python-spike.md` | 鍵なし・chroot/非root・syscall/資源の固定launcherをネットワークなしコンテナで検証。固定runscの内部tmpfsがinode上限を守らないと実測したため、host quota専用profileとdirect runscの再現試験までこの試作に含める。既存Docker profileを緩めない。親が内容を受け入れ、code限定のmount/cleanup/cold startを実装してから実Actorへ進む。稼働AX/workerを担当が変更しない |
| files | B：`file-contract.md`に沿う新規SQL v6、保存クラス、共有型、移行入口、保存試験、`files-verification.md` | 本人用binary upload→seal→同じbytesの読戻しと権限/並行/上限。専用試験DBで確認し、稼働DBには適用しない |
| runtime-integration | 親。上記2単位の受け入れ後 | chunk搬送、code profile、状態保存と逐次Task、結果回収を実AXで確認。固定fixture→模擬model→許可された最少の有料試験の順 |
| registry | 本人用もWorkspace単位・共有作成は全員／編集は作成者と管理者に確定。保存層をBへ割当 | 版付きスキル・agent定義とUI。共有定義と私有実行データを分ける |
| schedules | registryとRuntimeの契約を受け入れ、入力選択と期間/回数/費用を確定後に割当 | sessionから独立したgrant、予定登録/開始/停止、重複防止、ログアウト継続と失効停止 |
| review-delivery | 独立Cが各利用経路の対象版をレビューし、親が受け入れ・統合・納品 | 公開前の必須指摘と実経路を確認し、意味のある利用経路の単位でPRへまとめる。記録更新だけのPRは作らない |

設計の確定範囲と親の納品操作は区別する。各担当は共有コードベースで他者の変更を戻さない。稼働Pod・DB・送信gate・鍵の操作は親だけが扱う。実機試験前に対象image/profile、無課金条件、停止・回収と既存実行の状態を確認する。

最初の2実装単位は、追加の人間回答に依存しない範囲を所有する。両方の完成だけで実作業・複数段階・登録運用の全体を完了とはしない。実Actorの隔離が成立しない場合は、その実測を設計へ戻し、未検証の任意Pythonを製品として有効にしない。

固定runscでの観測は[runsc-probe.md](runsc-probe.md)、host quotaの境界案は[host-quota-design.md](host-quota-design.md)。これは新しい汎用ストレージ機能ではなく、固定code profileの安全性の不足を確かめる試作である。AXへの反映や8MiB入力搬送を完了したとは扱わない。
