# ax
* [AXの単発CLIで開始・成果物・使用量を分離して管理する](single-task-cli.md) - 1実行1Task、WebとCLI共通の永続受付・排他、再送・未知使用量・未確認の再開始を止める設計と検証結果
* [会話の各往復を既存receipt付きAX実行として保存する](chat-turns.md) - 短い会話をreceipt連鎖と成功成果物から復元し、再送・費用・履歴上限を既存CLIで守る設計
* [認証窓口をKeycloakへ集約し内部利用者IDで会話を所有する](auth-foundation.md) - Keycloakのメール・パスキー認証、内部利用者IDによる所有権、外部DB接続と復元を実装した構成と採用理由
