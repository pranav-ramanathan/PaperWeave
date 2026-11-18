// The spelling and grammar findings of a file (GET ?file=<id>), and two quick changes to how
// the paper is checked (POST): {word} makes a word the paper's own, {rule} switches a rule off.
import { AppError, checkGrammar, languageSettings, setLanguageSettings } from '@paperweave/server';
import { blobs, currentUser, db, readJson, sameOrigin } from '../../../../lib/server';

type Params = { params: Promise<{ id: string }> };
const failed = (err: unknown) => {
  if (err instanceof AppError) return Response.json({ error: err.message }, { status: err.status });
  throw err;
};

export async function GET(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  try {
    const file = new URL(request.url).searchParams.get('file') ?? '';
    const findings = await checkGrammar(db(), blobs(), user.id, (await params).id, file);
    return Response.json(findings, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return failed(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const { id } = await params;
  try {
    const input = await readJson(request);
    const now = await languageSettings(db(), user.id, id);
    if (typeof input?.word === 'string')
      await setLanguageSettings(db(), user.id, id, { glossary: [...now.glossary, input.word] });
    else if (typeof input?.rule === 'string')
      await setLanguageSettings(db(), user.id, id, { off: [...now.off, input.rule] });
    else throw new AppError('invalid_input', 'Name a word or a rule.');
    return Response.json({ ok: true });
  } catch (err) {
    return failed(err);
  }
}
