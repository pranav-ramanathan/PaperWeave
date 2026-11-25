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
  // Tests stand in for a proxy: each person sends an address of their own in this header.
  TRUSTED_IP_HEADER: 'x-forwarded-for',
  // A stand-in for the DOI registry, started by the test that needs one.
  CROSSREF_URL: 'http://127.0.0.1:4391',
  GRAMMAR_URL: 'http://127.0.0.1:8010',
  // The editor workbench at /spike, which the spike tests use. Off anywhere people use.
  SPIKE: '1',
  ...(process.env as Record<string, string>),
};

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e-global-setup.ts',
  timeout: 90_000,
  // One at a time unless E2E_WORKERS says otherwise, so that the timing tests are not competing
  // with the others for the CPU. CI sets 2: measured on one machine, 3 let the single build
  // worker's queue make a test wait longer than its five seconds for a build.
  workers: Number(process.env.E2E_WORKERS) || 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:3100', trace: 'off' },
  projects: [
    { name: 'e2e', testIgnore: /mail-down\.spec\.ts/ },
    // Pauses the one mail container for everyone, so it runs when nothing else is running.
    { name: 'mail-down', testMatch: /mail-down\.spec\.ts/, dependencies: ['e2e'] },
  ],
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
      // Needs Docker and the TeX image.
      command: 'pnpm --filter @paperweave/workers start',
      wait: { stdout: /build worker ready/ },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
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
