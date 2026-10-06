# ax
* [AXの単発CLIで開始・成果物・使用量を分離して管理する](single-task-cli.md) - 1実行1Task、WebとCLI共通の永続受付・排他、再送・未知使用量・未確認の再開始を止める設計と検証結果
* [会話の各往復を既存receipt付きAX実行として保存する](chat-turns.md) - 短い会話をreceipt連鎖と成功成果物から復元し、再送・費用・履歴上限を既存CLIで守る設計
* [認証窓口をKeycloakへ集約し内部利用者IDで会話を所有する](auth-foundation.md) - PostgreSQLの配置先を固定せず、メール・パスキー認証、用途別DBと既存receiptの所有権を分担する未実装の設計
