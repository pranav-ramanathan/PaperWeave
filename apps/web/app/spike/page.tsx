import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { decodeFile, findRoot, includeGraph } from '@paperweave/latex';
import Spike from './Spike';

const FIXTURES = join(process.cwd(), '../../fixtures');
const PROJECTS = ['ieee-multifile', 'article-basic', 'ams-multifile'];

/** The editable .tex files of one fixture project, by path. */
function load(project: string) {
  const root = join(FIXTURES, project);
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.tex')) {
        const d = decodeFile(readFileSync(p));
        if (d.editable) files[relative(root, p)] = d.text;
      }
    }
  };
  walk(root);
  return files;
}

/** A long paper for timing: the article fixture's body repeated up to about 150 KB. */
function big() {
  const src = load('article-basic')['main.tex'];
  const from = src.indexOf('\\section{Introduction}');
  const to = src.indexOf('\\bibliographystyle');
  let out = src.slice(0, from);
  while (out.length < 150_000)
    out += src.slice(from, to).replaceAll('\\label{', `\\label{r${out.length}:`);
  return out + src.slice(to);
}

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<{ big?: string }> }) {
  const projects = Object.fromEntries(PROJECTS.map((p) => [p, load(p)]));
  if ((await searchParams).big) projects['big'] = { 'main.tex': big() };
  // Files read before \\begin{document} hold definitions: shown, but edited in source only.
  const sourceOnly = Object.fromEntries(
    Object.entries(projects).map(([name, files]) => {
      const root = findRoot(files);
      return [name, root ? includeGraph(files, root).preamble : []];
    }),
  );
  return <Spike projects={projects} sourceOnly={sourceOnly} compilable={PROJECTS} />;
}
