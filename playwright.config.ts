import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  // One at a time so the timing test is not competing with the others for the CPU.
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:3100', trace: 'off' },
  webServer: {
    // A production build: the dev server reloads the page whenever a file in the repo changes,
    // test output included.
    command: 'pnpm --filter @paperweave/web build && pnpm --filter @paperweave/web start',
    url: 'http://localhost:3100/spike',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
