import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useRevalidator } from "react-router";
import { runStateLabels } from "../lib/run-copy";
import type { RunSummary } from "../../shared/run-contracts";

export function Workspace({ title, intro, children, sidebar, chat = false }: { title: string; intro: string; children: ReactNode; sidebar?: ReactNode; chat?: boolean }) {
  const { pathname } = useLocation();
  return <>
    <a className="skip-link" href="#main">本文へ移動</a>
    <header className="site-header"><a className="brand" href="/" aria-label="AX ワークスペース ホーム"><span className="brand-symbol" aria-hidden="true">ax<span>.</span></span><span className="brand-name">ワークスペース</span></a><span className="environment-chip"><span className="status-dot" />ローカル環境</span></header>
    <div className={`page-frame ${chat ? "chat-frame" : ""}`}>
      <aside className="sidebar run-sidebar"><p className="sidebar-label">WORKSPACE</p><nav aria-label="メインナビゲーション"><a className={pathname === "/" ? "nav-current" : undefined} aria-current={pathname === "/" ? "page" : undefined} href="/">チャット</a><a className={pathname === "/tasks" || pathname.startsWith("/runs") ? "nav-current" : undefined} href="/tasks">エージェントの実行</a><a href="/connection">接続確認</a></nav>{sidebar ?? <div className="sidebar-foot"><span className="sidebar-rule" /><strong>依頼して、<br />結果を確かめる。</strong><p>一度に1件ずつ、<br />作業を進められます。</p></div>}</aside>
      <main id="main" tabIndex={-1}><div className="page-heading"><p className="eyebrow">AGENT WORKSPACE</p><h1>{title}</h1><p className="lead">{intro}</p></div>{children}<footer className="page-footer"><span>AX WORKSPACE</span><span>ローカルプレビュー</span></footer></main>
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

export function RunHistory({ runs, draftKey }: { runs: RunSummary[]; draftKey: string }) {
  return <section className="history-section" id="history" aria-labelledby="history-title"><div className="history-heading"><div><p className="eyebrow">HISTORY</p><h2 id="history-title">実行一覧</h2></div><form method="get" action="/tasks"><input type="hidden" name="draft" value={draftKey} /><button className="text-button" type="submit">一覧を更新</button></form></div><p className="field-hint">最近の50件。画面を閉じた後も、ここから結果を確認できます。</p>{runs.length === 0 ? <p className="empty-result">まだ実行はありません。</p> : <ul className="run-list">{runs.map((run) => <li key={run.run_id}><div><span className={`run-badge state-${run.state}`}>{runStateLabels[run.state]}</span><span className="run-mode">{run.adapter === "offline" ? "動作テスト" : "モデル利用"}</span></div><a href={`/runs/${run.run_id}`} className="run-link">{run.run_id}<span aria-hidden="true"> →</span></a><p className="run-date">{run.accepted_at ? `${run.accepted_at.replace("T", " ").replace("Z", "")} UTC` : "以前の実行"}</p></li>)}</ul>}</section>;
}
