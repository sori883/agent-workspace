import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/workspace.tsx"),
  route("connection", "routes/home.tsx"),
  route("runs/:runId", "routes/run-detail.tsx"),
  route("runs/:runId/artifact", "routes/run-artifact.ts"),
] satisfies RouteConfig;
