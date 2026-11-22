// Takes queued builds from the builds table and builds them in the sandbox.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type BlobStore, cutRevision, type Db, transaction } from '@paperweave/server';
import type pg from 'pg';
import { compile, type Compiler, IMAGE } from './compile.ts';

/**
 * Part of every cache key. Builds cached before diagnostics and labels were read as UTF-8 hold
 * garbled file names and keys; bump this when what is read from TeX's output changes.
 * 'utf8-biber': Biber's errors are read now, so a cached failed build lacks its .bib and line.
 * 'utf8-biber-eps': an EPS picture is reported now; a cached good build with a box where one
 * should be said nothing, and a failed XeLaTeX build did not name the file.
 * 'utf8-biber-eps-glyphs': characters the font lacks are reported now; a cached good build
 * that left some out of the PDF said nothing.
 * 'utf8-biber-eps-glyphs-strings': an undefined @string abbreviation is reported now; a cached
 * good build that printed a reference without its journal said nothing.
 */
const TEX_TEXT = 'utf8-biber-eps-glyphs-strings';

/** The toolchain image's content ID: part of every cache key, so a new image rebuilds everything. */
export const imageId = () =>
  execFileSync('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], {
    encoding: 'utf8',
  }).trim();

/**
 * Build the oldest queued build, if there is one. Returns whether there was. The row stays
 * locked for the whole build: if this process dies, the lock goes and another worker takes it.
 */
export function buildNext(
  pool: pg.Pool,
  store: BlobStore,
  image: string,
  seconds = 60,
): Promise<boolean> {
  // The row is taken `skip locked`, so nobody waits on it, and this worker is next to the
  // database: it may sit between statements for a whole compile.
  const run = async (db: Db) => {
    const job = (
      await db.query(
        `select id, project_id, requested_by, revision_id from builds
         where status = 'queued' order by created_at for update skip locked limit 1`,
      )
    ).rows[0];
    if (!job) return false;
    const finish = (fields: Record<string, unknown>) => {
      const names = Object.keys(fields);
      return db.query(
        `update builds set finished_at = now(), ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')} where id = $1`,
        [job.id, ...Object.values(fields)],
      );
    };

    // A build is always of one revision. Unless a particular one was asked for, that is the paper
    // as it stands now, not as it stood when the build was requested.
    const revisionId: string =
      job.revision_id ?? (await cutRevision(pool, store, job.requested_by, job.project_id)).id;
    const revision = (
      await db.query(
        'select root, compiler, content_key, created_at from revisions where id = $1',
        [revisionId],
      )
    ).rows[0];
    const files = (
      await db.query('select path, digest from revision_files where revision_id = $1', [revisionId])
    ).rows;
    // Everything that can change the output: the revision's content and the toolchain.
    const key = createHash('sha256')
      .update(`${revision.content_key}:${image}:${TEX_TEXT}`)
      .digest('hex');
    const common = { revision_id: revisionId, cache_key: key, compiler: revision.compiler, image };

    if (!revision.root) {
      const diagnostics = [{ severity: 'error', message: 'This paper has no root file to build.' }];
      await finish({ ...common, status: 'failed', diagnostics: JSON.stringify(diagnostics) });
      return true;
    }

    // The same inputs give the same output, so an earlier result for this paper is reused.
    // Only this paper's own builds are looked at: nothing is ever shared between papers.
    const hit = (
      await db.query(
        `select id, status, diagnostics, pdf_digest, synctex_digest, log_digest, labels from builds
         where project_id = $1 and cache_key = $2 and status <> 'queued'
           and not coalesce(timed_out, false)
         order by created_at desc limit 1`,
        [job.project_id, key],
      )
    ).rows[0];
    if (hit) {
      await finish({
        ...common,
        status: hit.status,
        cached_from: hit.id,
        diagnostics: JSON.stringify(hit.diagnostics ?? []),
        pdf_digest: hit.pdf_digest,
        synctex_digest: hit.synctex_digest,
        log_digest: hit.log_digest,
        labels: hit.labels && JSON.stringify(hit.labels),
      });
      return true;
    }

    const work = mkdtempSync(join(tmpdir(), 'paperweave-job-'));
    try {
      for (const f of files) {
        const bytes = await store.get(f.digest);
        if (!bytes) throw new Error(`blob ${f.digest} for ${f.path} is missing`);
        // Paths were checked at import and on rename; they are relative and stay inside the project.
        mkdirSync(dirname(join(work, 'src', f.path)), { recursive: true });
        writeFileSync(join(work, 'src', f.path), bytes);
      }
      const result = await compile(
        join(work, 'src'),
        revision.root,
        join(work, 'out'),
        seconds,
        revision.compiler as Compiler,
        // The PDF is stamped with the moment its revision was cut, so rebuilding it elsewhere
        // from the exported files gives the same bytes.
        Math.floor(new Date(revision.created_at).getTime() / 1000),
      );
      const put = async (name?: string) =>
        name && existsSync(join(work, 'out', name))
          ? store.put(readFileSync(join(work, 'out', name)))
          : null;
      await finish({
        ...common,
        status: result.ok ? 'succeeded' : 'failed',
        diagnostics: JSON.stringify(result.diagnostics),
        timed_out: result.timedOut,
        pdf_digest: await put(result.pdf),
        synctex_digest: await put(result.synctex),
        log_digest: await store.put(Buffer.from(result.log, 'utf8')),
        labels: result.labels && JSON.stringify(result.labels),
      });
    } catch (err) {
      // The build machinery itself failed (no Docker, no image). Say so rather than retry forever.
      console.error(`build ${job.id} could not run:`, (err as Error).message);
      const diagnostics = [
        { severity: 'error', message: 'The build service could not run this build. Try again.' },
      ];
      await finish({
        ...common,
        cache_key: null,
        status: 'failed',
        diagnostics: JSON.stringify(diagnostics),
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    return true;
  };
  return transaction(pool, run, 0);
}
