import { defineConfig } from '@playwright/test';

// The services in infra/compose.yaml. The environment overrides these.
const services = {
  DATABASE_URL: 'postgres://paperweave:paperweave@localhost:5432/paperweave',
  BETTER_AUTH_SECRET: 'local-tests-only-3kq9Zr7mVx2Lp8Tn5Wc1Yd4Hb6Jf0Gs',
  BETTER_AUTH_URL: 'http://localhost:3100',
  SMTP_URL: 'smtp://localhost:1025',
  S3_ENDPOINT: 'http://localhost:8333',
  S3_BUCKET: 'paperweave',
  S3_ACCESS_KEY: 'dev',
  S3_SECRET_KEY: 'dev',
  ...(process.env as Record<string, string>),
};

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  // One at a time so the timing test is not competing with the others for the CPU.
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:3100', trace: 'off' },
  webServer: [
    {
      // A production build: the dev server reloads the page whenever a file in the repo
      // changes, test output included.
      command:
        'pnpm --filter @paperweave/server migrate && pnpm --filter @paperweave/web build && pnpm --filter @paperweave/web start',
      url: 'http://localhost:3100/spike',
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: services,
    },
    {
      command: 'pnpm --filter @paperweave/sync start',
      url: 'http://localhost:4100',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: services,
    },
  ],
});
