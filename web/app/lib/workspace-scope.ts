export type WorkspaceScope = { workspaceId: string | null; legacy: boolean };
export function scopeHref(path: string, scope: WorkspaceScope) {
  const url = new URL(path, "http://local.invalid");
  if (scope.workspaceId) url.searchParams.set("workspace", scope.workspaceId);
  else if (scope.legacy) url.searchParams.set("legacy", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}
