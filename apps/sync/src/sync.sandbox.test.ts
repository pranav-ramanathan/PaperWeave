// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  acceptInvitation,
  blobStore,
  deleteFile,
  exportZip,
  importZip,
  invite,
  listFiles,
  readZip,
  removeMember,
  restoreRevision,
  saveRevision,
  setRole,
  createFile,
  listRevisions,
  syncTicket,
  TEXT,
  writeZip,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { startSync } from './server.ts';

const SECRET = TEST_ENV.BETTER_AUTH_SECRET;
const store = blobStore(TEST_ENV);
const MAIN = '\\documentclass{article}\r\n\\begin{document}\r\nHello.\r\n\\end{document}\r\n';
let t: Awaited<ReturnType<typeof testDb>>;
let sync: Awaited<ReturnType<typeof startSync>>;
type User = { id: string; email: string };
const users = {} as Record<
  'owner' | 'editor' | 'second' | 'reviewer' | 'viewer' | 'outsider',
  User
>;
const open: HocuspocusProvider[] = [];
/** The separately started server that the kill test kills. */
let child: ChildProcess | undefined;

/** A fresh paper with one CRLF file, and everyone in their role. Returns the file's ID. */
async function paper() {
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Sync test');
  for (const [who, role] of [
    ['editor', 'editor'],
    ['second', 'editor'],
    ['reviewer', 'reviewer'],
    ['viewer', 'viewer'],
  ] as const) {
    const { token } = await invite(t.pool, users.owner.id, project.id, users[who].email, role);
    await acceptInvitation(t.pool, users[who].id, token);
  }
  const [file] = await listFiles(t.pool, users.owner.id, project.id);
  return { project: project.id, file: file.id };
}

