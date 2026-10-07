# ax
* [AXの単発CLIで開始・成果物・使用量を分離して管理する](single-task-cli.md) - 旧ファイル構成での設計理由を保持し、現在の共通API・PostgreSQL移行と維持する契約を示す
* [会話の各往復を既存receipt付きAX実行として保存する](chat-turns.md) - 旧ファイル構成での設計理由を保持し、現在の共通API・PostgreSQL移行と維持する契約を示す
* [認証窓口をKeycloakへ集約し内部利用者IDで会話を所有する](auth-foundation.md) - Keycloak認証と内部利用者ID、共通API・PostgreSQLでの所有権、外部DB接続の設計と履歴
* [共通APIと実行管理を分離しPostgreSQLへ保存する](portable-api-postgres.md) - 共通APIのホストPython依存を外し、app PostgreSQLと独立した実行管理へ移行した境界・理由・復旧制約
* [組織への所属を権限と業務ロールの境界にする](workspace-access.md) - 複数Workspace・Group所属、現在所有50個と承諾式譲渡、管理権限・業務ロール、本人限定データの契約と採用理由
* [AX Task内の対話型ランタイムと外部の制御基盤](agent-runtime.md) - AX内Runtimeと外部の認可・秘密・費用、実モデル接続・停止・継続の条件
* [本人用作業ファイルをPostgreSQLで分割保存し不変確定する](work-files.md) - CSV・Excelの私有ファイルについて保存上限、再送と確定、所属失効時の予約回復を定めた理由と実装範囲
