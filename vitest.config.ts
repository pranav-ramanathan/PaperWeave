import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // The sandbox tests need Docker and the TeX image: pnpm test:sandbox
    exclude: process.env.SANDBOX
      ? ['**/node_modules/**']
      : ['**/node_modules/**', '**/*.sandbox.test.ts'],
    testTimeout: 900_000,
    // Tests make the same few addresses members of paper after paper. The per-address limit on
    // invitations has its own test, which sets it itself.
    env: { INVITATIONS_PER_ADDRESS_BURST: '1000' },
  },
});
