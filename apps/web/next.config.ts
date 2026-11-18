import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: [
    '@paperweave/latex',
    '@paperweave/bridge',
    '@paperweave/workers',
    '@paperweave/server',
  ],
  agentRules: false,
};

export default config;
