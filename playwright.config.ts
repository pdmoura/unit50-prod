import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    channel: "msedge",
  },
  webServer: {
    command: "node --import tsx tests/e2e-server.ts",
    url: "http://127.0.0.1:3100/api/health",
    timeout: 120000,
    reuseExistingServer: false,
  },
});
