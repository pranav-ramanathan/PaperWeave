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
  // Sent with every answer. HSTS is for whatever terminates TLS in front of this.
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        // No other site may put these pages in a frame, point their forms elsewhere, or
        // change what relative addresses mean.
        { key: 'X-Frame-Options', value: 'DENY' },
        {
          key: 'Content-Security-Policy',
          value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    },
  ],
};

export default config;
