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
  // Pages get a fuller policy, saying which scripts may run on them: see proxy.ts.
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
    // An upload shown as a picture is shown as nothing else. Set here, not in the routes: a
    // header already on the answer wins over a route handler's own. Later entries win.
    // The address carries a sign-in token: never kept, and never sent on (Referrer-Policy above).
    {
      source: '/sign-in/confirm',
      headers: [{ key: 'Cache-Control', value: 'no-store' }],
    },
    ...['/projects/:id/picture', '/projects/:id/charts/:chartId/png'].map((source) => ({
      source,
      headers: [{ key: 'Content-Security-Policy', value: "default-src 'none'; sandbox" }],
    })),
  ],
};

export default config;
