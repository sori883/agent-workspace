import { requireWorkspaceScope, workspaceTitle } from "../lib/workspace-scope.server";
import { scopeHref } from "../lib/workspace-scope";
import { requireAuth } from "../lib/auth.server";
import { data, Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/run-detail";
import { runIdSchema, type ArtifactResult, type RunDetail } from "../../shared/run-contracts";
import { runsClient, RunApiError } from "../lib/runs.server";
import { loadSession, pageHeaders, verifySubmission } from "../lib/security.server";
import { readLocalForm } from "../lib/forms.server";
import { runErrorMessage, runStateLabels } from "../lib/run-copy";
import { LegacyNotice } from "../components/organization";
import { Notice, useRunRefresh, Workspace } from "../components/workspace";

export function meta() { return [{ title: "実行の結果 | AX ワークスペース" }]; }
export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const scope = requireWorkspaceScope(request);
  const session = await loadSession(request);
  const headers = pageHeaders();
  if (session.cookie) headers.set("Set-Cookie", session.cookie);
  const selectedName = workspaceTitle(user.accessToken, scope);
  let detail: RunDetail | null = null;
  let artifact: ArtifactResult | null = null;
  let error: string | null = null;
  let artifactError = false;
  let status = 200;
  try {
    if (!runIdSchema.safeParse(params.runId).success) throw new RunApiError("run_not_found", 404);
    const api = runsClient(user.accessToken, undefined, undefined, scope.workspaceId);
    detail = await api.get(params.runId);
    if (detail.result?.artifact) {
      try { artifact = await api.artifact(params.runId); }
      catch { artifactError = true; }
    }
  } catch (cause) {
    error = cause instanceof RunApiError ? runErrorMessage(cause.code) : "実行の状態を取得できませんでした。接続を確認してから更新してください。";
    status = cause instanceof RunApiError ? cause.status : 503;
  }
  return data({ scope, workspaceName: await selectedName, csrf: session.csrf, detail, artifact, artifactError, error }, { status, headers });
}
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireAuth(request);
  const scope = requireWorkspaceScope(request);
  try {
    const form = await readLocalForm(request, ["csrf", "intent"]);
    await verifySubmission(request, form.get("csrf"));
    if (form.get("intent") !== "recover" || !runIdSchema.safeParse(params.runId).success) throw new Response("操作を確認してください。", { status: 400 });
    await runsClient(user.accessToken, undefined, undefined, scope.workspaceId).recover(params.runId);
    return redirect(scopeHref(`/runs/${params.runId}`, scope), { status: 303, headers: pageHeaders() });
  } catch (cause) {
    const status = cause instanceof Response || cause instanceof RunApiError ? cause.status : 503;
    const error = cause instanceof Response ? await cause.text() : cause instanceof RunApiError ? runErrorMessage(cause.code) : "復旧の受付結果を確認できませんでした。状態を更新して確認してください。";
    return data({ error }, { status, headers: pageHeaders() });
  }
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders, errorHeaders }) => {
  const result = pageHeaders();
  for (const source of [loaderHeaders, actionHeaders, errorHeaders]) source?.forEach((value, key) => result.set(key, value));
  return result;
};

