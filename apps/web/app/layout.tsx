import { connection } from 'next/server';
import type { ReactNode } from 'react';
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata = { title: 'PaperWeave' };

export default async function Layout({ children }: { children: ReactNode }) {
  // Every page is made for its request: its scripts carry that request's number (see proxy.ts),
  // which a page made ahead of time could not.
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
