import { scopeHref, type WorkspaceScope } from "../lib/workspace-scope";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useRevalidator } from "react-router";
import { runStateLabels } from "../lib/run-copy";
import type { RunSummary } from "../../shared/run-contracts";

export function Workspace({ title, intro, children, sidebar, workspaceName, chat = false }: { title: string; intro: string; children: ReactNode; sidebar?: ReactNode; workspaceName?: string | null; chat?: boolean }) {
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  const scope = { workspaceId: params.get("workspace") ?? /^\/workspaces\/([0-9a-f-]{36})$/.exec(pathname)?.[1] ?? null, legacy: params.get("legacy") === "1" };
  return <>
    <a className="skip-link" href="#main">本文へ移動</a>
    <header className="site-header"><a className="brand" href="/workspaces" aria-label="AX ワークスペース ホーム"><span className="brand-symbol" aria-hidden="true">ax<span>.</span></span><span className="brand-name">ワークスペース</span></a><span className="environment-chip"><span className="status-dot" />ローカル環境</span></header>
    <div className={`page-frame ${chat ? "chat-frame" : ""}`}>
      <aside className="sidebar run-sidebar"><p className="sidebar-label">WORKSPACE</p>
        <nav aria-label="メインナビゲーション">
          <a href={scope.workspaceId ? scopeHref("/workbench", scope) : "/workspaces"} aria-current={pathname === "/workbench" ? "page" : undefined}>新しい依頼</a>
          <a href={scope.workspaceId ? scopeHref("/library", scope) : "/workspaces"} aria-current={pathname.startsWith("/library") ? "page" : undefined}>スキル</a>
          <a href={scope.workspaceId ? scopeHref("/files", scope) : "/workspaces"} aria-current={pathname === "/files" ? "page" : undefined}>作業ファイル</a>
          <details className="secondary-nav" open={["/", "/agent", "/tasks", "/connection", "/account"].includes(pathname) || pathname.startsWith("/runs") || pathname.startsWith("/workspaces")}>
            <summary>履歴・設定など</summary>
            <a href="/workspaces" aria-current={pathname === "/workspaces" ? "page" : undefined}>ワークスペース一覧</a>
            {scope.workspaceId && <a href={`/workspaces/${scope.workspaceId}`} aria-current={pathname === `/workspaces/${scope.workspaceId}` ? "page" : undefined}>メンバー・設定</a>}
            <a href={scopeHref("/account", scope)} aria-current={pathname === "/account" ? "page" : undefined}>アカウント</a>
            <a href={scope.workspaceId || scope.legacy ? scopeHref("/", scope) : "/workspaces"} aria-current={pathname === "/" ? "page" : undefined}>これまでのチャット</a>
            <a href={scope.workspaceId ? scopeHref("/agent", scope) : "/workspaces"} aria-current={pathname === "/agent" ? "page" : undefined}>以前のエージェント対話</a>
            <a href={scope.workspaceId || scope.legacy ? scopeHref("/tasks", scope) : "/workspaces"} aria-current={pathname === "/tasks" || pathname.startsWith("/runs") ? "page" : undefined}>実行記録</a>
            <a href={scopeHref("/connection", scope)} aria-current={pathname === "/connection" ? "page" : undefined}>接続確認</a>
          </details>
        </nav>
        {sidebar ?? <div className="sidebar-foot"><span className="sidebar-rule" /><strong>依頼して、<br />結果を確かめる。</strong></div>}
      </aside>
      <main id="main" tabIndex={-1}><div className="page-heading"><p className="eyebrow">AGENT WORKSPACE</p>{workspaceName && <p className="selected-workspace">選択中：{workspaceName}</p>}<h1>{title}</h1><p className="lead">{intro}</p></div>{children}<footer className="page-footer"><span>AX WORKSPACE</span><span>ローカルプレビュー</span></footer></main>
    </div>
  </>;
}

export function Notice({ title, children, error = false }: { title: string; children?: ReactNode; error?: boolean }) {
  return <div className={`result ${error ? "result-error" : "run-notice"}`} role={error ? "alert" : undefined}><div className="result-heading"><span aria-hidden="true">{error ? "!" : "i"}</span><h2>{title}</h2></div>{children && <div className="notice-content">{children}</div>}</div>;
}

export function TextField({ id, label, initial, limit, hint, required = false, invalid = false }: { id: string; label: string; initial: string; limit: number; hint: string; required?: boolean; invalid?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [count, setCount] = useState(new TextEncoder().encode(initial).length);
  const [initialValue] = useState(() => {
    if (typeof document === "undefined") return initial;
    const element = document.getElementById(id);
    return element instanceof HTMLTextAreaElement ? element.value : initial;
  });
  useEffect(() => { if (ref.current) setCount(new TextEncoder().encode(ref.current.value).length); }, []);
  return <div className="run-field"><label htmlFor={id}>{label}{required && <span className="required-label">必須</span>}</label><p className="field-hint" id={`${id}-hint`}>{hint}</p><textarea ref={ref} id={id} name={id} defaultValue={initialValue} rows={4} maxLength={limit} aria-invalid={invalid || count > limit || undefined} aria-describedby={`${id}-hint ${id}-count`} onChange={(event) => setCount(new TextEncoder().encode(event.target.value).length)} /><p className={`input-count ${count > limit ? "field-error" : ""}`} id={`${id}-count`}>{count} / {limit} バイト</p></div>;
}

export function useRunRefresh(enabled: boolean) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") void revalidator.revalidate();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [enabled, revalidator]);
}

export function RunHistory({ runs, draftKey, scope }: { runs: RunSummary[]; draftKey: string; scope: WorkspaceScope }) {
  return <section className="history-section" id="history" aria-labelledby="history-title"><div className="history-heading"><div><p className="eyebrow">HISTORY</p><h2 id="history-title">実行一覧</h2></div><form method="get" action="/tasks">{scope.workspaceId && <input type="hidden" name="workspace" value={scope.workspaceId} />}{scope.legacy && <input type="hidden" name="legacy" value="1" />}<input type="hidden" name="draft" value={draftKey} /><button className="text-button" type="submit">一覧を更新</button></form></div><p className="field-hint">最近の50件。画面を閉じた後も、ここから結果を確認できます。</p>{runs.length === 0 ? <p className="empty-result">まだ実行はありません。</p> : <ul className="run-list">{runs.map((run) => <li key={run.run_id}><div><span className={`run-badge state-${run.state}`}>{runStateLabels[run.state]}</span><span className="run-mode">{run.adapter === "offline" ? "動作テスト" : run.adapter === "interactive" ? (run.agent_mode === "model" ? "エージェント対話" : "模擬応答") : "モデル利用"}</span></div><a href={scopeHref(`/runs/${run.run_id}`, scope)} className="run-link">{run.run_id}<span aria-hidden="true"> →</span></a><p className="run-date">{run.accepted_at ? `${run.accepted_at.replace("T", " ").replace("Z", "")} UTC` : "以前の実行"}</p></li>)}</ul>}</section>;
}
