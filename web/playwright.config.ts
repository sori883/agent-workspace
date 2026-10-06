import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3210", trace: "retain-on-failure" },
  webServer: {
    command: "npm start",
    env: { WEB_PORT: "3210", API_PORT: "3211" },
    url: "http://127.0.0.1:3210",
    timeout: 60000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
