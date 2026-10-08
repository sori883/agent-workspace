import { data, redirect } from "react-router";
import type { Route } from "./+types/library";
import { definitionListOptionsSchema } from "../../shared/definition-contracts";
import { Notice, Workspace } from "../components/workspace";
import { requireAuth } from "../lib/auth.server";
import { builtinCatalog } from "../lib/builtin-catalog";
import { definitionErrorMessage, definitionKindLabel, definitionVisibilityLabel } from "../lib/definition-copy";
import { definitionsClient } from "../lib/definitions.server";
import { RunApiError } from "../lib/runs.server";
import { pageHeaders } from "../lib/security.server";
import { scopeHref } from "../lib/workspace-scope";
import { requireWorkspaceScope, workspaceTitle } from "../lib/workspace-scope.server";

export function meta() { return [{ title: "スキル・エージェント | AX ワークスペース" }]; }
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const scope = requireWorkspaceScope(request);
  if (!scope.workspaceId) throw redirect("/workspaces");
  const query = new URL(request.url).searchParams;
  const parsed = definitionListOptionsSchema.safeParse({
    ...(query.get("kind") ? { kind: query.get("kind") } : {}), filter: query.get("filter") ?? "all",
    ...(query.has("before") ? { before: query.get("before") } : {}), include_archived: query.get("archived") === "1",
  });
  if (!parsed.success || ["kind", "filter", "before", "archived"].some(key => query.getAll(key).length > 1)) throw new Response("一覧を最初から開き直してください。", { status: 400, headers: pageHeaders() });
  let result = null, error = null;
  try { result = await definitionsClient(user.accessToken, scope.workspaceId).list(parsed.data); }
  catch (cause) { error = definitionErrorMessage(cause instanceof RunApiError ? cause.code : "api_unavailable"); }
  return data({ result, error, scope, options: parsed.data, workspaceName: await workspaceTitle(user.accessToken, scope) }, { headers: pageHeaders() });
}
export const headers: Route.HeadersFunction = () => pageHeaders();
export default function Library({ loaderData: value }: Route.ComponentProps) {
  const options = value.options;
  function href(next?: string) {
    const query = new URLSearchParams({ filter: options.filter, ...(options.kind ? { kind: options.kind } : {}), ...(options.include_archived ? { archived: "1" } : {}), ...(next ? { before: next } : {}) });
    return scopeHref(`/library?${query}`, value.scope);
  }
  return <Workspace title="スキル・エージェント" intro="標準で使える機能と、自分たちで登録した手順・指示。" workspaceName={value.workspaceName}>
    <section className="org-section" aria-labelledby="builtin-heading">
      <h2 id="builtin-heading">標準で使える機能</h2>
      <h3>{builtinCatalog.defaultAgent.name}</h3>
      <p>{builtinCatalog.defaultAgent.description}</p>
      <p><a className="button button-primary" href={scopeHref("/workbench", value.scope)}>標準エージェントに依頼する</a></p>
      <h3>組み込みスキル</h3>
      <p>登録や選択は不要です。以下の条件で自動適用されます。内容は編集できません。</p>
      <ul className="org-cards">{builtinCatalog.skills.map(skill => <li key={skill.id}>
        <h4>{skill.name}</h4><p>{skill.description}</p><p className="field-hint">{skill.when}</p>
      </li>)}</ul>
    </section>
    <section className="org-section" aria-labelledby="definitions-heading">
    <h2 id="definitions-heading">登録したスキル・エージェント</h2>
    <p>スキルは作業の手順、エージェントは指示と使うスキルをまとめた設定です。下書きを登録し、公開すると「この版で依頼する」から使えます。</p>
    <p className="org-private-note">自分だけの設定か、ワークスペース共有を選べます。共有設定を使う場合も、会話・作業ファイル・結果は本人だけが見られます。</p>
    <div className="org-actions"><a className="button button-primary" href={scopeHref("/library/new?kind=skill", value.scope)}>スキルを登録</a><a className="button button-secondary" href={scopeHref("/library/new?kind=agent", value.scope)}>エージェントを登録</a></div>
    <form method="get" className="org-form library-filters">
      <input type="hidden" name="workspace" value={value.scope.workspaceId!} />
      <div><label htmlFor="library-kind">種類</label><select id="library-kind" name="kind" defaultValue={options.kind ?? ""}><option value="">すべて</option><option value="skill">スキル</option><option value="agent">エージェント</option></select></div>
      <div><label htmlFor="library-filter">公開範囲</label><select id="library-filter" name="filter" defaultValue={options.filter}><option value="all">すべて</option><option value="personal">自分だけ</option><option value="workspace">ワークスペース共有</option></select></div>
      <label className="org-check"><input type="checkbox" name="archived" value="1" defaultChecked={options.include_archived} />利用終了した設定も表示</label>
      <button type="submit" className="button button-secondary">絞り込む</button>
    </form>
    {value.error && <Notice title="一覧を表示できません" error><p>{value.error}</p></Notice>}
    {value.result && <>
      {value.result.definitions.length === 0 ? <p>該当する設定はありません。</p> : <ul className="org-cards">{value.result.definitions.map(item => <li key={item.id}>
        <p>{definitionKindLabel[item.kind]} · {definitionVisibilityLabel[item.visibility]}</p>
        <h3><a href={scopeHref(`/library/${item.id}`, value.scope)}>{item.name}</a></h3>
        <p>{item.archived_at ? "利用終了" : item.latest_version ? `公開中（第${item.latest_version.version}版）` : "下書き"}{item.can_edit ? " · 編集できます" : ""}</p>
        {!item.archived_at && (item.latest_version
          ? <p><a href={scopeHref(`/workbench?${item.kind}=${item.latest_version.id}`, value.scope)}>この版で依頼する<span className="sr-only">：{item.latest_version.name}（第{item.latest_version.version}版）</span></a></p>
          : <p className="field-hint">下書きは依頼に使えません。内容を確認して公開してください。</p>)}
      </li>)}</ul>}
      <div className="org-actions">{options.before && <a href={href()}>最初に戻る</a>}{value.result.next_cursor && <a href={href(value.result.next_cursor)}>次の50件</a>}</div>
    </>}
    </section>
  </Workspace>;
}
