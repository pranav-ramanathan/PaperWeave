// Spike only: compile a fixture project with one file replaced by what is in the editor.
// The real build service (plan C4) compiles a stored revision from a queue instead.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { compile } from '@paperweave/workers';

const FIXTURES = join(process.cwd(), '../../fixtures');
const PROJECTS = ['ieee-multifile', 'article-basic', 'ams-multifile'];

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const { project, file, text } = (body ?? {}) as Record<string, unknown>;
  // Only a known project, an existing .tex file inside it, and a bounded amount of text.
  if (typeof project !== 'string' || !PROJECTS.includes(project))
    return Response.json({ error: 'unknown project' }, { status: 400 });
  if (
    typeof file !== 'string' ||
    !file.endsWith('.tex') ||
    normalize(file) !== file ||
    file.startsWith('/')
  )
    return Response.json({ error: 'bad file path' }, { status: 400 });
  if (file.split('/').includes('..') || !existsSync(join(FIXTURES, project, file)))
    return Response.json({ error: 'no such file' }, { status: 400 });
  if (typeof text !== 'string' || text.length > 1_000_000)
    return Response.json({ error: 'bad text' }, { status: 400 });

  const work = mkdtempSync(join(tmpdir(), 'paperweave-spike-'));
  try {
    cpSync(join(FIXTURES, project), join(work, 'src'), { recursive: true });
    writeFileSync(join(work, 'src', file), text);
    const result = await compile(join(work, 'src'), 'main.tex', join(work, 'out'));
    if (!result.pdf)
      return Response.json(
        { diagnostics: result.diagnostics, timedOut: result.timedOut },
        { status: 422 },
      );
    return new Response(readFileSync(join(work, 'out', result.pdf)), {
      headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
