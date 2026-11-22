import { auth } from '../../../../lib/server';

export const GET = (request: Request) => auth().handler(request);
// (`/magic-link/verify`, the library's link that signs in on a GET, is switched off in `createAuth`.)
export async function POST(request: Request) {
  const answer = await auth().handler(request);
  if (!new URL(request.url).pathname.endsWith('/sign-out')) return answer;
  // On signing out, the browser is told to forget what it has kept of this site. A paper's
  // PDF and the like are kept by the browser for up to an hour so as not to be fetched twice,
  // and were still handed back from there, without asking the server, to whoever used the
  // browser next.
  const headers = new Headers(answer.headers);
  headers.set('clear-site-data', '"cache"');
  return new Response(answer.body, { status: answer.status, headers });
}
