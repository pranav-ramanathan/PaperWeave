// Rewrites fixtures/digests.json. Run after changing a fixture on purpose: node fixtures/digest.mjs
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = import.meta.dirname;
const out = {};
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (!['digests.json', 'digest.mjs'].includes(name))
      out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
  }
};
walk(root);
writeFileSync(join(root, 'digests.json'), JSON.stringify(out, null, 2) + '\n');
