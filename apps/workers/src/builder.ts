// Takes queued builds from the builds table and builds them in the sandbox.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type BlobStore, cutRevision, type Db, transaction } from '@paperweave/server';
import type pg from 'pg';
import {
  BBL_BYTES,
  compile,
  type Compiler,
  IMAGE,
  PDF_BYTES,
  readOwn,
  SYNCTEX_BYTES,
} from './compile.ts';

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
 * 'utf8-biber-eps-glyphs-strings-forcedate': builds run with FORCE_SOURCE_DATE=1 now, so \today is
 * the revision's date. A PDF built before has the clock's date in it, and the manifest now
 * says FORCE_SOURCE_DATE=1, so it must not be reused as the result of that command.
 * '...-forcedate-unicode': a Unicode build error is in plain words now; a cached failed build
 * kept the raw-character message.
 * '...-forcedate-unicode-nullfont': a stray character in a picture is no longer "Characters not
 * shown"; a cached good build would keep the paper not ready to submit. Both of the last two
 * were applied together, in the change that made the constant say so.
 * '...-nullfont-csname': "Undefined control sequence." names the command now; a cached failed
 * build keeps the bare message.
 * '...-bbl': a paper that reads its own .bbl and has no \bibliography builds now; a cached
 * failed build would keep it failed.
 * '...-ended': "File ended while scanning" names the \input-ed file that ended; a cached failed
 * build keeps naming the root file.
 * '...-ended-unclosed': an environment left open in an \input-ed file is placed in that file; a
 * cached failed build keeps naming the root.
 * '...-group': a brace or group left open is a warning, and a root runaway names no made-up
 * line; a cached silent build is rebuilt.
 * '...-bibentry': a bare _, & or # in a .bib entry names the reference and its .bib line; a cached
 * failed build keeps the sentence about "an entry of a .bib file".
 * '...-minted': a paper that loads minted gets one error that says what to do; a cached failed
 * build keeps the five minted errors.
 * '...-nobib': a paper that names a .bib it does not have, with no .bbl, builds with [?] for its
 * citations and says what is missing; a cached failed build keeps "The bibliography could not
 * be made."
 * '...-merged': one warning per heading for PDF bookmarks, one for font sizes; a LaTeX
 * warning's second line is read.
 * '...-opened': a group or conditional left open by a package is not reported as the paper's;
 * one left open in a file read in is placed in that file.
 * '...-bibsaid': a BibTeX error about a name, a cross reference, the citations or the style says
 * what and where; a cached failed build keeps "The bibliography could not be made."
 * '...-uncited': a bibliography with nothing cited is a warning; a cached build keeps it as an
 * error beside its PDF.
 * '...-uncited-read': the files TeX opened are kept; a cached build has none, so the ZIP of
 * only the files the paper uses could not tell which are unused.
 * '...-uncited-read-madebbl': the .bbl a build read is kept; a cached build has none, so the ZIP
 * of only the files the paper uses would lack the bibliography for a venue that makes none.
 */
const TEX_TEXT =
  'utf8-biber-eps-glyphs-strings-forcedate-unicode-nullfont-csname-bbl-ended-unclosed-group-bibentry-minted-nobib-merged-opened-bibsaid-uncited-read-madebbl';

/**
 * Where each paper's last good build leaves what it made (BUILD_WARM_DIR; empty turns it off).
 * See compile()'s `warm`.
 */
const WARM = process.env.BUILD_WARM_DIR ?? join(tmpdir(), 'paperweave-warm');
/** Papers kept per image; past this the least recently built are removed. */
const WARM_PAPERS = 200;
let warmSwept = false;

/**
 * The folder kept for one paper under one toolchain image, or undefined when warm builds are off
 * or anything about it goes wrong. A new image starts empty: once per process, what an older
 * image made is removed.
 */
