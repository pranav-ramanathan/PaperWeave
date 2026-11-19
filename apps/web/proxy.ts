// Every page is sent with a policy saying which scripts may run on it: the ones this server put
// there for this request, marked with a number made up for it, and what they load. A script that
// got into a page some other way does not have the number and does not run.
import { type NextRequest, NextResponse } from 'next/server';

/** The policy for one request. Next.js reads the number from it and marks its own scripts. */
export function pagePolicy(nonce: string, sync: string, dev: boolean) {
  return [
    "default-src 'self'",
    // React needs eval in development only, to show server errors in the browser.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Style sheets are held to the number too: an injected one could read what is on the page
    // and send it away. Styles set on single elements are not, because the editors and the
    // maths renderer set them as they draw; those cannot select or send anything.
    // (In development the framework's own tools add style sheets without the number.)
    dev ? "style-src-elem 'self' 'unsafe-inline'" : `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    // For a browser that knows neither of the two above.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The app's own address, and the sync server's.
    `connect-src 'self' ${sync}`,
    // The PDF pages are drawn by a worker.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const sync = new URL(process.env.SYNC_URL ?? 'ws://localhost:4100').origin;
  const policy = pagePolicy(nonce, sync, process.env.NODE_ENV === 'development');
  // On the request, for the page being rendered to read; on the answer, for the browser.
  const headers = new Headers(request.headers);
  headers.set('Content-Security-Policy', policy);
  // The same number, where a page can read it to hand to its editors.
  headers.set('x-nonce', nonce);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only. Not the API or the app's own files, which run nothing; and not a PDF or a
      // ZIP asked for by its address (/builds/…/pdf, /revisions/…/zip), which the browser's own
      // viewer shows; nor a file being uploaded, which the proxy would cut at 10 MB. Those keep the
      // plain policy in next.config.ts.
      source:
        '/((?!api/|_next/static|_next/image|favicon.ico|projects/[^/]+/(?:builds|revisions)/[^/]+/[^/]+$|projects/[^/]+/files$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
