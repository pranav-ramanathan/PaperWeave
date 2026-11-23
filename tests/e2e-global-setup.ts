import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every temporary folder the tests make goes under one folder for this run, which is removed
// when the run ends. The web servers start before this and keep the normal TMPDIR.
export default function globalSetup() {
  const runDir = mkdtempSync(join(tmpdir(), 'paperweave-e2e-run-'));
  process.env.TMPDIR = runDir;
  return () => rmSync(runDir, { recursive: true, force: true });
}
