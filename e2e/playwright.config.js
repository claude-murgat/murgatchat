import { defineConfig, devices } from "@playwright/test";

// Target the web app. Default = the local dev/prod stack on :5173.
// For an isolated run that doesn't touch the dev DB, bring up the e2e stack
// (docker compose -f docker-compose.e2e.yml up) and set E2E_BASE_URL=http://localhost:5174.
const baseURL = process.env.E2E_BASE_URL || "http://localhost:5173";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    actionTimeout: 10_000,
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
