import { headers } from 'next/headers';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import 'katex/dist/katex.min.css';
import './globals.css';
import Fresh from './Fresh';
import Waiting from './Waiting';

/**
 * A file dropped on a page is not opened in its place: the page, and what is on it, stays. This
 * is a script of its own, run as the page is read, so that a drop before the page's other
 * scripts have started is kept too.
 */
const DROPPED = `(function(){function keep(e){var d=e.dataTransfer;if(!d||Array.prototype.indexOf.call(d.types,'Files')<0)return;var t=e.target;if(t instanceof HTMLInputElement&&t.type==='file')return;if(e.type==='dragover'&&!e.defaultPrevented)d.dropEffect='none';e.preventDefault()}addEventListener('dragover',keep);addEventListener('drop',keep)})()`;
// Comments in the script: dragged text is not ours (no 'Files'); a field for choosing a file takes
// a dropped one itself; whoever has already taken a dragover (the visual view) keeps its own cursor.

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
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: DROPPED }} />
        <Fresh />
        <Waiting />
        {children}
      </body>
    </html>
  );
}
