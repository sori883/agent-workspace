import { Form } from "react-router";
import type { WorkspaceDetail } from "../../shared/workspace-contracts";
import { Csrf } from "./organization";

export function Ownership({ detail, userId, csrf, requestKey, pending, selected = "", invalid = false }: {
  detail: WorkspaceDetail; userId: string; csrf: string; requestKey: string; pending: boolean; selected?: string; invalid?: boolean;
}) {
  const owner = detail.workspace.owner_user_id === userId;
  const transfer = detail.ownership_transfer;
  const recipients = detail.members.filter((member) => member.user_id !== userId);
  const name = (id: string) => detail.members.find((member) => member.user_id === id)?.display_name ?? "現在のメンバー";
  const description = `ownership-recipient-hint${invalid ? " ownership-recipient-error" : ""}`;
  return <section className="org-section" aria-labelledby="ownership-title">
    <h2 id="ownership-title">所有権</h2>
    <p>所有者：{name(detail.workspace.owner_user_id)}{owner && "（あなた）"}</p>
    <p>所有者は1人です。所有権の譲渡と管理者への変更は別の操作です。所有者は譲渡が承諾されるまで退出できません。</p>
    {(owner || transfer) && <p>受取人が承諾すると、その人が所有者・管理者になり、元の所有者は管理者として残ります。業務ロールとグループ参加は変わりません。個人の会話や実行履歴も共有されません。</p>}
    {transfer ? <div data-testid="ownership-transfer">
      <h3>{transfer.to_user_id === userId ? "所有権の譲渡を依頼されています" : "譲渡の承諾待ち"}</h3>
      <p>{name(transfer.from_user_id)} → {name(transfer.to_user_id)}</p>
      <p>承諾期限：<time dateTime={transfer.expires_at}>{transfer.expires_at.replace("T", " ").replace("Z", " UTC")}</time></p>
      {transfer.to_user_id === userId && <>
        <p>承諾すると所有数が1個増えます。すでに50個所有している場合は承諾できません。</p>
        <Form method="post" className="org-form"><Csrf value={csrf} intent="respond_ownership" /><input type="hidden" name="transfer_id" value={transfer.id} /><input type="hidden" name="ownership_action" value="accept" /><label className="org-check"><input type="checkbox" name="confirm" value="yes" required />所有者になることと、譲渡するまで退出できないことを確認しました</label><button className="button button-primary" disabled={pending}>所有権の譲渡を承諾する</button></Form>
        <Form method="post"><Csrf value={csrf} intent="respond_ownership" /><input type="hidden" name="transfer_id" value={transfer.id} /><input type="hidden" name="ownership_action" value="reject" /><button className="button button-secondary" disabled={pending}>譲渡を辞退する</button></Form>
      </>}
      {owner && <Form method="post"><Csrf value={csrf} intent="respond_ownership" /><input type="hidden" name="transfer_id" value={transfer.id} /><input type="hidden" name="ownership_action" value="cancel" /><button className="button button-secondary" disabled={pending}>譲渡申請を取り消す</button></Form>}
    </div> : owner ? recipients.length > 0 ? <Form method="post" className="org-form">
      <h3>所有権を譲渡する</h3><Csrf value={csrf} intent="propose_ownership" /><input type="hidden" name="key" value={requestKey} />
      <p id="ownership-recipient-hint">現在のメンバーから選んでください。申請は7日間有効です。相手にはこのワークスペースの「メンバー・設定」を開いて承諾してもらいます。</p>
      {recipients.length <= 5 ? <fieldset className="org-options" aria-describedby={description} aria-invalid={invalid || undefined}><legend>譲渡先のメンバー<span className="required-label">必須</span></legend>{recipients.map((member) => <label key={member.user_id}><input type="radio" name="to_user_id" value={member.user_id} defaultChecked={selected === member.user_id} required />{member.display_name}</label>)}</fieldset> : <div className="run-field"><label htmlFor="ownership-recipient">譲渡先のメンバー<span className="required-label">必須</span></label><select className="text-input" id="ownership-recipient" name="to_user_id" defaultValue={selected} required aria-describedby={description} aria-invalid={invalid || undefined}><option value="">選択してください</option>{recipients.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</select></div>}
      {invalid && <p className="field-error" id="ownership-recipient-error">現在のメンバーを選んでください。</p>}
      <button className="button button-primary" disabled={pending}>譲渡を申請する</button>
    </Form> : <p>譲渡先のメンバーがいません。先にメンバーを招待し、参加してもらってください。</p> : <p>所有権の譲渡は現在の所有者だけが申請できます。</p>}
  </section>;
}
