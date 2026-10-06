import { assertLocalRequest, pageHeaders } from "./security.server";
import { readLimitedText } from "../../shared/http";

export async function readLocalForm(request: Request, allowed: string[]) {
  assertLocalRequest(request);
  if (request.method !== "POST" || request.headers.get("origin") !== new URL(request.url).origin) {
    throw new Response("このページから送信してください。", { status: 403, headers: pageHeaders() });
  }
  if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
    throw new Response("画面のフォームから送信してください。", { status: 415, headers: pageHeaders() });
  }
  const form = new URLSearchParams(await readLimitedText(request, 64 * 1024));
  if ([...form.keys()].some((key) => !allowed.includes(key) || form.getAll(key).length !== 1)) {
    throw new Response("入力内容を確認してください。", { status: 400, headers: pageHeaders() });
  }
  return form;
}
