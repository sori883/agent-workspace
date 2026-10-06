import { randomUUID } from "node:crypto";
import { useEffect, useRef } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/workspace";
import { runInputSchema, type RunSummary } from "../../shared/run-contracts";
import { runsClient, RunApiError } from "../lib/runs.server";
import { loadSession, pageHeaders, verifySubmission } from "../lib/security.server";
import { readLocalForm } from "../lib/forms.server";
import { runErrorMessage } from "../lib/run-copy";
import { Notice, RunHistory, TextField, useRunRefresh, Workspace } from "../components/workspace";

export function meta() { return [{ title: "エージェントを実行する | AX ワークスペース" }]; }
export async function loader({ request }: Route.LoaderArgs) {
  const session = await loadSession(request);
  const headers = pageHeaders();
  if (session.cookie) headers.set("Set-Cookie", session.cookie);
  const url = new URL(request.url);
  const draft = url.searchParams.get("draft");
  if (!draft || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draft)) {
    return redirect(`/tasks?draft=${randomUUID()}${url.hash}`, { headers });
  }
  let runs: RunSummary[] = [];
  let error: string | null = null;
  try { runs = (await runsClient().list()).runs; }
  catch (cause) { error = cause instanceof RunApiError ? runErrorMessage(cause.code) : "実行一覧を取得できませんでした。接続を確認してから更新してください。"; }
  return data({ csrf: session.csrf, key: draft, runs, error }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  let submitted = { key: "", mode: "offline", instruction: "", input_text: "", output_name: "result.txt", allow_model: false };
  const failure = (error: string, status: number, fields: string[] = []) => data({ error, fields, submitted }, { status, headers: pageHeaders() });
  try {
    const form = await readLocalForm(request, ["csrf", "key", "mode", "instruction", "input_text", "output_name", "allow_model"]);
    submitted = { key: form.get("key") ?? "", mode: form.get("mode") ?? "", instruction: (form.get("instruction") ?? "").replace(/\r\n?/g, "\n"), input_text: (form.get("input_text") ?? "").replace(/\r\n?/g, "\n"), output_name: form.get("output_name") ?? "", allow_model: form.get("allow_model") === "yes" };
    await verifySubmission(request, form.get("csrf"));
    const parsed = runInputSchema.safeParse(submitted);
    if (!parsed.success) return failure("入力の長さ、成果物の名前、モデル利用の確認を見直してください。", 400, parsed.error.issues.map((issue) => String(issue.path[0])));
    const accepted = await runsClient().submit(parsed.data);
    return redirect(`/runs/${accepted.run_id}`, { status: 303, headers: pageHeaders() });
  } catch (cause) {
    if (cause instanceof Response) return failure(await cause.text(), cause.status);
    if (cause instanceof RunApiError) return failure(runErrorMessage(cause.code), cause.status);
    return failure("受付結果を確認できませんでした。一覧を確認してください。再送する場合は、このフォームのまま送信してください。", 503);
  }
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders, errorHeaders }) => {
  const result = pageHeaders();
  for (const source of [loaderHeaders, actionHeaders, errorHeaders]) source?.forEach((value, key) => result.set(key, value));
  return result;
};

export default function RunWorkspace({ loaderData, actionData }: Route.ComponentProps) {
  const pending = useNavigation().state !== "idle";
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (actionData) errorRef.current?.focus(); }, [actionData]);
  useRunRefresh(loaderData.runs.some((run) => run.active || run.state === "accepted"));
  const submitted = actionData?.submitted;
  return <Workspace title="エージェントを実行する" intro="短い作業を依頼して、進行状況と成果物を確認しましょう。">
    <div className="mode-notice"><p><strong>まずは料金なしで、実際の実行を試せます。</strong><span>動作テストではAX内で処理を動かし、作業用テキストをそのまま成果物に保存します。文章の生成や判断には「モデルを使う」を選びます。</span></p></div>
    {loaderData.error && <Notice title="実行一覧を取得できません" error><p>{loaderData.error}</p><a href="/connection">接続を確認する</a></Notice>}
    <div className="workspace-grid run-grid"><section className="check-panel" aria-labelledby="request-title"><div className="section-heading"><span className="step-number">01</span><div><h2 id="request-title">作業を依頼する</h2><p>一度に1件ずつ受け付けます。</p></div></div>
      {actionData && <div ref={errorRef} tabIndex={-1} className="form-error"><Notice title="受付を確認できませんでした" error><p>{actionData.error}</p><p>同じフォームを再送しても、受け付け済みの実行は増えません。</p></Notice></div>}
      <Form method="post" noValidate key={loaderData.key}>
        <input type="hidden" name="csrf" value={loaderData.csrf} /><input type="hidden" name="key" value={submitted?.key || loaderData.key} />
        <fieldset className="mode-options"><legend>実行方法<span className="required-label">必須</span></legend><label><input type="radio" name="mode" value="offline" defaultChecked={!submitted || submitted.mode === "offline"} /><span>動作テスト<small>料金なし・テキストをそのまま保存</small></span></label><label><input type="radio" name="mode" value="model" defaultChecked={submitted?.mode === "model"} /><span>モデルを使う<small>料金あり・設定済みのGeminiで作業</small></span></label></fieldset>
        <TextField id="instruction" label="作業の指示" initial={submitted?.instruction ?? "作業用テキストをそのまま成果物に保存してください。"} limit={2048} hint="2048バイト以内（日本語で約680文字が目安）。テストで作業用テキストが空の場合、この指示を保存します。" required invalid={actionData?.fields.includes("instruction")} />
        <TextField id="input_text" label="作業用テキスト" initial={submitted?.input_text ?? "はじめてのエージェント実行です。"} limit={4096} hint="任意。4096バイト以内（日本語で約1,360文字が目安）。" invalid={actionData?.fields.includes("input_text")} />
        <div className="run-field"><label htmlFor="output_name">成果物の名前<span className="required-label">必須</span></label><p className="field-hint" id="output-hint">半角英数字で始まる64文字以内。ピリオド・ハイフン・アンダーバーも使えます。</p><input className="text-input" id="output_name" name="output_name" defaultValue={submitted?.output_name ?? "result.txt"} maxLength={64} aria-describedby="output-hint" aria-invalid={actionData?.fields.includes("output_name") || undefined} /></div>
        <div className="model-consent"><label><input type="checkbox" name="allow_model" value="yes" defaultChecked={submitted?.allow_model ?? false} /><span>モデル利用時の外部送信と料金を確認しました</span></label><p>「モデルを使う」を選ぶ場合のみ必要です。指示と作業用テキストをモデル提供元へ送信します。呼び出し回数と使用量には上限を設けています。</p></div>
        <div className="form-actions"><button type="submit" className="button button-primary" disabled={pending}>{pending ? "受け付けています…" : "実行する"}</button><a href="/tasks">新しい実行</a></div>
      </Form>
    </section><aside className="environment-panel" aria-labelledby="execution-info"><p className="eyebrow">HOW IT WORKS</p><h2 id="execution-info">実行後の流れ</h2><ol className="execution-steps"><li><strong>依頼を受け付け</strong><p>実行番号を発行し、結果画面へ移動します。</p></li><li><strong>エージェントが作業</strong><p>この画面を閉じても、受け付けた処理は続きます。</p></li><li><strong>成果物を確認</strong><p>結果・使用量・停止の確認まで、記録を残します。</p></li></ol><p className="environment-note">途中で接続が切れた場合は、下の実行一覧を確認してください。実行のやり直しは自動で行いません。</p></aside></div>
    <RunHistory runs={loaderData.runs} draftKey={loaderData.key} />
  </Workspace>;
}
