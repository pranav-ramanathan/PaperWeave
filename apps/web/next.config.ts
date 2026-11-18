import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: [
    '@paperweave/latex',
    '@paperweave/bridge',
    '@paperweave/workers',
    '@paperweave/server',
  ],
  // One copy of Yjs on the server, shared by pages and route handlers.
  serverExternalPackages: ['yjs'],
  agentRules: false,
};

export default config;
