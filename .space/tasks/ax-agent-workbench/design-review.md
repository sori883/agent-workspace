# Workbench候補の独立比較

2026-10-07、担当`w1_design_review`。基点`ede929ea87af8173af128e7b8706c11d1a9b16f6`、branch `codex/agent-workbench`。候補作成に参加せず、親の採用見解を受けずにtaskとA/B本文を比較した。同じモデルによる別担当の比較であり、異モデルの独立検証ではない。実装・稼働・課金操作は行っていない。

読取り版のSHA256はA `d06001411995589a9363fe15c027d47a5456be2abaf896722ad0e133eee515ab`、B `445a40fe9eb1ed7812d7a3fbf678cf797546d7d62e3f8bd7056c7d502dad7a23`。隔離については先行する[コード調査](isolation-investigation.md)を再利用した。

## 推奨

**初期はAを土台にすることを推奨する。** 小さなCSV/XLSXを上限付きで扱う段階では、bytes・版・本人認可・成果確定をPGへまとめる方が、DBとobject間の確定漏れ、二重backup、GC競合を増やさず利用経路を作れる。CSV/Excelであることだけでは外部object storage必須とはならない。Aの8MiB等は未採用の候補値であり、必要な実ファイルが収まることとPG/WAL/転送時間を先に測る条件付き。大容量・保存件数がこの枠を超える要件ならBが優位になる。

| 比較軸 | 評価 |
| --- | --- |
| CSV/Excelの利用体験 | 両案ともアップロード→集計→本人downloadを隠蔽できる。Bの「固定recipe/scriptを先行、任意Pythonは別ゲート」が初期範囲を明確にする。Aへ取り込める |
| 定義の正本と版 | 両案の不変版・依存閉包・実行時digest固定は適合。AはPG単独、BはPG参照＋不変object。Bの組込みGit原本とUI複製の区別をAへ取り込むと出所が明確 |
| 私有データ | 両案とも定義共有と入力/結果共有を分離し、依存private版の共有発行を拒否する。個人定義がWorkspace横断かどうかは両案の採用事実ではない |
| AX内Runtimeと逐次code | 両案とも前Taskの実停止後だけ次Taskへ進み、全体枠1・root予算累積・unknown holdを維持。別Taskだけで隔離が完成するとはしていない |
| 整合と復旧 | Aは小さいbytesと業務状態のtransactionが単純。Bはobject先行、孤児GC、欠落hold、DB/blob両方の復元が必要。Bも考慮しているが未選択storeの保証確認が残る |
| 運用負担 | 初期はAが少ない。代わりにPGの保存総量・WAL・backup・保持期間を制限する必要がある。Bは転送/保存拡張に有利だが別の資格情報・GC・backupを常設する |
| 後続拡張 | Bは大きいファイルに向く。Aでもblob ID/manifest/hashとowner認可を保存実装から分ければ、後日の明示移行で置き換えられる。今から両方を同時運用する必要はない |

## 統合で先に閉じる条件

候補本文に重大な自己矛盾は確認しなかった。次は「確認済みの不具合」ではなく、両案が未確認としているため実装・公開判定の前に閉じる必要がある条件である。

1. **code Taskの隔離方式を試作で選ぶ。** 現版はguest UID 0、local control RPC、DNS経路、AX resources未伝播を持つ。資格情報を渡さないだけではRPCを防げない。親runner＋chroot/別UID/seccomp/全資源制限の固定profileを候補にできるが、固定runscの対応・tmpfs総bytes/inode・子孫停止を実Actorで証明するまで生成/登録scriptは公開しない。詳細とtmpfs最小patch案は隔離調査へ記録した。
2. **W1の実行契約を固定集計と任意scriptに分ける。** Bの初期recipeと同案53行の`execute_python{script_blob,...}`、Aの`pythonSourceOrPlan`を、実装時に一つの無条件許可へ潰さない。固定recipeは許可演算・版固定script、自由scriptは別の未開放profile。列確認をフォームで済ませるか、隔離Taskで事前解析するかもtool/時間へ算入する。Compute→Finishは現行2toolに収まるが、追加Ask/再計算を完了済みの「自由な複数段階」と表示しない。
3. **ファイルprofileと保存総量を確定する。** Aでは1回の8MiBだけでなく本人/全体/stagingの総量と保持を制限し、PG復元とbinary downloadの一致を試す。Bを選ぶ場合はobjectの不変write・可視性・GCと受付の競合・DBとblobの一体復元を先に確かめる。どちらも数式・外部link・圧縮展開・文字コード・型の拒否/対応範囲を明示し、silentな値変換をしない。
4. **schedule grantは現在のsession grantの延長にしない。** 両候補の方針を保持し、logout後継続と所属取消後停止を分け、受付だけでなくcode/モデル開始時にも再確認する。既存全owner rootのlogout停止、失効trigger、旧有料run合算guardを新旧protocol全体へ整合させる。変更は追加migration、既存受付bytes/hashと旧v1–v5は保持する。

