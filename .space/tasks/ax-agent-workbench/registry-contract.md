# Workspace内のスキル・エージェント登録契約

2026-10-07の追加回答を反映した実装単位。既存 `AgentRepository` は実行rootであり、新しい保存層は `DefinitionRepository` として定義の版を所有する。人間が使う表示は「スキル」「エージェント」「共有」で、定義という用語を要求しない。

## 利用例と権限

メンバーは選択中Workspaceへ本人用か共有用のスキル・エージェントを作る。本人用は作者だけが参照・編集でき、Workspace管理者も他人の本人用を読めない。共有用の公開版は現在所属する全メンバーが利用でき、下書きの参照・編集・公開・アーカイブは作者と現在のWorkspace adminだけ。両者ともactive userと現在所属を毎回要求する。Workspaceを越える参照を拒否し、他人の私有IDは404。作者が退出しても共有公開版はWorkspaceに残り、adminが管理できる。

共有するのは再利用する指示・設定・補助資料。実行者の会話、入力ファイル、成果物、結果閲覧権を含めない。私有作業file IDを共有定義に埋め込む専用参照は提供しない。

## 保存と版

- base: UUID、workspace_id、created_by_user_id、kind(skill/agent)、visibility(personal/workspace)、archived_at、created_at。
- kind・workspace・作者・visibilityは作成後不変。共有範囲を変えるときは見える内容を明示複製して新しい定義を作る。既存公開版の権限を途中で書き換えない。
- draft: baseごと1件、revisionは楽観ロック。保存・公開・アーカイブにexpected_revisionを要求し、同時編集で上書きしない。
- published version: UUIDと連番、内容JSON、SHA-256、publisher、公開日時。公開後の内容は不変。run/scheduleはversion IDを固定する。公開済み内容を過去に遡って変更しない。
- 全mutationはownerごとのrequest keyと要求hashで同一再送を扱う。同じkeyの異なる本文は409。公開応答を失って再送しても同じversionを返す。
- archiveは物理削除ではない。新規利用から外す。履歴向けの版参照は残すが、実行の新規認可ではarchivedを拒否する。旧versionの存在は現在の利用許可を保証しない。

## 初期payload

厳密なJSON schemaで未知fieldを拒否する。TS共有型とSQLの境界が同じ制約を持つ。API ownerやworkspaceをpayloadから確定しない。

スキル: `name`（lowercase slug、最大64）、`description`（UTF-8最大1024bytes）、`instructions`（非空、UTF-8最大16384bytes）、`files`（最大16件の `{path,content}`）。補助fileはUTF-8テキストのみ、1件32768bytes、payload全体131072bytesまで。pathはreferences/・scripts/・assets/以下の安全な相対path、親参照・絶対path・backslash・空要素・重複・symlinkなし。SKILL.mdはname/description/instructionsから固定形式で生成し、補助fileとして重複させない。scriptは登録しただけで実行しない。初期UIでbinary添付を受け付けない旨を明示する。

エージェント: `name`（表示名、UTF-8最大256bytes）、`instructions`（非空、UTF-8最大16384bytes）、`skill_version_ids`（重複なし、最大8件）、`allowed_tools`（初期はpythonのみ、空配列も可）。全skill versionは同じWorkspaceの利用可能な公開版を要求する。本人用agentは本人用または共有skillを参照できる。共有agentは共有skillだけを参照できる。私有skillの本文を共有agentの公開JSONへ紛れ込ませない。公開時と実行時の両方で依存の現在利用権を再検査する。

個別の業務文面やscriptは権限の正本ではない。allowed_toolsは製品が認めた道具の範囲だけを狭め、実行権限・費用枠を増やさない。Group別公開、外部公開、任意tool/plugin追加は初期対象外。

## 境界と上限

作成100件/作者/Workspace（archiveも記録として残る）、公開100版/base、定義本文の保存総量128MiB/appを初期上限とし、超過は明示拒否する。ファイル送信のquotaとは別の設定として表記する。DB transactionでdraft置換・公開追加と容量を一緒に判定し、並行要求で抜けない。自動削除で空きを作らない。

一覧はkind/filter(personal/workspace/all)/cursorで最大50件。private draftは本人だけ、shared draftは作者/adminだけ。一般memberの共有一覧は公開版があるbaseだけを返す。アーカイブ済みは編集者の管理画面から見られる。編集できるかをDBが応答へ明示する。

Repositoryの最小操作は list/get/create/updateDraft/publish/archive/getVersion。payload型と返り値型、SQL関数名は保存担当が最初に共有し、API/UI担当が同じ型を使う。公開APIは /v1/definitions と /v1/definitions/:id、draft/publish/archive/version を想定。常にJWT+選択Workspace、BFFではOrigin/CSRF、no-store、本文サイズ上限を適用する。

## 実装と検証範囲

新規schema-v7.sqlを追加しv1〜v6を編集しない。APIロールには定義用の限定関数だけを許可、表やhelperの直接EXECUTEは与えない。既存実行管理用roleへの権限は今回追加しない。controllerの実行用version読取りは統合unitで限定して加える。

保存担当Bはschema-v7.sql、web/data/definitions.ts、web/shared/definition-contracts.ts、web/tests/definitions.test.ts、registry-verification.mdを所有する。共通のdb.ts、permissions.ts、migrate入口、API/UIは親が担当する。試験DBでv7を直接追加してよい。稼働DB/AX/課金/commit/PRは操作しない。

検証は私有admin拒否、共有のmember利用と作者/admin編集、失効・再加入、cross-Workspace、公開版不変、再送とCAS競合、依存の私有混入・archive・跨Workspace拒否、quota競合、旧schemaデータ保持、API role制限。保存成功をエージェント実行成功とは扱わない。
