// Turn an uploaded ZIP into one paper, or several if the archive holds several.
// shortcut: runs inside the request. A paper of 2,000 files, the most allowed, takes a few
// seconds (docs/benchmarks.md). Move it onto a job queue if a deployment cuts requests off
// sooner than imports take there.
import {
  coverage,
  DEFAULT_TRANSPARENT,
  decodeFile,
  type Graph,
  includeGraph,
  parse,
  proseEnvs,
  reachesClass,
  uncomment,
} from '@paperweave/latex';
import type pg from 'pg';
import { type Entry, type Limits, LIMITS, readZip, type Skipped, texName } from './archive.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { setRootFile, TEXT_FILE } from './files.ts';
import { id, mayStartPapers, oneLine, type Project } from './projects.ts';
import {
  carriedRoot,
  exportReview,
  importReview,
  REVIEW_FILE,
  type ReviewImport,
} from './reviewdata.ts';
import { cutRevision, exportRevision, exportRevisionStream } from './revisions.ts';

const MAX_PROJECTS = 50;

export type Compiler = 'pdflatex' | 'xelatex' | 'lualatex';
export type FileReport = {
  path: string;
  /** Why the file cannot be opened as text, if it cannot. */
  readonly?: 'binary' | 'not-utf8' | 'mixed-newlines';
  /** For .tex files the visual editor opens: how many source characters are editable text. */
  visual?: { editable: number; raw: number };
  /** A file of definitions, read before the document body: shown, edited in source only. */
  sourceOnly?: boolean;
};
export type ImportReport = {
  root: string;
  otherRoots: string[];
  compiler: Compiler;
  files: FileReport[];
  skipped: Skipped[];
  missing: { from: string; target: string }[];
  dynamic: { from: string; target: string }[];
  cycles: string[][];
  notes: string[];
  /** Files LaTeX cannot name (% # " { or } in the path), sorted. Absent in reports stored before it existed. */
  unnamable?: string[];
  /** What was brought in of the review data the archive held, if it held any. */
  review?: ReviewImport;
};
export type ProjectFile = {
  id: string;
  path: string;
  size: number;
  digest: string;
  readonly: string | null;
};

const isRoot = (text: string) =>
  text.includes('\\documentclass') && text.includes('\\begin{document}');
const dirOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';

