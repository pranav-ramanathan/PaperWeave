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

/**
 * A form the browser posts itself is posted once. Before the page's scripts have started nothing
 * else guards a second press (Once.tsx attaches when they have), and the first post has already
 * reached the server. Run as the page is read, like DROPPED.
 */
const SENT = `(function(){var s=new WeakSet;addEventListener('submit',function(e){if(s.has(e.target)){e.preventDefault();e.stopImmediatePropagation()}},true);addEventListener('submit',function(e){var f=e.target;if(!e.defaultPrevented&&f instanceof HTMLFormElement&&(f.getAttribute('method')||'').toLowerCase()==='post')s.add(f)});addEventListener('pageshow',function(e){if(e.persisted)s=new WeakSet})})()`;
// Comments in the script: a submit the page's scripts took (React's server actions, the editors,
// a large upload) is prevented by the time it reaches the window, and is theirs to guard; one
// that is not is on its way as a plain post, and its form is remembered until the page is
// replaced. A remembered form's next submit is stopped first of all (capture), so that scripts
// started since do not send it either. Only a page brought back by Back or Forward frees them:
// the first pageshow comes when the scripts arrive, which may be mid-post. A GET form is not ours.

// Every page names itself, and the name is followed by the service's: "Papers — PaperWeave". The
// title is the first thing a screen reader says of a page that has just opened.
export const metadata = { title: { default: 'PaperWeave', template: '%s — PaperWeave' } };

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
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: SENT }} />
        <Fresh />
        <Waiting />
        {children}
      </body>
    </html>
  );
}
