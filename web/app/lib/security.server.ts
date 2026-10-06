import { randomBytes, timingSafeEqual } from "node:crypto";
import { createCookieSessionStorage } from "react-router";
import { readConfig } from "../../server/config";

const SESSION_SECONDS = 30 * 60;
export function assertLocalRequest(request: Request) {
  const { webOrigin } = readConfig();
  if (request.headers.get("host") !== new URL(webOrigin).host || new URL(request.url).origin !== webOrigin) {
    throw new Response("許可されていない接続元です。", { status: 403 });
  }
}

function sessionStorage() {
  return createCookieSessionStorage<{ csrf: string; expiresAt: number }>({
    cookie: {
      name: readConfig().sessionCookieName,
      httpOnly: true,
      path: "/",
      sameSite: "strict",
      secure: false,
      secrets: [readConfig().sessionSecret],
      maxAge: SESSION_SECONDS,
    },
  });
}

export async function loadSession(request: Request) {
  assertLocalRequest(request);
  const storage = sessionStorage();
  const session = await storage.getSession(request.headers.get("cookie"));
  if (typeof session.get("csrf") !== "string" || typeof session.get("expiresAt") !== "number" || Number(session.get("expiresAt")) <= Date.now()) {
    session.set("csrf", randomBytes(32).toString("base64url"));
    session.set("expiresAt", Date.now() + SESSION_SECONDS * 1000);
    return { csrf: session.get("csrf")!, cookie: await storage.commitSession(session) };
  }
  return { csrf: session.get("csrf")!, cookie: null };
}

export async function verifySubmission(request: Request, submittedToken: string | null) {
  assertLocalRequest(request);
  if (request.method !== "POST" || request.headers.get("origin") !== readConfig().webOrigin) {
    throw new Response("このページから送信してください。", { status: 403 });
  }
  const session = await sessionStorage().getSession(request.headers.get("cookie"));
  const token = session.get("csrf");
  const expiry = session.get("expiresAt");
  if (typeof token !== "string" || typeof expiry !== "number" || expiry <= Date.now() || !submittedToken) {
    throw new Response("ページを再読み込みしてから、もう一度お試しください。", { status: 403 });
  }
  const actual = Buffer.from(submittedToken);
  const expected = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Response("ページを再読み込みしてから、もう一度お試しください。", { status: 403 });
  }
}

export function pageHeaders() {
  return new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  });
}
