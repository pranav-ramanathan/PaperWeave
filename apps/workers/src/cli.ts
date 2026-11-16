import { resolve } from 'node:path';
import { compile } from './compile.ts';

const [project, root, out] = process.argv.slice(2);
if (!project || !root || !out) {
  console.error('usage: cli.ts <project dir> <root .tex> <output dir>');
  process.exit(2);
}
const r = await compile(resolve(project), root, resolve(out));
console.log(JSON.stringify({ ...r, log: undefined }, null, 2));
process.exit(r.ok ? 0 : 1);
