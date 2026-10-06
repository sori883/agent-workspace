import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <Meta />
        <Links />
      </head>
      <body>{children}<ScrollRestoration /><Scripts /></body>
    </html>
  );
}
export default function App() { return <Outlet />; }
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <main className="error-page">
      <p className="eyebrow">AX WORKSPACE</p>
      <h1>{status === 404 ? "ページが見つかりません" : "ページを表示できませんでした"}</h1>
      <p>{status === 403 ? "起動時に表示されたアドレスから、このページを開いてください。" : "接続を確認してから、もう一度お試しください。"}</p>
      <a href="/" className="button button-primary">ワークスペースへ戻る</a>
    </main>
  );
}
