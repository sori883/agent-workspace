import { createCookie, redirect } from "react-router";
import { authRuntime } from "../../server/auth";
import { AuthenticationError, opaqueId } from "../../server/auth-store";
import { readConfig } from "../../server/config";
import { assertLocalRequest, pageHeaders } from "./security.server";
import { loginDestination } from "../../server/login-destination";
import { agentsClient } from "./agents.server";

function cookie(kind: "auth" | "login") {
  const config = readConfig();
  return createCookie(`ax_${kind}_${config.webPort}`, { httpOnly: true, sameSite: "lax", path: "/",
    secure: config.webOrigin.startsWith("https:"), maxAge: kind === "login" ? 300 : 1800 });
}
async function cookieValue(request: Request, kind: "auth" | "login") {
  const value: unknown = await cookie(kind).parse(request.headers.get("cookie"));
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function unavailable() {
  return new Response("ログイン状態を確認できません。しばらくしてから再度お試しください。", { status: 503, headers: pageHeaders() });
}
export async function requireAuth(request: Request) {
  assertLocalRequest(request);
  const id = await cookieValue(request, "auth");
  const url = new URL(request.url);
  const login = `/login?returnTo=${encodeURIComponent(loginDestination(url.pathname + url.search))}`;
  if (!id) throw redirect(login, { headers: pageHeaders() });
  try {
    const session = await authRuntime().store.session(id);
    if (session) return session;
  } catch { throw unavailable(); }
  const headers = pageHeaders();
  headers.append("Set-Cookie", await cookie("auth").serialize("", { maxAge: 0 }));
  throw redirect(`${login}&expired=1`, { headers });
}
export async function beginLogin(request: Request, registerPasskey = false, returnTo?: string) {
  assertLocalRequest(request);
  try {
    const { store, idp } = authRuntime();
    const browserId = opaqueId();
    const flow = { state: opaqueId(), nonce: opaqueId(), verifier: opaqueId(), redirectUri: `${readConfig().webOrigin}/auth/callback`, returnTo: loginDestination(returnTo ?? (registerPasskey ? "/account" : undefined)) };
    const destination = await idp.authorization(flow, registerPasskey);
    await store.createFlow(browserId, flow);
    const headers = pageHeaders();
    headers.append("Set-Cookie", await cookie("login").serialize(browserId));
    return redirect(destination, { status: 303, headers });
  } catch { throw unavailable(); }
}
export async function finishLogin(request: Request) {
  assertLocalRequest(request);
  const headers = pageHeaders();
  headers.set("Referrer-Policy", "no-referrer");
  headers.append("Set-Cookie", await cookie("login").serialize("", { maxAge: 0 }));
  let step = "callback";
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const browserId = await cookieValue(request, "login");
    if (request.method !== "GET" || url.href.length > 16_384 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browserId ||
        [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) throw new AuthenticationError("invalid_callback");
    const { store, idp } = authRuntime();
    step = "flow";
    const flow = await store.consumeFlow(browserId, state);
    step = "exchange";
    const identity = await idp.exchange(url, flow);
    step = "identity";
    const userId = await store.identify(identity.issuer, identity.subject, identity.displayName, identity.verifiedEmail);
    step = "session";
    const sessionId = await store.createSession(userId, identity.tokens, identity.expiresAt);
    const previous = await cookieValue(request, "auth");
    if (previous) await store.revoke(previous);
    headers.append("Set-Cookie", await cookie("auth").serialize(sessionId));
    headers.append("Set-Cookie", `${readConfig().sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return redirect(loginDestination(flow.returnTo), { status: 303, headers });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : "REJECTED";
    console.error(`Authentication callback rejected at ${step} (${code}).`);
    return redirect("/login?error=1", { status: 303, headers });
  }
}
export async function logout(request: Request) {
  const user = await requireAuth(request);
  const id = await cookieValue(request, "auth");
  const headers = pageHeaders();
  try { await agentsClient(user.accessToken).revokeAll(); }
  catch { throw new Response("対話の停止受付を確認できず、ログアウトを完了できませんでした。ログイン状態はまだ有効です。時間をおいて再度ログアウトしてください。", { status: 503, headers }); }
  try {
    await authRuntime().store.revoke(id!);
  }
  catch { throw unavailable(); }
  headers.append("Set-Cookie", await cookie("auth").serialize("", { maxAge: 0 }));
  headers.append("Set-Cookie", await cookie("login").serialize("", { maxAge: 0 }));
  let destination = "/login?logged_out=1";
  try { destination = await authRuntime().idp.logout(`${readConfig().webOrigin}/login`); }
  catch {}
  return redirect(destination, { status: 303, headers });
}
