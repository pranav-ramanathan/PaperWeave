// The screenshot run of tests/ui-shots.spec.ts. It uses the same services and web server as the
// end-to-end tests (playwright.config.ts) but finds only that file, which `pnpm e2e` does not.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testDir: 'tests',
  testMatch: /ui-shots\.spec\.ts$/,
  outputDir: 'test-results/ui-shots',
  // The pictures are the result; nothing is compared.
  reporter: 'list',
  projects: [{ name: 'ui-shots' }],
});