/** Connect as a user, the way the browser will. */
function client(
  user: User,
  file: string,
  port = sync.port,
  // A fresh ticket for every connection attempt, as the web app will mint them.
  token = () => syncTicket(SECRET, user.id),
) {
  const doc = new Y.Doc();
  const state = { refused: false, closed: 0 };
  const provider = new HocuspocusProvider({
    websocketProvider: new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}`,
      // Reconnect quickly. The library refuses a delay below its minimum, silently.
      delay: 50,
      minDelay: 50,
      maxDelay: 200,
    }),
    name: file,
    document: doc,
    token,
    onAuthenticationFailed: () => void (state.refused = true),
    onClose: () => void state.closed++,
  });
  // A provider given its own socket does not start using it until told to.
  provider.attach();
  open.push(provider);
  return { doc, provider, state, text: doc.getText(TEXT) };
}
type Client = ReturnType<typeof client>;

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const saved = (...cs: Client[]) =>
  until('edits to be saved', () =>
    cs.every((c) => c.provider.synced && !c.provider.hasUnsyncedChanges),
  );

/** The text the stored log adds up to, read back the way export reads it. */
async function stored(project: string) {
  const { entries } = await readZip(await exportZip(t.pool, store, users.owner.id, project));
  return Buffer.from(entries[0].bytes).toString();
}
const headSeq = async (file: string) =>
  Number((await t.pool.query('select head_seq from files where id = $1', [file])).rows[0].head_seq);

beforeAll(async () => {
  t = await testDb();
  for (const who of ['owner', 'editor', 'second', 'reviewer', 'viewer', 'outsider'] as const)
    users[who] = await t.signIn(`${who}@example.org`);
  sync = await startSync({
    pool: t.pool,
    store,
    secret: SECRET,
    port: 4200 + Math.floor(Math.random() * 500),
    databaseUrl: t.url,
  });
});
afterAll(async () => {
  child?.kill('SIGKILL');
  for (const p of open) {
    p.destroy();
    p.configuration.websocketProvider.destroy();
  }
  await sync.stop();
  await t.close();
});

test('three people edit one file and end with the same text, which is what is stored', async () => {
  const { project, file } = await paper();
  const [a, b, c] = [
    client(users.owner, file),
    client(users.editor, file),
    client(users.second, file),
  ];
  await saved(a, b, c);
  expect(a.text.toString()).toBe(MAIN.replaceAll('\r\n', '\n'));

  // Everyone types at once, into the same line.
  const at = a.text.toString().indexOf('Hello.') + 5;
  for (let i = 0; i < 20; i++) {
    a.text.insert(at, `A${i} `);
    b.text.insert(at, `B${i} `);
    c.text.insert(at, `C${i} `);
  }
  await saved(a, b, c);
  await until(
    'everyone to see everything',
    () => a.text.length === b.text.length && b.text.length === c.text.length,
  );
  expect(b.text.toString()).toBe(a.text.toString());
  expect(c.text.toString()).toBe(a.text.toString());
  for (let i = 0; i < 20; i++)
    for (const who of 'ABC') expect(a.text.toString()).toContain(`${who}${i} `);
  // The stored file is that text, with the line endings it was uploaded with.
  expect(await stored(project)).toBe(a.text.toString().replaceAll('\n', '\r\n'));

  // Someone arriving later gets the same thing from the log alone.
  const late = client(users.viewer, file);
  await saved(late);
  expect(late.text.toString()).toBe(a.text.toString());
});

test('reviewers and viewers can read but nothing they type is saved or shared', async () => {
  const { project, file } = await paper();
  const owner = client(users.owner, file);
  await saved(owner);
  const before = await headSeq(file);
  for (const who of ['reviewer', 'viewer'] as const) {
    const c = client(users[who], file);
    await until(`${who} to load the file`, () => c.text.toString().includes('Hello.'));
    c.text.insert(0, `SNEAK-${who} `);
    // The server answers "not saved": the edit stays unsynced on their side.
    await new Promise((r) => setTimeout(r, 400));
    expect(c.provider.hasUnsyncedChanges, who).toBe(true);
  }
  expect(await headSeq(file)).toBe(before);
  expect(owner.text.toString()).not.toContain('SNEAK');
  expect(await stored(project)).not.toContain('SNEAK');
});

test('someone not on the paper, or with a bad ticket, cannot connect', async () => {
  const { file } = await paper();
  const stranger = client(users.outsider, file);
  await until('the connection to be refused', () => stranger.state.refused);
  expect(stranger.text.toString()).toBe('');

  const forged = client(users.owner, file, sync.port, () =>
    syncTicket('not-the-secret-not-the-secret-00', users.owner.id),
  );
  const expired = client(users.owner, file, sync.port, () =>
    syncTicket(SECRET, users.owner.id, -5),
  );
  const garbage = client(users.owner, file, sync.port, () => 'not.a.ticket');
  for (const c of [forged, expired, garbage]) {
    await until('the bad ticket to be refused', () => c.state.refused);
    expect(c.text.toString()).toBe('');
  }
});

test('taking away write access stops writes at once; removal ends the connection', async () => {
  const { project, file } = await paper();
  const owner = client(users.owner, file);
  const editor = client(users.editor, file);
  await saved(owner, editor);
  editor.text.insert(0, 'BEFORE ');
  await saved(editor);
  expect(await stored(project)).toContain('BEFORE ');

  await setRole(t.pool, users.owner.id, project, users.editor.id, 'viewer');
  const seq = await headSeq(file);
  editor.text.insert(0, 'AFTER ');
  await new Promise((r) => setTimeout(r, 400));
  expect(await headSeq(file)).toBe(seq);
  expect(owner.text.toString()).not.toContain('AFTER');
  expect(editor.provider.hasUnsyncedChanges).toBe(true);

  // Removed altogether: the connection is closed and cannot be opened again.
  const closedBefore = editor.state.closed;
  await removeMember(t.pool, users.owner.id, project, users.editor.id);
  await until('the connection to close', () => editor.state.closed > closedBefore);
  const again = client(users.editor, file);
  await until('connecting again to be refused', () => again.state.refused);
  owner.text.insert(0, 'SECRET ');
  await saved(owner);
  await new Promise((r) => setTimeout(r, 300));
  expect(editor.text.toString()).not.toContain('SECRET');
});

test('restoring a revision reaches people who have the file open, without a reload', async () => {
  const { project, file } = await paper();
  const good = await saveRevision(t.pool, store, users.owner.id, project, 'Good');
  const owner = client(users.owner, file);
  const editor = client(users.editor, file);
  await saved(owner, editor);
  editor.text.insert(editor.text.toString().indexOf('Hello.'), 'REGRET ');
  await saved(editor);
  await until('the owner to see the edit', () => owner.text.toString().includes('REGRET'));

  await restoreRevision(t.pool, store, users.owner.id, project, good.id);
  const original = MAIN.replaceAll('\r\n', '\n');
  await until(
    'both to see the restored text',
    () => owner.text.toString() === original && editor.text.toString() === original,
  );
  expect(await stored(project)).toBe(MAIN);
  // They can keep working from there.
  editor.text.insert(0, '% after restore\n');
  await saved(editor);
  expect(await stored(project)).toBe('% after restore\r\n' + MAIN);
});

test('deleting a file closes it for everyone; restoring brings back the same file without doubling text', async () => {
  const { project, file: main } = await paper();
  const notes = await createFile(
    t.pool,
    store,
    users.owner.id,
    project,
    'notes.tex',
    Buffer.from('One.\nTwo.\n'),
  );
  const owner = client(users.owner, notes);
  const editor = client(users.editor, notes);
  await saved(owner, editor);
  editor.text.insert(0, 'Zero.\n');
  await saved(editor);
  await until('the owner to see the edit', () => owner.text.toString().startsWith('Zero.'));
  expect(main).not.toBe(notes);

  // The editor's connection drops just before the delete, with an edit not yet sent.
  editor.provider.configuration.websocketProvider.disconnect();
  editor.text.insert(editor.text.length, 'Offline.\n');
  const closedBefore = owner.state.closed;
  await deleteFile(t.pool, store, users.owner.id, project, notes);
  await until('the open file to be closed', () => owner.state.closed > closedBefore);
  const refused = client(users.owner, notes);
  await until('opening the deleted file to be refused', () => refused.state.refused);

  // Deleting saved a revision. Restoring it brings the file back with its history, so a copy
  // that was open all along merges into it instead of adding its text a second time.
  const [before] = await listRevisions(t.pool, users.owner.id, project);
  await restoreRevision(t.pool, store, users.owner.id, project, before.id);
  await editor.provider.configuration.websocketProvider.connect();
  await saved(editor);
  const fresh = client(users.second, notes);
  await saved(fresh);
  const want = 'Zero.\nOne.\nTwo.\nOffline.\n';
  await until('both copies to agree', () => editor.text.toString() === want);
  expect(fresh.text.toString()).toBe(want);
});

test('killing the server mid-save loses nothing it acknowledged, and nothing at all after reconnect', async () => {
  const { project, file } = await paper();
  const port = sync.port + 1;
  const env = { ...process.env, ...TEST_ENV, DATABASE_URL: t.url, SYNC_PORT: String(port) };
  const start = () =>
    new Promise<void>((resolve, reject) => {
      child = spawn(process.execPath, [join(import.meta.dirname, 'main.ts')], {
        env,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
  await start();
  const writer = client(users.owner, file, port);
  await saved(writer);

  const ROUNDS = Number(process.env.KILLS ?? 15);
  let sent = 0;
  let checked = 0;
  for (let round = 0; round < ROUNDS; round++) {
    // Type steadily, one edit at a time, and kill the server without warning part way through.
    const killAt = 5 + Math.floor(Math.random() * 40);
    let acked = sent;
    for (let i = 0; i < killAt + 10; i++) {
      writer.text.insert(writer.text.length, `[${sent++}]`);
      await new Promise((r) => setTimeout(r, 2));
      // Edits are acknowledged in order, so everything but the unsynced tail is acknowledged.
      acked = sent - writer.provider.unsyncedChanges;
      if (i === killAt) child!.kill('SIGKILL');
    }
    await until(
      'the server to be gone',
      () => child!.exitCode !== null || child!.signalCode !== null,
    );
    // With the server dead, the log alone must hold every edit it acknowledged.
    const log = await stored(project);
    for (let k = 0; k < acked; k++)
      if (!log.includes(`[${k}]`))
        throw new Error(`round ${round}: acknowledged edit ${k} is not in the log`);
    checked += acked;
    await start();
    await saved(writer);
  }
  // After reconnecting, the edits that were never acknowledged have been sent again and saved.
  const final = await stored(project);
  for (let k = 0; k < sent; k++) expect(final.split(`[${k}]`).length - 1, `edit ${k}`).toBe(1);
  expect(final).toBe(writer.text.toString().replaceAll('\n', '\r\n'));
  expect(checked).toBeGreaterThan(ROUNDS * 5);
  child!.kill('SIGKILL');
});