const ENGINE_OF: Record<string, Compiler> = {
  luacode: 'lualatex',
  luatexja: 'lualatex',
  luatextra: 'lualatex',
  fontspec: 'xelatex',
  xeCJK: 'xelatex',
  'unicode-math': 'xelatex',
  polyglossia: 'xelatex',
  ctex: 'xelatex',
  ctexart: 'xelatex',
  ctexrep: 'xelatex',
  ctexbook: 'xelatex',
  ctexbeamer: 'xelatex',
};
const LOADS =
  /\\(?:usepackage|RequirePackage|documentclass|LoadClass)\*?(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;

/**
 * `% !TEX program = xelatex`, or else packages that only work on one engine, loaded in the
 * preamble: the root's, the files it reads before \begin{document}, and the paper's own
 * styles and classes those load. Comments do not count.
 */
function compilerFor(texts: Record<string, string>, root: string, graph: Graph): Compiler {
  const magic = /^%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(texts[root])?.[1].toLowerCase();
  if (magic === 'xelatex' || magic === 'lualatex' || magic === 'pdflatex') return magic;
  const rootText = uncomment(texts[root]);
  const body = rootText.indexOf('\\begin{document}');
  const scanned = new Set<string>(graph.preamble);
  // Support files (styles, classes) the preamble files load, and those they load in turn.
  const queue = [root, ...graph.preamble];
  for (let from = queue.shift(); from !== undefined; from = queue.shift())
    for (const e of graph.edges)
      if (
        e.from === from &&
        e.kind === 'support' &&
        /\.(sty|cls)$/.test(e.to) &&
        !scanned.has(e.to)
      ) {
        scanned.add(e.to);
        queue.push(e.to);
      }
  const found = new Set<Compiler>();
  const scan = (text: string) => {
    for (const m of text.matchAll(LOADS))
      for (const name of m[1].split(',')) {
        const engine = ENGINE_OF[name.trim()];
        if (engine) found.add(engine);
      }
  };
  scan(body < 0 ? rootText : rootText.slice(0, body));
  for (const p of scanned) if (p !== root) scan(uncomment(texts[p] ?? ''));
  return found.has('lualatex') ? 'lualatex' : found.has('xelatex') ? 'xelatex' : 'pdflatex';
}

const NO_ROOT =
  'No file here has \\begin{document} with a \\documentclass before it, in that file or in a file it \\inputs.';

/**
 * Split an archive into the papers it holds. One wrapping folder is removed. If root files sit in
 * different top-level folders (an "export all projects" archive), each folder is a paper. If one
 * folder holds the root but the archive has usable files outside it (`src/main.tex` reaching for
 * `../figures`), the whole archive is the paper, so that what the root reaches for is there.
 */
export function papers(entries: Entry[], skipped: Skipped[]) {
  const text = new Map<string, string>();
  const unreadable: string[] = [];
  for (const e of entries) {
    if (!TEXT_FILE.test(e.path)) continue;
    const d = decodeFile(e.bytes);
    if (d.editable) text.set(e.path, d.text);
    else if (d.reason === 'not-utf8' && /\.(tex|ltx)$/i.test(e.path)) unreadable.push(e.path);
  }
  const texFiles = [...text].filter(([path]) => /\.(tex|ltx)$/i.test(path));
  const direct = texFiles.filter(([, t]) => isRoot(t)).map(([p]) => p);
  const asObject = Object.fromEntries(text);
  const everything = new Set(entries.map((e) => e.path));
  const roots = direct.length
    ? direct
    : texFiles.map(([p]) => p).filter((p) => reachesClass(asObject, p, everything));
  if (!roots.length) {
    // A main file saved as Latin-1 is not text the editors can open. Look at it as Latin-1 for
    // this one question, so that the refusal can say what is wrong with it.
    const latin = unreadable
      .filter((p) =>
        isRoot(Buffer.from(entries.find((e) => e.path === p)!.bytes).toString('latin1')),
      )
      .sort()[0];
    throw new AppError(
      'invalid_input',
      latin
        ? `This ZIP cannot be imported: ${latin} is the paper's main file, but it is not UTF-8 text (it may be Latin-1). Save it as UTF-8, change \\usepackage[latin1]{inputenc} to utf8, and import again.`
        : NO_ROOT,
    );
  }
  // The folders that hold a root file and are not inside another such folder.
  const tops = [...new Set(roots.map(dirOf))].filter(
    (d, _, all) => !all.some((o) => o !== d && d.startsWith(o)),
  );
  if (tops.length > MAX_PROJECTS)
    throw new AppError('invalid_input', `This ZIP holds more than ${MAX_PROJECTS} papers.`);
  if (tops.length === 1 && tops[0] !== '' && entries.some((e) => !e.path.startsWith(tops[0]))) {
    // The folder every file shares, if there is one: that is the wrapper, and only that goes.
    const first = entries[0].path.split('/')[0] + '/';
    const wrapper = entries.every((e) => e.path.startsWith(first)) ? first : '';
    return [
      {
        dir: wrapper,
        name: wrapper.replace(/\/$/, ''),
        entries: entries.map((e) => ({ path: e.path.slice(wrapper.length), bytes: e.bytes })),
        skipped: skipped.map((s) =>
          s.path.startsWith(wrapper) ? { ...s, path: s.path.slice(wrapper.length) } : s,
        ),
      },
    ];
  }
  const outside = entries.filter((e) => !tops.some((t) => e.path.startsWith(t)));
  for (const e of outside)
    skipped.push({
      path: e.path,
      reason: 'shared between the papers in this archive: add it to each paper that needs it',
    });
  return tops.map((dir) => ({
    dir,
    name: dir.replace(/\/$/, '').split('/').pop() ?? '',
    entries: entries
      .filter((e) => e.path.startsWith(dir))
      .map((e) => ({ path: e.path.slice(dir.length), bytes: e.bytes })),
    // Each paper's report lists what was left out of it, and what sat outside every paper.
    skipped: skipped.filter(
      (s) => s.path.startsWith(dir) || !tops.some((t) => s.path.startsWith(t)),
    ),
  }));
}

/** The one line that opens the import report, from facts the report already holds. */
export function summarizeImport(r: ImportReport): string {
  let editable = 0;
  let raw = 0;
  for (const f of r.files)
    if (f.visual) {
      editable += f.visual.editable;
      raw += f.visual.raw;
    }
  const share = editable + raw ? Math.round((100 * editable) / (editable + raw)) : 0;
  const sourceOnly = r.files.filter((f) => f.sourceOnly).length;
  return `Imported ${r.files.length} ${r.files.length === 1 ? 'file' : 'files'}: root ${r.root}, compiler ${r.compiler}, ${share}% of body prose editable visually, ${sourceOnly} source-only ${sourceOnly === 1 ? 'file' : 'files'}.`;
}

/** What an archive's files amount to as a paper: its root, compiler, and what can be edited how. */
export function describeImport(
  entries: Entry[],
  skipped: Skipped[] = [],
): { report: ImportReport; meta: Map<string, ReturnType<typeof decodeFile>> } {
  const meta = new Map<string, ReturnType<typeof decodeFile>>();
  const texts: Record<string, string> = {};
  for (const e of entries) {
    if (!TEXT_FILE.test(e.path)) continue;
    const d = decodeFile(e.bytes);
    meta.set(e.path, d);
    if (d.editable) texts[e.path] = d.text;
  }
  const paths = entries.map((e) => e.path);
  const tex = Object.keys(texts).filter((p) => /\.(tex|ltx)$/i.test(p));
  const direct = tex.filter((p) => isRoot(texts[p]));
  const found = direct.length ? direct : tex.filter((p) => reachesClass(texts, p, new Set(paths)));
  // Of two files that could be the paper, the one that brings in more of the others is it.
  const reach = new Map(found.map((p) => [p, includeGraph(texts, p, paths).edges.length]));
  const candidates = found.sort(
    (a, b) =>
      a.split('/').length - b.split('/').length ||
      +!/main\./.test(a) - +!/main\./.test(b) ||
      reach.get(b)! - reach.get(a)! ||
      a.localeCompare(b),
  );
  const root = candidates[0];
  const graph = includeGraph(texts, root, paths);
  const notes: string[] = [
    'A ZIP holds files only. Comments, history and sharing settings from where it came from are not in it.',
  ];
  const bbls = entries.map((e) => e.path).filter((p) => /\.bbl$/i.test(p));
  if (bbls.length && !entries.some((e) => /\.bib$/i.test(e.path)))
    notes.push(
      `The bibliography came ready-made (${bbls.map((p) => p.split('/').pop()).join(', ')}), with no .bib file: citations cannot be checked or added here.`,
    );
  if (skipped.some((s) => s.reason.startsWith('build script')))
    notes.push(
      'The project has a latexmkrc. PaperWeave never runs it, so anything it sets up is not applied.',
    );
  if (
    /\\usepackage(\[[^\]]*\])?\{[^}]*\b(minted|pythontex|shellesc)\b/.test(
      Object.values(texts).join('\n'),
    )
  )
    notes.push(
      'The project uses a package that runs external programs (shell escape). That is turned off, so those parts will not build.',
    );
  // EPS needs Ghostscript (XeLaTeX) or shell escape (pdfLaTeX, LuaLaTeX); the build has neither.
  // A paper that ships the PDF epstopdf makes, "fig-eps-converted-to.pdf", is fine.
  const compiler = compilerFor(texts, root, graph);
  const eps = [...new Set(graph.edges.map((e) => e.to))].filter(
    (p) => /\.eps$/i.test(p) && !paths.includes(p.replace(/\.eps$/i, '') + '-eps-converted-to.pdf'),
  );
  if (eps.length)
    notes.push(
      `${eps.length === 1 ? `The picture ${eps[0]} is an EPS file` : `${eps.length} pictures are EPS files (${eps.slice(0, 3).join(', ')}${eps.length > 3 ? ', ...' : ''})`}, which ${compiler === 'xelatex' ? 'XeLaTeX cannot convert here: the build fails' : `${compiler === 'lualatex' ? 'LuaLaTeX' : 'pdfLaTeX'} cannot place here: the PDF has a box with the name instead`}. Convert ${eps.length === 1 ? 'it' : 'them'} to PDF.`,
    );
  const mixed = [...meta]
    .filter(([, d]) => d.editable && d.meta.mixed)
    .map(([p]) => p)
    .sort();
  if (mixed.length)
    notes.push(
      `Line endings are mixed in ${mixed.slice(0, 10).join(', ')}${mixed.length > 10 ? `, and ${mixed.length - 10} more` : ''}: each is kept as it is until it is edited here, then written with one style.`,
    );
  // The paper's own theorem environments are prose in the editor too: count them the same way.
  const set = new Set([...DEFAULT_TRANSPARENT, ...proseEnvs(texts, root)]);
  const files = entries
    .map((e): FileReport => {
      const d = meta.get(e.path);
      if (!d) return { path: e.path, readonly: 'binary' };
      if (!d.editable) return { path: e.path, readonly: d.reason };
      if (!/\.(tex|ltx)$/i.test(e.path) || !graph.order.includes(e.path)) return { path: e.path };
      if (graph.preamble.includes(e.path)) return { path: e.path, sourceOnly: true };
      const c = coverage(parse(d.text, set));
      return { path: e.path, visual: { editable: c.editable, raw: c.raw + c.frozen } };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    meta,
    report: {
      root,
      otherRoots: candidates.slice(1),
      compiler,
      files,
      skipped,
      missing: graph.missing,
      dynamic: graph.dynamic,
      cycles: graph.cycles,
      notes,
      unnamable: paths.filter((p) => texName(p)).sort(),
    },
  };
}

/** Import a ZIP as new papers owned by the user. Nothing is created unless the whole archive is sound. */
export async function importZip(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  zip: Uint8Array,
  fallbackName: string,
  limits: Limits = LIMITS,
): Promise<Project[]> {
  const { entries, skipped, review } = await readZip(zip, limits);
  const found = papers(entries, skipped).map((p) => ({
    ...p,
    ...describeImport(p.entries, p.skipped),
  }));
  await mayStartPapers(pool, userId, found.length, limits.papersPerHour);
  // Blobs first: they are content-addressed, so a failure later leaves nothing that matters behind.
  // Sixteen at a time. One after another, a paper of two thousand files took eight and a half
  // seconds to import; this way, three and a half.
  const digests = new Map<Uint8Array, string>();
  const all = found.flatMap((p) => p.entries);
  for (let i = 0; i < all.length; i += 16)
    await Promise.all(
      all.slice(i, i + 16).map(async (e) => digests.set(e.bytes, await store.put(e.bytes))),
    );
  const made = await transaction(pool, async (db) => {
    const created: Project[] = [];
    for (const p of found) {
      // One paper is named after the ZIP it came in. Several keep the names of their folders.
      // A name taken from a file or folder is put on one line rather than refused.
      const name = (
        oneLine((found.length === 1 ? fallbackName || p.name : p.name || fallbackName) ?? '') ||
        'Imported paper'
      ).slice(0, 200);
      const project = (
        await db.query('insert into projects (name, compiler) values ($1, $2) returning id, name', [
          name,
          p.report.compiler,
        ])
      ).rows[0];
      await db.query(
        "insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')",
        [project.id, userId],
      );
      for (const e of p.entries) {
        const d = p.meta.get(e.path);
        const text = d?.editable ? d.meta : null;
        const { rows } = await db.query(
          `insert into files (project_id, path, digest, size, eol, bom, readonly_reason)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [
            project.id,
            e.path,
            digests.get(e.bytes),
            e.bytes.length,
            text?.eol ?? null,
            text?.bom ?? null,
            text ? null : d ? (d as { reason: string }).reason : 'binary',
          ],
        );
        if (e.path === p.report.root)
          await db.query('update projects set root_file_id = $2 where id = $1', [
            project.id,
            rows[0].id,
          ]);
      }
      await db.query('insert into import_reports (project_id, report) values ($1, $2)', [
        project.id,
        JSON.stringify(p.report),
      ]);
      created.push({ ...project, role: 'owner' });
    }
    return created;
  });
  // Review data that came with a paper is brought in once the paper is there to place it in.
  for (const [i, p] of found.entries()) {
    const data = review.find((r) => r.path === `${p.dir}${REVIEW_FILE}`);
    if (!data) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(Buffer.from(data.bytes).toString('utf8'));
    } catch {
      // Reported by importReview as unreadable.
    }
    const brought = await importReview(pool, store, made[i].id, parsed);
    const report: ImportReport = { ...p.report, review: brought };
    // The paper's root where it came from, if the archive says: a plain ZIP leaves that to the
    // importer's guess, which can be another file.
    const carried = carriedRoot(parsed);
    if (carried && carried !== report.root) {
      const target = (
        await pool.query(
          `select id from files where project_id = $1 and path = $2 and eol is not null
             and path ~* '\\.(tex|ltx)$'`,
          [made[i].id, carried],
        )
      ).rows[0];
      if (target) {
        await setRootFile(pool, userId, made[i].id, target.id);
        report.otherRoots = [report.root, ...report.otherRoots.filter((r) => r !== carried)];
        report.root = carried;
        report.notes = [
          ...report.notes,
          `The root file is ${carried}, as it was where this came from.`,
        ];
      } else
        report.notes = [
          ...report.notes,
          `Where this came from, the root file was ${carried}, but the paper has no such .tex file. ${report.root} is the root instead.`,
        ];
    }
    await pool.query('update import_reports set report = $2::jsonb where project_id = $1', [
      made[i].id,
      JSON.stringify(report),
    ]);
  }
  return made;
}

export async function listFiles(db: Db, userId: string, projectId: string): Promise<ProjectFile[]> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query(
    'select id, path, size, digest, readonly_reason as readonly from files where project_id = $1 order by path',
    [projectId],
  );
  return rows;
}

export async function importReport(
  db: Db,
  userId: string,
  projectId: string,
): Promise<ImportReport | null> {
  await authorize(db, userId, id(projectId), 'project.read');
  const { rows } = await db.query('select report from import_reports where project_id = $1', [
    projectId,
  ]);
  return rows[0]?.report ?? null;
}

/**
 * The paper as it is now, as a ZIP. It is cut as a revision first, so what is downloaded is one
 * consistent moment. A file nobody has edited comes out with the bytes it came in with; an edited
 * one comes out as its text in its original encoding and newline style.
 */
export async function exportZip(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  /** Also put the paper's threads and proposed changes in, as a file of their own. */
  opts: { review?: boolean } = {},
): Promise<Uint8Array> {
  const { revisionId, extra } = await cutForExport(pool, store, userId, projectId, opts);
  return (await exportRevision(pool, store, userId, projectId, revisionId, false, extra)).zip;
}

/** The same ZIP as a stream, for a response that may be larger than a function may send whole. */
export async function exportZipStream(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  opts: { review?: boolean } = {},
): Promise<ReadableStream<Uint8Array>> {
  const { revisionId, extra } = await cutForExport(pool, store, userId, projectId, opts);
  return (await exportRevisionStream(pool, store, userId, projectId, revisionId, false, extra)).zip;
}

async function cutForExport(
  pool: pg.Pool,
  store: BlobStore,
  userId: string,
  projectId: string,
  opts: { review?: boolean },
) {
  await authorize(pool, userId, id(projectId), 'project.export');
  // The review is read in the cut's own transaction, with every file held, so it describes the
  // text the revision (and so the ZIP's files) has: typing between the two would otherwise move
  // the words a thread or proposal is placed by. Only the database is read while they are held.
  let review: Buffer | undefined;
  const revision = await cutRevision(pool, store, userId, projectId, {
    within: opts.review
      ? async (db) => {
          review = Buffer.from(
            JSON.stringify(await exportReview(db, store, userId, projectId), null, 2) + '\n',
          );
        }
      : undefined,
  });
  const extra = review ? [{ path: REVIEW_FILE, bytes: review }] : [];
  return { revisionId: revision.id as string, extra };
}
