import { data, redirect } from "react-router";
import type { Route } from "./+types/library";
import { definitionListOptionsSchema } from "../../shared/definition-contracts";
import { Notice, Workspace } from "../components/workspace";
import { requireAuth } from "../lib/auth.server";
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
  return <Workspace title="スキル・エージェント" intro="作業の手順や、エージェントへの指示を登録する。" workspaceName={value.workspaceName}>
    <p className="org-private-note">このワークスペース内で、自分だけの設定と共有設定を作れます。共有するのは手順や指示です。会話・作業ファイル・実行結果は本人だけが見られます。</p>
    <div className="org-actions"><a className="button button-primary" href={scopeHref("/library/new?kind=skill", value.scope)}>スキルを登録</a><a className="button button-secondary" href={scopeHref("/library/new?kind=agent", value.scope)}>エージェントを登録</a></div>
    <form method="get" className="org-form library-filters">
      <input type="hidden" name="workspace" value={value.scope.workspaceId!} />
      <div><label htmlFor="library-kind">種類</label><select id="library-kind" name="kind" defaultValue={options.kind ?? ""}><option value="">すべて</option><option value="skill">スキル</option><option value="agent">エージェント</option></select></div>
      <div><label htmlFor="library-filter">公開範囲</label><select id="library-filter" name="filter" defaultValue={options.filter}><option value="all">すべて</option><option value="personal">自分だけ</option><option value="workspace">ワークスペース共有</option></select></div>
      <label className="org-check"><input type="checkbox" name="archived" value="1" defaultChecked={options.include_archived} />利用終了した設定も表示</label>
      <button type="submit" className="button button-secondary">絞り込む</button>
    </form>
    {value.error && <Notice title="一覧を表示できません" error><p>{value.error}</p></Notice>}
    {value.result && <section className="org-section" aria-labelledby="definitions-heading"><h2 id="definitions-heading">登録済みの設定</h2>
      {value.result.definitions.length === 0 ? <p>該当する設定はありません。</p> : <ul className="org-cards">{value.result.definitions.map(item => <li key={item.id}>
        <p>{definitionKindLabel[item.kind]} · {definitionVisibilityLabel[item.visibility]}</p>
        <h3><a href={scopeHref(`/library/${item.id}`, value.scope)}>{item.name}</a></h3>
        <p>{item.archived_at ? "利用終了" : item.latest_version ? `公開中（第${item.latest_version.version}版）` : "下書き"}{item.can_edit ? " · 編集できます" : ""}</p>
      </li>)}</ul>}
      <div className="org-actions">{options.before && <a href={href()}>最初に戻る</a>}{value.result.next_cursor && <a href={href(value.result.next_cursor)}>次の50件</a>}</div>
    </section>}
  </Workspace>;
}