export function warmDir(image: string, projectId: string): string | undefined {
  if (!WARM || !/^[0-9a-f-]{36}$/i.test(projectId)) return undefined;
  try {
    const mine = createHash('sha256').update(image).digest('hex').slice(0, 16);
    mkdirSync(WARM, { recursive: true, mode: 0o700 });
    if (!warmSwept) {
      warmSwept = true;
      for (const e of readdirSync(WARM))
        if (e !== mine) rmSync(join(WARM, e), { recursive: true, force: true });
    }
    const dir = join(WARM, mine);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const papers = readdirSync(dir)
      .map((e) => ({ e, at: statSync(join(dir, e)).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    for (const { e } of papers.slice(0, Math.max(0, papers.length - WARM_PAPERS)))
      if (e !== projectId) rmSync(join(dir, e), { recursive: true, force: true });
    return join(dir, projectId);
  } catch {
    return undefined;
  }
}

/** The toolchain image's content ID: part of every cache key, so a new image rebuilds everything. */
export const imageId = () =>
  execFileSync('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], {
    encoding: 'utf8',
  }).trim();

/**
 * Take (lock) the queued build to do next. Not the oldest: the one whose requester has had the
 * fewest builds done in the last hour, then the oldest of those, so that one person's many
 * builds do not stand in front of everyone else's. A build is counted once it is done: while it
 * runs it is locked and stays queued. Rows other workers hold are skipped.
 */
export async function takeBuild(
  db: Db,
): Promise<
  | { id: string; project_id: string; requested_by: string | null; revision_id: string | null }
  | undefined
> {
  return (
    await db.query(
      `select b.id, b.project_id, b.requested_by, b.revision_id from builds b
       where b.status = 'queued'
       order by (select count(*) from builds d
                 where d.requested_by = b.requested_by and d.status <> 'queued'
                   and d.created_at > now() - interval '1 hour'),
                b.created_at
       for update of b skip locked limit 1`,
    )
  ).rows[0];
}

/**
 * Build the next queued build (see `takeBuild`), if there is one. Returns whether there was. The row stays
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
    const job = await takeBuild(db);
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
        `select id, status, diagnostics, pdf_digest, synctex_digest, bbl_digest, log_digest, labels, read from builds
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
        bbl_digest: hit.bbl_digest,
        log_digest: hit.log_digest,
        labels: hit.labels && JSON.stringify(hit.labels),
        read: hit.read && JSON.stringify(hit.read),
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
        warmDir(image, job.project_id),
      );
      // What compile() kept, read back without following links and no further than its cap.
      const outDir = join(work, 'out');
      const put = async (name: string | undefined, max: number) => {
        const bytes = name ? readOwn(outDir, join(outDir, name), max) : undefined;
        return bytes ? store.put(bytes) : null;
      };
      // The .bbl is kept only if TeX read it in this build (not an empty stand-in, which has no
      // bytes, nor one a warm build left that the paper no longer reads) and it is a sane size.
      const bblName = revision.root.replace(/\.(tex|ltx)$/i, '.bbl');
      const bblBytes = result.bbl
        ? readOwn(outDir, join(outDir, result.bbl), BBL_BYTES)
        : undefined;
      const keepBbl =
        !!result.pdf &&
        !!result.read?.includes(bblName) &&
        !!bblBytes &&
        bblBytes.length > 0 &&
        bblBytes.length < BBL_BYTES;
      await finish({
        ...common,
        status: result.ok ? 'succeeded' : 'failed',
        diagnostics: JSON.stringify(result.diagnostics),
        timed_out: result.timedOut,
        pdf_digest: await put(result.pdf, PDF_BYTES),
        synctex_digest: await put(result.synctex, SYNCTEX_BYTES),
        bbl_digest: keepBbl ? await put(result.bbl, BBL_BYTES) : null,
        log_digest: await store.put(Buffer.from(result.log, 'utf8')),
        labels: result.labels && JSON.stringify(result.labels),
        read: result.read && JSON.stringify(result.read),
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