export default function RunResult({ loaderData, actionData }: Route.ComponentProps) {
  const { detail, artifact, scope } = loaderData;
  const pending = useNavigation().state !== "idle";
  useRunRefresh(Boolean(detail && (detail.summary.active || detail.summary.state === "accepted")));
  return <Workspace workspaceName={loaderData.workspaceName} title="実行の結果" intro="作業の進み具合と、保存された成果物を確認できます。">
    {scope.legacy && <LegacyNotice />}
    <div className="detail-navigation"><a href={scopeHref("/tasks#history", scope)}>← 実行一覧へ</a>{!scope.legacy && <a href={scopeHref("/tasks", scope)}>新しい実行</a>}</div>
    {(loaderData.error || actionData?.error) && <Notice title="状況を確認してください" error><p>{actionData?.error ?? loaderData.error}</p></Notice>}
    {detail && <>
      <section className="run-status-panel" aria-labelledby="run-status-title"><p className="eyebrow">STATUS</p><h2 id="run-status-title" aria-live="polite">{runStateLabels[detail.summary.state]}</h2><p className="run-identifier">{detail.summary.run_id}</p>
        {detail.summary.state === "succeeded" && <p>成果物を回収し、外部通信の遮断と実行の停止を確認しました。</p>}
        {detail.summary.state === "running" && <p>処理を進めています。この画面を閉じても続行します。</p>}
        {detail.summary.state === "accepted" && <p>依頼は保存されています。まだ実行の開始を確認できていません。</p>}
        {detail.summary.state === "not_started" && <p>作業を開始せずに終了しました。モデルの呼び出しは行っていません。</p>}
        {detail.summary.state === "failed" && <p>作業は完了しませんでした。停止の確認と、以下の記録を確認してください。</p>}
        {detail.summary.state === "needs_recovery" && <p>結果・使用量・停止の確認が完了していません。追加の実行を止めています。</p>}
        <div className="status-actions"><a className="button button-secondary" href={scopeHref(`/runs/${detail.summary.run_id}`, scope)}>状態を更新する</a><span>{detail.summary.active || detail.summary.state === "accepted" ? "表示は約3秒ごとに更新されます" : "保存された記録を表示しています"}</span></div>
      </section>
      {detail.summary.error_type && <Notice title="実行中に問題がありました" error><p>{runErrorMessage(detail.summary.error_type)}</p><p className="error-code">確認用コード：{detail.summary.error_type}</p></Notice>}
      {detail.summary.can_recover && <section className="recovery-panel" aria-labelledby="recovery-title"><h2 id="recovery-title">状態を確認して終了する</h2><p>保存済みの結果の回収、外部通信の遮断、実行の停止を試みます。作業を最初からやり直したり、モデルを再度呼び出したりはしません。まだ開始されていない依頼は、開始せずに終了します。</p><Form method="post"><input type="hidden" name="csrf" value={loaderData.csrf} /><input type="hidden" name="intent" value="recover" /><button className="button button-secondary" type="submit" disabled={pending}>{pending ? "受け付けています…" : "状態を確認して終了する"}</button></Form></section>}
      <div className="workspace-grid detail-grid"><section className="check-panel" aria-labelledby="artifact-title"><div className="section-heading"><span className="step-number">02</span><div><h2 id="artifact-title">成果物</h2><p>{artifact ? artifact.name : "回収できた成果物をここに表示します。"}</p></div></div>
        {artifact ? <><pre className="artifact-content" data-testid="artifact-content">{artifact.content}</pre><a className="button button-secondary artifact-download" href={scopeHref(`/runs/${detail.summary.run_id}/artifact`, scope)} download={artifact.name}>成果物をダウンロード</a></> : <p className="empty-result">{loaderData.artifactError ? "成果物の内容を検証できなかったため、表示を止めています。" : "成果物はまだありません。"}</p>}
      </section><aside className="environment-panel" aria-labelledby="usage-title"><p className="eyebrow">USAGE & COMPLETION</p><h2 id="usage-title">使用量と終了確認</h2><dl className="environment-list"><div><dt>実行方法</dt><dd>{detail.summary.adapter === "offline" ? "動作テスト" : "モデル利用"}</dd></div><div><dt>料金の目安</dt><dd>{detail.result?.estimated_usd != null ? `${detail.result.estimated_usd.toFixed(8)} USD` : detail.summary.state === "not_started" ? "0 USD（未開始）" : "未確認"}</dd></div><div><dt>モデル使用量</dt><dd>{detail.result?.usage ? `${detail.result.usage.total_token_count ?? 0} トークン` : "未確認"}</dd></div><div><dt>外部通信の遮断</dt><dd>{detail.cleanup.egress_denied ? "確認済み" : detail.summary.state === "not_started" ? "未開始のため対象外" : "未確認"}</dd></div><div><dt>実行の停止</dt><dd>{detail.cleanup.suspended ? "確認済み" : detail.summary.state === "not_started" ? "未開始のため対象外" : "未確認"}</dd></div></dl><p className="environment-note">料金は記録された使用量からの概算です。請求額を保証するものではありません。</p>{detail.result?.usage && <details className="usage-details"><summary>使用量の内訳</summary><dl>{Object.entries(detail.result.usage).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details>}</aside></div>
      <section className="request-record" aria-labelledby="request-record-title"><h2 id="request-record-title">依頼の内容</h2><h3>作業の指示</h3><p className="saved-text">{detail.request.instruction}</p>{Object.entries(detail.request.inputs).map(([name, content]) => <div key={name}><h3>作業用テキスト（{name}）</h3><pre className="saved-text">{content}</pre></div>)}{detail.cleanup_errors.length > 0 && <details><summary>終了確認の記録</summary><ul>{detail.cleanup_errors.map((error, index) => <li key={index} className="error-code">{error}</li>)}</ul></details>}</section>
    </>}
  </Workspace>;
}
