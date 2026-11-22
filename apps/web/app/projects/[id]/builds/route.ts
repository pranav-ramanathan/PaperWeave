// Ask for a build of a paper, or read how its builds stand.
import { AppError, latestBuilds, requestBuild } from '@paperweave/server';
import { currentUser, db, sameOrigin } from '../../../../lib/server';

type Params = { params: Promise<{ id: string }> };
const failed = (err: unknown) => {
  if (err instanceof AppError) return Response.json({ error: err.message }, { status: err.status });
  throw err;
};

export async function GET(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    const builds = await latestBuilds(db(), user.id, (await params).id);
    return Response.json(builds, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return failed(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    // `x-auto-build`: the editor asking for itself. Over a limit that is not an error: there is
    // no build, and `paused` says why.
    if (request.headers.get('x-auto-build') === '1') {
      const made = await requestBuild(db(), user.id, (await params).id, { automatic: true });
      return Response.json(typeof made === 'string' ? { id: made } : { id: null, ...made });
    }
    return Response.json({ id: await requestBuild(db(), user.id, (await params).id) });
  } catch (err) {
    return failed(err);
  }
}
