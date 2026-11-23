// The spelling and grammar findings of a file (GET ?file=<id>), and two quick changes to how
// the paper is checked (POST): {word} makes a word the paper's own, {rule} switches a rule off,
// each with the finding's {kind} to count it. {used: kind, outcome: 'changed' | 'proposed'} only
// counts a finding taken up in the editor or proposed by a reviewer.
import {
  AppError,
  changeLanguageSettings,
  checkGrammar,
  recordGrammarOutcome,
  withScope,
} from '@paperweave/server';
import { blobs, currentUser, db, readJson, sameOrigin } from '../../../../lib/server';

type Params = { params: Promise<{ id: string }> };
const failed = (err: unknown) => {
  if (err instanceof AppError) return Response.json({ error: err.message }, { status: err.status });
  throw err;
};

async function read(request: Request, { params }: Params) {
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

// Everything this reads about the paper is asked for once.
export const GET: typeof read = (request, context) => withScope(() => read(request, context));

export async function POST(request: Request, { params }: Params) {
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const { id } = await params;
  try {
    const input = await readJson(request);
    if (typeof input?.used === 'string') {
      if (input.outcome !== 'changed' && input.outcome !== 'proposed')
        throw new AppError('invalid_input', 'Say whether it was changed or proposed.');
      await recordGrammarOutcome(db(), user.id, id, input.used, input.outcome);
      return Response.json({ ok: true });
    }
    if (input?.kind !== undefined && !['spelling', 'grammar', 'style'].includes(input.kind))
      throw new AppError('invalid_input', 'The kind is spelling, grammar or style.');
    let outcome: 'word' | 'rule_off';
    if (typeof input?.word === 'string') {
      await changeLanguageSettings(db(), user.id, id, { addWords: [input.word] });
      outcome = 'word';
    } else if (typeof input?.rule === 'string') {
      await changeLanguageSettings(db(), user.id, id, { rulesOff: [input.rule] });
      outcome = 'rule_off';
    } else throw new AppError('invalid_input', 'Name a word or a rule.');
    // The change is made; a count that fails changes nothing about it.
    if (input.kind !== undefined)
      await recordGrammarOutcome(db(), user.id, id, input.kind, outcome).catch(() => {});
    return Response.json({ ok: true });
  } catch (err) {
    return failed(err);
  }
}
