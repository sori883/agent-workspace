import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  route("login", "routes/login.tsx"),
  route("auth/callback", "routes/auth-callback.ts"),
  route("account", "routes/account.tsx"),
  route("workspaces", "routes/workspaces.tsx"),
  route("workspaces/:workspaceId", "routes/workspace-manage.tsx"),
  route("join", "routes/join.tsx"),
  index("routes/chat.tsx"),
  route("agent", "routes/agent.tsx"),
  route("workbench", "routes/workbench.tsx"),
  route("workbench/transfer", "routes/workbench-transfer.ts"),
  route("files", "routes/files.tsx"),
  route("files/transfer", "routes/files-transfer.ts"),
  route("library", "routes/library.tsx"),
  route("library/new", "routes/library-new.tsx"),
  route("library/transfer", "routes/library-transfer.ts"),
  route("library/:id", "routes/library-detail.tsx"),
  route("tasks", "routes/workspace.tsx"),
  route("connection", "routes/home.tsx"),
  route("runs/:runId", "routes/run-detail.tsx"),
  route("runs/:runId/artifact", "routes/run-artifact.ts"),
] satisfies RouteConfig;
