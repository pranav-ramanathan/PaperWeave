// Takes queued builds from the builds table and builds them in the sandbox.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type BlobStore, currentBytes, sha256, transaction } from '@paperweave/server';
import type pg from 'pg';
import { compile, type Compiler, IMAGE } from './compile.ts';

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
  return transaction(pool, async (db) => {
    const job = (
      await db.query(
        `select b.id, b.project_id, p.compiler, r.path as root from builds b
         join projects p on p.id = b.project_id left join files r on r.id = p.root_file_id
         where b.status = 'queued' order by b.created_at for update of b skip locked limit 1`,
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

    // The text as it stands now, not as it stood when the build was asked for.
    const files = (
      await db.query(
        'select id, path, digest, eol, bom, head_seq from files where project_id = $1 order by path',
        [job.project_id],
      )
    ).rows;
    const inputs: Record<string, string> = {};
    const heads: Record<string, string> = {};
    const content = new Map<string, Uint8Array>();
    for (const f of files) {
      const bytes = await currentBytes(db, store, f);
      content.set(f.path, bytes);
      inputs[f.path] = sha256(bytes);
      heads[f.id] = String(f.head_seq);
    }
    const key = createHash('sha256')
      .update(JSON.stringify({ inputs, root: job.root, compiler: job.compiler, image }))
      .digest('hex');
    const common = {
      cache_key: key,
      inputs: JSON.stringify(inputs),
      heads: JSON.stringify(heads),
      compiler: job.compiler,
      image,
    };

    if (!job.root) {
      const diagnostics = [{ severity: 'error', message: 'This paper has no root file to build.' }];
      await finish({ ...common, status: 'failed', diagnostics: JSON.stringify(diagnostics) });
      return true;
    }

    // The same inputs give the same output, so an earlier result for this paper is reused.
    // Only this paper's own builds are looked at: nothing is ever shared between papers.
    const hit = (
      await db.query(
        `select id, status, diagnostics, pdf_digest, synctex_digest, log_digest from builds
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
      });
      return true;
    }

    const work = mkdtempSync(join(tmpdir(), 'paperweave-job-'));
    try {
      for (const [path, bytes] of content) {
        // Paths were checked at import; they are relative and stay inside the project.
        mkdirSync(dirname(join(work, 'src', path)), { recursive: true });
        writeFileSync(join(work, 'src', path), bytes);
      }
      const result = await compile(
        join(work, 'src'),
        job.root,
        join(work, 'out'),
        seconds,
        job.compiler as Compiler,
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
        log_digest: await store.put(Buffer.from(result.log, 'latin1')),
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
  });
}
