// Turn an uploaded ZIP into one paper, or several if the archive holds several.
// shortcut: runs inside the request. Move it onto the job queue when the build service (plan C4)
// brings one in.
import {
  coverage,
  decodeFile,
  DEFAULT_TRANSPARENT,
  includeGraph,
  parse,
  theoremEnvs,
} from '@paperweave/latex';
import type pg from 'pg';
import { type Entry, type Limits, LIMITS, readZip, type Skipped, writeZip } from './archive.ts';
import { authorize } from './authz.ts';
import type { BlobStore } from './blobs.ts';
import { type Db, transaction } from './db.ts';
import { AppError } from './errors.ts';
import { id, type Project } from './projects.ts';

const TEXT = /\.(tex|ltx|bib|bst|cls|sty|bbx|cbx|def|cfg|clo|csv|tsv|txt|md)$/i;
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

/** `% !TEX program = xelatex`, or packages that only work on one engine. */
function compilerFor(root: string): Compiler {
  const magic = /^%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(root)?.[1].toLowerCase();
  if (magic === 'xelatex' || magic === 'lualatex' || magic === 'pdflatex') return magic;
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(luacode|luatextra)\b/.test(root)) return 'lualatex';
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(fontspec|xeCJK|unicode-math|polyglossia)\b/.test(root))
    return 'xelatex';
  return 'pdflatex';
}

/**
 * Split an archive into the papers it holds. One wrapping folder is removed. If root files sit in
 * different top-level folders (an "export all projects" archive), each folder is a paper.
 */
function papers(entries: Entry[], skipped: Skipped[]) {
  const text = new Map<string, string>();
  for (const e of entries) {
    if (!TEXT.test(e.path)) continue;
    const d = decodeFile(e.bytes);
    if (d.editable) text.set(e.path, d.text);
  }
  const roots = [...text]
    .filter(([path, t]) => /\.(tex|ltx)$/i.test(path) && isRoot(t))
    .map(([p]) => p);
  if (!roots.length)
    throw new AppError(
      'invalid_input',
      'This ZIP cannot be imported: no .tex file in it has both \\documentclass and \\begin{document}.',
    );
  // The folders that hold a root file and are not inside another such folder.
  const tops = [...new Set(roots.map(dirOf))].filter(
    (d, _, all) => !all.some((o) => o !== d && d.startsWith(o)),
  );
  if (tops.length > MAX_PROJECTS)
    throw new AppError('invalid_input', `This ZIP holds more than ${MAX_PROJECTS} papers.`);
  const outside = entries.filter((e) => !tops.some((t) => e.path.startsWith(t)));
  for (const e of outside)
    skipped.push({ path: e.path, reason: 'outside every paper in the archive' });
  return tops.map((dir) => ({
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

function report(
  entries: Entry[],
  skipped: Skipped[],
): { report: ImportReport; meta: Map<string, ReturnType<typeof decodeFile>> } {
  const meta = new Map<string, ReturnType<typeof decodeFile>>();
  const texts: Record<string, string> = {};
  for (const e of entries) {
    if (!TEXT.test(e.path)) continue;
    const d = decodeFile(e.bytes);
    meta.set(e.path, d);
    if (d.editable) texts[e.path] = d.text;
  }
  const candidates = Object.keys(texts)
    .filter((p) => /\.(tex|ltx)$/i.test(p) && isRoot(texts[p]))
    .sort(
      (a, b) =>
        a.split('/').length - b.split('/').length ||
        +!/main\./.test(a) - +!/main\./.test(b) ||
        a.localeCompare(b),
    );
  const root = candidates[0];
  const graph = includeGraph(
    texts,
    root,
    entries.map((e) => e.path),
  );
  const transparent = new Set([
    ...DEFAULT_TRANSPARENT,
    ...Object.values(texts).flatMap(theoremEnvs),
  ]);
  const notes: string[] = [
    'A ZIP holds files only. Comments, history and sharing settings from where it came from are not in it.',
  ];
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
  const files = entries
    .map((e): FileReport => {
      const d = meta.get(e.path);
      if (!d) return { path: e.path, readonly: 'binary' };
      if (!d.editable) return { path: e.path, readonly: d.reason };
      if (!/\.(tex|ltx)$/i.test(e.path) || !graph.order.includes(e.path)) return { path: e.path };
      if (graph.preamble.includes(e.path)) return { path: e.path, sourceOnly: true };
      const c = coverage(parse(d.text, transparent));
      return { path: e.path, visual: { editable: c.editable, raw: c.raw + c.frozen } };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    meta,
    report: {
      root,
      otherRoots: candidates.slice(1),
      compiler: compilerFor(texts[root]),
      files,
      skipped,
      missing: graph.missing,
      dynamic: graph.dynamic,
      cycles: graph.cycles,
      notes,
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
  const { entries, skipped } = await readZip(zip, limits);
  const found = papers(entries, skipped).map((p) => ({ ...p, ...report(p.entries, p.skipped) }));
  // Blobs first: they are content-addressed, so a failure later leaves nothing that matters behind.
  const digests = new Map<Uint8Array, string>();
  for (const p of found) for (const e of p.entries) digests.set(e.bytes, await store.put(e.bytes));
  return transaction(pool, async (db) => {
    const created: Project[] = [];
    for (const p of found) {
      const name = (p.name || fallbackName || 'Imported paper').slice(0, 200);
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

/** The paper's files as a ZIP. A file nobody has edited comes out with the bytes it came in with. */
export async function exportZip(
  db: Db,
  store: BlobStore,
  userId: string,
  projectId: string,
): Promise<Uint8Array> {
  await authorize(db, userId, id(projectId), 'project.export');
  const files = await db.query(
    'select path, digest from files where project_id = $1 order by path',
    [projectId],
  );
  const entries: Entry[] = [];
  for (const f of files.rows) {
    const bytes = await store.get(f.digest);
    if (!bytes) throw new Error(`blob ${f.digest} for ${f.path} is missing`);
    entries.push({ path: f.path, bytes });
  }
  return writeZip(entries);
}