共有編集/公開者、個人定義のWorkspace範囲、定期の固定/最新入力、無人の費用・期間・回数はユーザー未確定。候補のadmin公開、個人横断/Workspace限定、固定入力、7日等を承認済みへ変えない。この未決は隔離・固定fixture・本人ファイル経路の無課金試作を妨げないが、対応機能の有効化は妨げる。

## 先に必要な無課金試作

1. **固定Actorの隔離**：sentinelを用いた子→親RPC/秘密/別Actor/全socket拒否、親RPC成功、UID/caps、seccomp fail-closed、PID/memory/CPU/disk/inode/log上限、子孫残存と実停止。固定runscでtmpfs optionが無視されないことも確認する。
2. **CSV/XLSXの往復**：代表fixtureの正しい合計・件数、binary hash、境界サイズとzip膨張、二人/二Workspace、失効、upload ACK喪失、未確定staging回収。Aの採用上限・転送時間と90秒内の成立を測る。
3. **模擬モデルのRuntime→code→Runtime**：checkpointと全settle→前段実停止→次段受付の順を確認し、各ACK喪失/退役で再送0・active Actor最大1・累積予算不変を外部台帳と照合する。
4. **定義/予定の実DB境界**：版更新・撤回・依存ACL、並行scheduler・編集と発火・logout継続・除籍再加入・失効と開始競合。模擬時計/無課金Actorを使い、有料Gatewayは閉じたままにする。

比較報告は完了。設計は統合と上記試作へ進められるが、任意Pythonの安全性、無人有料実行の許可、全機能の完成は未確認。OKF・採用決定・全体台帳への反映は親へ引き継ぐ。

## 統合案の後続照合

独立比較を確定した後に`design.md`を読んだ。対象SHA256 `19aac22ed24b85f38a2feeb26a7ca05249cfb6c1225633f24f8f41d9f8a159b9`。A推奨は独立比較と一致。Git原本/UI複製、本人の私有データ、逐次Task、未実証の隔離、未決の利用方針は整合する。6model/8tool（Python3）/300秒/root概算0.01 USD・検証概算0.05 USD、及び入力12,000/出力4,096はすべて未承認の案として扱い、今回の設計終了や既存の低額試験承認を実装・送信許可へ置き換えない。

候補から統合本文へ残す必要がある補足は次の2点。実装細部の新規要求ではなく、既存の信頼・認可境界を複数Taskへ引き継ぐための条件である。

- **57〜65行・成果回収の信頼境界**：両候補にある「codeの出力は未信頼データであり、receipt/usage/権限/checkpointの正本にしない」を明記する。隔離子と子孫の停止後に信頼済みcollectorがbytes・出力manifestを確定し、次Runtimeには確認済み外部checkpointと選別した結果だけを渡す。codeが書く成功フラグやRuntime snapshotをそのまま採用すると、別Taskへ分けても信頼側へ偽の実行状態を持ち込める。
- **55・65〜69・75行・段階間の認可/費用**：モデル送信だけでなくcode開始・次Runtime開始にも、現在の本人/所属・grant/定義利用権・停止・root累積予算を外側で再検証することを明記する。新stepで予算を初期化せず、旧有料runと新workflow/scheduleを同じ全体guardへ数える。未知usage/未精算予約/未停止をholdしたまま、失効後も既送信の精算とcleanupは専用権限で継続する。単に開始時に固定した版/許可を再利用する記述だけでは、待機中の除籍や取消後に新しいTaskを開始できる読み方が残る。

この2点を明記すれば、今回の終了地点である設計・未決事項の具体化として追加の必須不足は確認していない。隔離試作、ファイル上限の実測、利用方針/費用の人間回答は未完了のままであり、製品実装の開始や任意Python公開の可否判定は本レビューでは行わない。
