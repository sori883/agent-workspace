export function loginDestination(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return "/workspaces";
  try {
    const url = new URL(value, "https://local.invalid");
    if (url.origin !== "https://local.invalid" || !["/", "/join", "/workspaces", "/tasks", "/account"].includes(url.pathname) && !/^\/(workspaces|runs)\/[a-zA-Z0-9-]+(?:\/artifact)?$/.test(url.pathname)) return "/workspaces";
    return url.pathname + url.search;
  } catch { return "/workspaces"; }
}
