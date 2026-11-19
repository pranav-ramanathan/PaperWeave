import { headers } from 'next/headers';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import 'katex/dist/katex.min.css';
import './globals.css';
import Dropped from './Dropped';
import Fresh from './Fresh';

export const metadata = { title: 'PaperWeave' };

export default async function Layout({ children }: { children: ReactNode }) {
  // Every page is made for its request: its scripts carry that request's number (see proxy.ts),
  // which a page made ahead of time could not.
  await connection();
  // For the editors, which add style sheets of their own: see lib/nonce.ts.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en">
      <head>
        <meta property="csp-nonce" nonce={nonce} />
      </head>
      <body>
        <Fresh />
        <Dropped />
        {children}
      </body>
    </html>
  );
}
