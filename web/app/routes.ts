import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  route("login", "routes/login.tsx"),
  route("auth/callback", "routes/auth-callback.ts"),
  route("account", "routes/account.tsx"),
  index("routes/chat.tsx"),
  route("tasks", "routes/workspace.tsx"),
  route("connection", "routes/home.tsx"),
  route("runs/:runId", "routes/run-detail.tsx"),
  route("runs/:runId/artifact", "routes/run-artifact.ts"),
] satisfies RouteConfig;
