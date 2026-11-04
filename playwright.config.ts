import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://localhost:4318",
    browserName: "chromium",
    launchOptions: {
      executablePath:
        process.env.CHROME_PATH ||
        (process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : undefined),
    },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx scripts/fixture-server.mts",
      url: "http://localhost:4319/health",
      timeout: 30000,
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -- --hostname localhost --port 4318",
      url: "http://localhost:4318/sign-in",
      timeout: 120000,
      reuseExistingServer: false,
      env: {
        APP_ORIGIN: "http://localhost:4318",
        GEMINI_API_KEY: "fixture-provider-key",
        NODE_OPTIONS: "--import=./scripts/fixture-provider.mjs",
        NEXT_PUBLIC_SUPABASE_URL: "http://localhost:4319",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
      },
    },
  ],
});
