// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { type ChildProcess, spawn } from 'node:child_process';
import { type AddressInfo, createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  acceptInvitation,
  blobStore,
  compactFile,
  createFile,
  deleteFile,
  deleteProject,
  editFile,
  exportZip,
  importZip,
  invite,
  listFiles,
  listRevisions,
  readZip,
  recordGrammarOutcome,
  replaceFile,
  removeMember,
  renameFile,
  requestBuild,
  restoreRevision,
  runCommand,
  saveRevision,
  setRole,
  syncTicket,
  writeZip,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { applyMerge } from '../../../packages/server/src/merge-apply.ts';
import { planMerge } from '../../../packages/server/src/merge.ts';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { startVersion } from '../../../packages/server/src/versions.ts';
import { serveMetrics } from './metrics.ts';
import { startSync } from './server.ts';
import { type Client, closeAll, connect, saved, until } from './testing.ts';

const SECRET = TEST_ENV.BETTER_AUTH_SECRET;
const METRICS_TOKEN = 'a-token-for-the-metrics-page';
const store = blobStore(TEST_ENV);
const MAIN = '\\documentclass{article}\r\n\\begin{document}\r\nHello.\r\n\\end{document}\r\n';
let t: Awaited<ReturnType<typeof testDb>>;
let sync: Awaited<ReturnType<typeof startSync>>;
type User = { id: string; email: string };
const users = {} as Record<
  'owner' | 'editor' | 'second' | 'reviewer' | 'viewer' | 'outsider',
  User
>;
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
    // One owner makes a paper for every test here and invites four people to each: more than
    // one person may send in an hour, so the limit is lifted for this.
    const { token } = await invite(
      t.pool,
      users.owner.id,
      project.id,
      users[who].email,
      role,
      1000,
    );
    await acceptInvitation(t.pool, users[who].id, token);
  }
  const [file] = await listFiles(t.pool, users.owner.id, project.id);
  return { project: project.id, file: file.id };
}

const client = (user: User, file: string, port = sync.port, token?: () => string) =>
  connect(SECRET, user, file, port, token);

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
    // Up to 4349, so that the servers some tests start at +600 and +700 stay below 5060 and 5061:
    // WebSocket clients refuse those ports (they are on the web's list of ports never to connect
    // to), and a client pointed at one stays "connecting" for ever.
    port: 4200 + Math.floor(Math.random() * 150),
    databaseUrl: t.url,
    // Small, so that a test can type its way past it.
    compactEvery: 20,
    metricsToken: METRICS_TOKEN,
    // High: the clients here close only in afterAll, one person holds ten (three people, thirty
    // connections) to a file in one test, and all of them hold their connections to the end.
    connectionCap: { perFile: 100, perPerson: 100_000 },
  });
});
afterAll(async () => {
  child?.kill('SIGKILL');
  closeAll();
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

test('thirty connections type into one file at once, and nothing is lost', async () => {
  const { project, file } = await paper();
  const who = [users.owner, users.editor, users.second];
  const clients = Array.from({ length: 30 }, (_, i) => client(who[i % 3], file));
  await saved(...clients);
  const start = performance.now();
  // Twenty rounds, everyone adding to the end of the file in each, a moment apart. The log is
  // compacted every twenty edits here, so that happens some thirty times under them.
  for (let round = 0; round < 20; round++) {
    for (const [i, c] of clients.entries()) c.text.insert(c.text.length, `<${i}.${round}>`);
    await new Promise((r) => setTimeout(r, 10));
  }
  await saved(...clients);
  await until('everyone to have the same text', () =>
    clients.every((c) => c.text.toString() === clients[0].text.toString()),
  );
  // Measured at about a second on the machine this was written on. The limit is for a
  // slowdown of many times, not for a slow day.
  expect(performance.now() - start).toBeLessThan(30_000);
  const text = clients[0].text.toString();
  const missing: string[] = [];
  for (let i = 0; i < 30; i++)
    for (let round = 0; round < 20; round++)
      if (!text.includes(`<${i}.${round}>`)) missing.push(`${i}.${round}`);
  expect(missing).toEqual([]);
  expect(await stored(project)).toBe(text.replaceAll('\n', '\r\n'));
}, 120_000);

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
    syncTicket('not-the-secret-not-the-secret-00', users.owner.id, file),
  );
  const expired = client(users.owner, file, sync.port, () =>
    syncTicket(SECRET, users.owner.id, file, -5),
  );
  const garbage = client(users.owner, file, sync.port, () => 'not.a.ticket');
  // A good ticket, for another file that is theirs too: it opens only the file it names.
  const other = (await paper()).file;
  const elsewhere = client(users.owner, file, sync.port, () =>
    syncTicket(SECRET, users.owner.id, other),
  );
  for (const c of [forged, expired, garbage, elsewhere]) {
    await until('the bad ticket to be refused', () => c.state.refused);
    expect(c.text.toString()).toBe('');
  }
});

test('signing out closes the editors opened under that sign-in, and no others', async () => {
  const { file } = await paper();
  // The same person, signed in twice: on this browser and on another.
  await t.signIn(users.second.email);
  await t.signIn(users.second.email);
  const [here, elsewhere]: string[] = (
    await t.pool.query(
      'select id from session where "userId" = $1 order by "createdAt" desc limit 2',
      [users.second.id],
    )
  ).rows.map((r) => r.id);
  const ticket = (session?: string) => syncTicket(SECRET, users.second.id, file, 60, session);
  const first = client(users.second, file, sync.port, () => ticket(here));
  const other = client(users.second, file, sync.port, () => ticket(elsewhere));
  // A ticket that names no sign-in, as the server's own tests make them.
  const unnamed = client(users.second, file);
  for (const c of [first, other, unnamed])
    await until('the file to arrive', () => c.text.toString().includes('Hello.'));

  await t.pool.query('delete from session where id = $1', [here]);
  await until('the connection to be closed', () =>
    first.state.reasons.some((r) => r.endsWith('signed-out')),
  );
  // (What the editor does next, ask for a ticket and find itself signed out, is a browser test.)
  // The same person's other sign-in is untouched, and goes on editing.
  expect(other.state.reasons).toEqual([]);
  expect(unnamed.state.reasons).toEqual([]);
  other.text.insert(0, '% still here\n');
  await saved(other);
  expect(unnamed.text.toString()).toContain('% still here');
  expect(first.text.toString()).not.toContain('% still here');
});

/** Two sign-ins for the second user, newest first. */
async function twoSignIns() {
  await t.pool.query('delete from sign_in_links');
  await t.signIn(users.second.email);
  await t.signIn(users.second.email);
  const ids: string[] = (
    await t.pool.query(
      'select id from session where "userId" = $1 order by "createdAt" desc limit 2',
      [users.second.id],
    )
  ).rows.map((r) => r.id);
  return ids;
}
const runOut = (id: string) =>
  t.pool.query(`update session set "expiresAt" = now() - interval '1 minute' where id = $1`, [id]);

test('a sign-in that runs out closes the editors opened under it, and no others', async () => {
  const { file } = await paper();
  const [here, elsewhere] = await twoSignIns();
  const quick = await startSync({
    pool: t.pool,
    store,
    secret: SECRET,
    port: sync.port + 500,
    databaseUrl: t.url,
    sessionCheckMs: 100,
  });
  try {
    const ticket = (session?: string) => syncTicket(SECRET, users.second.id, file, 60, session);
    const first = client(users.second, file, quick.port, () => ticket(here));
    const other = client(users.second, file, quick.port, () => ticket(elsewhere));
    const unnamed = client(users.second, file, quick.port);
    for (const c of [first, other, unnamed])
      await until('the file to arrive', () => c.text.toString().includes('Hello.'));

    await runOut(here);
    await until('the connection to be closed', () =>
      first.state.reasons.some((r) => r.endsWith('signed-out')),
    );
    expect(other.state.reasons).toEqual([]);
    expect(unnamed.state.reasons).toEqual([]);
    other.text.insert(0, '% still here\n');
    await saved(other);
    expect(unnamed.text.toString()).toContain('% still here');
    expect(first.text.toString()).not.toContain('% still here');
    // The sync server neither renews nor deletes sign-ins.
    expect((await t.pool.query('select 1 from session where id = $1', [here])).rowCount).toBe(1);
  } finally {
    closeAll();
    await quick.stop();
  }
});

test('a ticket under a sign-in that has since run out is not served', async () => {
  const { file } = await paper();
  const [id] = await twoSignIns();
  await runOut(id);
  const late = client(users.second, file, sync.port, () =>
    syncTicket(SECRET, users.second.id, file, 60, id),
  );
  await until('the connection to be closed', () =>
    late.state.reasons.some((r) => r.endsWith('signed-out')),
  );
});

test('taking away write access stops writes at once; removal ends the connection', async () => {
  const { project, file } = await paper();
  const owner = client(users.owner, file);
  const editor = client(users.editor, file);
  await saved(owner, editor);
  editor.text.insert(0, 'BEFORE ');
  await saved(editor);
  expect(await stored(project)).toContain('BEFORE ');

  // An editor is told its person's role when it connects, and again when it changes: its page
  // was made for the role they had when it loaded.
  const told = (c: Client) =>
    c.state.replies.filter((r) => r.role).map((r) => `${r.role} ${r.canWrite}`);
  expect(told(editor)).toEqual(['editor true']);
  expect(told(owner)).toEqual(['owner true']);
  await setRole(t.pool, users.owner.id, project, users.editor.id, 'viewer');
  await until('the editor to be told', () => told(editor).length === 2);
  expect(told(editor)).toEqual(['editor true', 'viewer false']);
  expect(told(owner)).toEqual(['owner true']);
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

/**
 * A second server whose store holds back every read until the test lets it go, so that a
 * connection is in the stretch where its file is still being read: not yet registered with the
 * library, and so not seen by anything that walks the open connections. `started` says a read
 * has begun, so that nothing here is timed with sleeps.
 */
async function slowLoading(
  run: (hold: { started: Promise<void>; release: () => void; port: number }) => Promise<void>,
) {
  let begin!: () => void;
  let release!: () => void;
  const started = new Promise<void>((r) => (begin = r));
  const open = new Promise<void>((r) => (release = r));
  const slow = startSync({
    pool: t.pool,
    store: {
      ...store,
      get: async (digest: string) => {
        begin();
        await open;
        return store.get(digest);
      },
    },
    secret: SECRET,
    port: sync.port + 500,
    databaseUrl: t.url,
  });
  const server = await slow;
  try {
    await run({ started, release, port: server.port });
  } finally {
    release();
    closeAll();
    await server.stop();
  }
}

test('someone removed while the file is still being read is closed, and never reads on', async () => {
  const { project, file } = await paper();
  await slowLoading(async ({ started, release, port }) => {
    const editor = client(users.editor, file, port);
    await started;
    await removeMember(t.pool, users.owner.id, project, users.editor.id);
    // The owner joins the same reading, and types once it is done.
    const owner = client(users.owner, file, port);
    release();
    await until('the editor to be closed for good', () =>
      editor.state.reasons.some((r) => r.endsWith('no-access')),
    );
    await until('the owner to have the file', () => owner.text.toString().includes('Hello.'));
    owner.text.insert(0, 'SECRET ');
    await saved(owner);
    await new Promise((r) => setTimeout(r, 300));
    expect(editor.text.toString()).not.toContain('SECRET');
  });
});

test('a role lowered while the file is still being read is in force when it opens', async () => {
  const { file, project } = await paper();
  await slowLoading(async ({ started, release, port }) => {
    const editor = client(users.editor, file, port);
    await started;
    await setRole(t.pool, users.owner.id, project, users.editor.id, 'viewer');
    release();
    await until('the editor to be told its role', () => editor.state.replies.some((r) => r.role));
    await until('the file to arrive', () => editor.text.toString().includes('Hello.'));
    const told = editor.state.replies.filter((r) => r.role);
    expect(told.at(-1)).toMatchObject({ role: 'viewer', canWrite: false });
    expect(told.some((r) => r.canWrite)).toBe(false);
    const seq = await headSeq(file);
    editor.text.insert(0, 'AFTER ');
    await new Promise((r) => setTimeout(r, 400));
    expect(await headSeq(file)).toBe(seq);
  });
});

test('a sign-in that ends while the file is still being read closes the connection', async () => {
  const { file } = await paper();
  // This person has signed in several times in this file; one address is only sent so many
  // links in a burst, so the record of them is cleared (the limit is tested in auth.sandbox.test.ts).
  await t.pool.query('delete from sign_in_links');
  await t.signIn(users.second.email);
  const [id]: string[] = (
    await t.pool.query(
      'select id from session where "userId" = $1 order by "createdAt" desc limit 1',
      [users.second.id],
    )
  ).rows.map((r) => r.id);
  await slowLoading(async ({ started, release, port }) => {
    const c = client(users.second, file, port, () =>
      syncTicket(SECRET, users.second.id, file, 60, id),
    );
    await started;
    await t.pool.query('delete from session where id = $1', [id]);
    release();
    await until('the connection to be closed', () =>
      c.state.reasons.some((r) => r.endsWith('signed-out')),
    );
  });
});

test('every connection to the database is lost at once, and the server carries on', async () => {
  const { project, file } = await paper();
  const owner = client(users.owner, file);
  const editor = client(users.editor, file);
  await saved(owner, editor);
  const told = (c: Client) => c.state.replies.filter((r) => r.role).map((r) => r.role);

  // What a restart of the database looks like from here: every connection there was is gone,
  // the one the server listens on included. This once ended the server's process.
  await t.pool.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
     where datname = current_database() and pid <> pg_backend_pid()`,
  );
  // Two things happen before the server can be listening again, so it is not told of either:
  // an edit is made on the server, and the editor's role is lowered.
  await editFile(t.pool, store, file, users.owner.id, (text) =>
    text.insert(0, '% made on the server\n'),
  );
  await setRole(t.pool, users.owner.id, project, users.editor.id, 'viewer');

  // It finds both out for itself once it is listening again.
  await until('the edit to reach the people in the file', () =>
    [owner, editor].every((c) => c.text.toString().includes('% made on the server')),
  );
  await until('the editor to be told of the lowered role', () => told(editor).at(-1) === 'viewer');
  // And it is listening again: what is announced from now on is heard.
  await setRole(t.pool, users.owner.id, project, users.editor.id, 'editor');
  await until(
    'the editor to be told of the role given back',
    () => told(editor).at(-1) === 'editor',
  );
  // Nobody was disconnected, and typing is saved as before.
  expect(owner.state.closed + editor.state.closed).toBe(0);
  editor.text.insert(0, '% typed afterwards\n');
  await saved(editor);
  expect(await stored(project)).toContain('% typed afterwards');
  expect(await stored(project)).toContain('% made on the server');
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

test('a restore is announced to the people who have the file open, after its edits', async () => {
  const { project, file } = await paper();
  const good = await saveRevision(t.pool, store, users.owner.id, project, 'Good');
  const editor = client(users.editor, file);
  await saved(editor);
  editor.text.insert(editor.text.toString().indexOf('Hello.'), 'REGRET ');
  await saved(editor);
  const told = () => editor.state.replies.filter((r) => r.restored !== undefined);
  expect(told()).toEqual([]);

  const made = await restoreRevision(t.pool, store, users.owner.id, project, good.id);
  await until('the editor to be told of the restore', () => told().length > 0);
  expect(told()[0].restored).toBe(made.number);
  // The restored text had reached it by then: the signal does not outrun the edits.
  expect(told()[0].had).toBe(MAIN.replaceAll('\r\n', '\n'));
  // With it, what the editor says to the person: who restored the paper, to what, and which
  // revision keeps the paper as it was.
  expect(told()[0].restore).toMatchObject({
    number: made.number,
    from: good.number,
    fromName: 'Good',
    by: users.owner.email,
    kept: { number: made.number - 1 },
  });
});

test('a merge is announced as a restore is, after its edits, with what was merged', async () => {
  // The owner alone: the service sends invitations at a limited rate, and the others have none to give.
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  const [made1] = await importZip(t.pool, store, users.owner.id, zip, 'Merge test');
  const project = made1.id as string;
  const file = (await listFiles(t.pool, users.owner.id, project))[0].id as string;
  const first = await saveRevision(t.pool, store, users.owner.id, project, 'First');
  const v = await startVersion(t.pool, store, users.owner.id, project, first.id, 'camera-ready', {
    env: { VERSIONS: '1' },
  });
  const [theirs] = await listFiles(t.pool, users.owner.id, v.id);
  await editFile(t.pool, store, theirs.id, users.owner.id, (y) =>
    y.insert(y.toString().indexOf('Hello.'), 'Merged '),
  );
  const editor = client(users.owner, file);
  await saved(editor);
  const told = () => editor.state.replies.filter((r) => r.restored !== undefined);
  expect(told()).toEqual([]);

  const plan = await planMerge(t.pool, store, users.owner.id, project, v.id);
  const made = await applyMerge(
    t.pool,
    store,
    users.owner.id,
    project,
    v.id,
    { target: plan.target.revision, source: plan.source.revision, base: plan.base.revision },
    {},
  );
  await until('the editor to be told of the merge', () => told().length > 0);
  expect(told()[0].restored).toBe(made.number);
  // The merged text had reached it by then.
  expect(told()[0].had).toContain('Merged Hello.');
  expect(told()[0].restore).toMatchObject({
    number: made.number,
    kept: { number: made.number - 1 },
    merge: { paper: v.id, version: 'camera-ready' },
  });
});

test('a file added, renamed or deleted is announced to the people who have the paper open, and to no one else', async () => {
  const { project, file } = await paper();
  const other = await paper();
  const editor = client(users.editor, file);
  const elsewhere = client(users.editor, other.file);
  await saved(editor, elsewhere);
  const told = (c: Client) => c.state.replies.filter((r) => r.files !== undefined).length;
  expect(told(editor)).toBe(0);

  const notes = await createFile(t.pool, store, users.owner.id, project, 'notes.tex');
  await until('the editor to be told of the new file', () => told(editor) === 1);
  await renameFile(t.pool, users.owner.id, project, notes, 'sections/notes.tex');
  await until('the editor to be told of the new name', () => told(editor) === 2);
  await deleteFile(t.pool, store, users.owner.id, project, notes);
  await until('the editor to be told the file is gone', () => told(editor) === 3);
  // Only that something changed: the list is asked of the web app, which checks who asks.
  expect(editor.state.replies.filter((r) => r.files !== undefined)[0]).toMatchObject({
    files: true,
  });
  // Typing went on through all of it, and another paper's editors heard nothing.
  editor.text.insert(0, '% still here\n');
  await saved(editor);
  expect(editor.state.closed).toBe(0);
  expect(told(elsewhere)).toBe(0);
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

test('typing that queues behind a delete is not acknowledged, and the editor is closed', async () => {
  const { project, file: main } = await paper();
  const notes = await createFile(
    t.pool,
    store,
    users.owner.id,
    project,
    'notes.tex',
    Buffer.from('One.\nTwo.\n'),
  );
  expect(main).not.toBe(notes);
  const editor = client(users.editor, notes);
  await saved(editor);
  // The delete holds every file row once it has locked them. Just after, the editor types,
  // and the delete goes on only when that edit is waiting for the rows.
  let locked = false;
  let acted = false;
  const spy = new Proxy(t.pool, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop !== 'connect') return typeof v === 'function' ? v.bind(target) : v;
      return async () => {
        const c = await target.connect();
        return new Proxy(c, {
          get(cc, p) {
            const w = Reflect.get(cc, p);
            if (p !== 'query') return typeof w === 'function' ? w.bind(cc) : w;
            return async (sql: string, params?: unknown[]) => {
              if (locked && !acted) {
                acted = true;
                editor.text.insert(0, 'LATE ');
                for (let i = 0; i < 400; i++) {
                  const waiting = await t.pool.query(
                    `select 1 from pg_stat_activity where datname = current_database()
                     and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
                  );
                  if (waiting.rowCount) break;
                  await new Promise((r) => setTimeout(r, 25));
                }
              }
              if (/for update/.test(sql)) locked = true;
              return cc.query(sql, params);
            };
          },
        });
      };
    },
  });
  const closedBefore = editor.state.closed;
  const { revision } = await deleteFile(spy, store, users.owner.id, project, notes);
  await until('the editor to be closed', () => editor.state.closed > closedBefore);
  expect(editor.state.reasons.at(-1)).toMatch(/no-access/);
  const [head] = (await t.pool.query('select head_seq from all_files where id = $1', [notes])).rows;
  const rev = (
    await t.pool.query(
      `select rf.seq from revision_files rf join revisions r on r.id = rf.revision_id
       where rf.file_id = $1 and r.project_id = $2 and r.number = $3`,
      [notes, project, revision],
    )
  ).rows[0];
  const above = await t.pool.query(
    'select count(*)::int as n from file_updates where file_id = $1 and seq > $2',
    [notes, rev.seq],
  );
  expect(above.rows[0].n).toBe(0);
  expect(String(head.head_seq)).toBe(String(rev.seq));
});

test('a structural edit asked for over the connection is answered before it is broadcast', async () => {
  const { project, file } = await paper();
  const owner = client(users.owner, file);
  const editor = client(users.editor, file);
  const reviewer = client(users.reviewer, file);
  await saved(owner, editor, reviewer);
  const ask = (c: Client, expected: string, replacement: string, key = crypto.randomUUID()) => {
    const from = c.text.toString().indexOf(expected);
    const at = (i: number) =>
      Buffer.from(
        Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(c.text, i)),
      ).toString('base64url');
    const command = { key, from: at(from), to: at(from + expected.length), expected, replacement };
    c.provider.sendStateless(JSON.stringify(command));
    return until('an answer', () => c.state.replies.some((r) => r.key === key)).then(() =>
      c.state.replies.find((r) => r.key === key)!,
    );
  };

  // The editor types, then asks at once. The typing is in before the edit is checked.
  editor.text.insert(editor.text.toString().indexOf('Hello.') + 5, ' again');
  const key = crypto.randomUUID();
  const done = await ask(editor, 'Hello again.', '\\emph{Hello again.}', key);
  expect(done.result).toBe('applied');
  // The answer came first: the author did not yet have the edit, and gets it in the answer.
  expect(done.had).toContain('Hello again.');
  expect(done.had).not.toContain('\\emph');
  Y.applyUpdate(editor.doc, Buffer.from(done.update!, 'base64url'), 'mine');
  await until('everyone to see it', () =>
    [owner, editor, reviewer].every((c) => c.text.toString().includes('\\emph{Hello again.}')),
  );
  expect(await stored(project)).toBe(MAIN.replace('Hello.', '\\emph{Hello again.}'));

  // The same key again, a stale edit, a reviewer, and nonsense: answered, and nothing changes.
  editor.state.replies.length = 0;
  expect((await ask(editor, 'Hello again.', 'TWICE', key)).result).toBe('duplicate');
  const stale = crypto.randomUUID();
  editor.provider.sendStateless(
    JSON.stringify({
      key: stale,
      from: 'AQZzb3VyY2UA',
      to: 'AQZzb3VyY2UA',
      expected: 'no longer there',
      replacement: 'STALE',
    }),
  );
  await until('the stale answer', () => editor.state.replies.some((r) => r.key === stale));
  expect(editor.state.replies.find((r) => r.key === stale)).toMatchObject({ result: 'conflict' });
  expect((await ask(reviewer, 'Hello', 'REVIEWER')).error).toBe('You cannot edit this file.');
  editor.provider.sendStateless('not json at all');
  editor.provider.sendStateless(JSON.stringify({ key: 'k', from: 7 }));
  await until('the refusals', () => editor.state.replies.filter((r) => r.error).length === 2);
  await new Promise((r) => setTimeout(r, 200));
  expect(await stored(project)).toBe(MAIN.replace('Hello.', '\\emph{Hello again.}'));
  expect(owner.text.toString()).toBe(editor.text.toString());
});

const logRows = async (file: string) =>
  (await t.pool.query('select count(*)::int as n from file_updates where file_id = $1', [file]))
    .rows[0].n;

test('an insertion whose neighbours were deleted is refused, and the text is left as it was', async () => {
  const { project, file } = await paper();
  const editor = client(users.editor, file);
  const owner = client(users.owner, file);
  await saved(editor, owner);
  const place = editor.text.toString().indexOf('Hello.') + 'Hel'.length;
  const rel = (i: number, assoc = 0) =>
    Buffer.from(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(editor.text, i, assoc)),
    ).toString('base64url');
  const command = {
    key: crypto.randomUUID(),
    from: rel(place, -1),
    to: rel(place),
    expected: '',
    replacement: '~\\cite{knuth}',
  };
  // Someone deletes the paragraph, and the server has it before the insertion is asked for.
  // (The file is held with \n line ends.)
  const after = owner.text.toString().replace('Hello.\n', '');
  owner.text.delete(owner.text.toString().indexOf('Hello.'), 'Hello.\n'.length);
  await saved(owner, editor);
  await until('the delete', () => editor.text.toString() === after);
  editor.provider.sendStateless(JSON.stringify(command));
  await until('an answer', () => editor.state.replies.some((r) => r.key === command.key));
  expect(editor.state.replies.find((r) => r.key === command.key)).toMatchObject({
    result: 'conflict',
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(await stored(project)).toBe(MAIN.replace('Hello.\r\n', ''));
  expect(owner.text.toString()).toBe(after);
});

test('an insertion at the ends of the file, or after typing elsewhere, still applies', async () => {
  const { project, file } = await paper();
  const editor = client(users.editor, file);
  const owner = client(users.owner, file);
  await saved(editor, owner);
  const insert = async (i: number, replacement: string) => {
    const rel = (assoc: number) =>
      Buffer.from(
        Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(editor.text, i, assoc)),
      ).toString('base64url');
    const key = crypto.randomUUID();
    editor.provider.sendStateless(
      JSON.stringify({ key, from: rel(-1), to: rel(0), expected: '', replacement }),
    );
    await until('an answer', () => editor.state.replies.some((r) => r.key === key));
    return editor.state.replies.find((r) => r.key === key)!;
  };
  const was = editor.text.toString();
  expect((await insert(0, '% top\n')).result).toBe('applied');
  expect((await insert(was.length + '% top\n'.length, '% end\n')).result).toBe('applied');
  // The place is named, then someone types elsewhere, then the insertion is asked for.
  const mid = editor.text.toString().indexOf('Hello.') + 'Hel'.length;
  owner.text.insert(0, '% typed\n');
  await saved(owner, editor);
  await until('the typing', () => editor.text.toString().startsWith('% typed\n'));
  expect((await insert(mid + '% typed\n'.length, '~')).result).toBe('applied');
  await until('everyone to see it', () => owner.text.toString().includes('Hel~lo.'));
  const want = '% typed\n% top\n' + was.replace('Hello.', 'Hel~lo.') + '% end\n';
  expect(owner.text.toString()).toBe(want);
  await saved(owner, editor);
  expect((await stored(project)).replace(/\r\n/g, '\n')).toBe(want);
});

test('a command reaches people who have the file open, and a stale one tells its author', async () => {
  const { project, file } = await paper();
  const owner = client(users.owner, file);
  const editor = client(users.editor, file);
  await saved(owner, editor);
  const command = (c: Client, expected: string, replacement: string) => {
    const from = c.text.toString().indexOf(expected);
    const at = (i: number) =>
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(c.text, i));
    return {
      key: crypto.randomUUID(),
      from: at(from),
      to: at(from + expected.length),
      expected,
      replacement,
    };
  };
  // The editor makes "Hello." bold. The owner types inside it before the command arrives.
  const bold = command(editor, 'Hello.', '\\textbf{Hello.}');
  owner.text.insert(owner.text.toString().indexOf('Hello.') + 5, ' there');
  await saved(owner);
  const refused = await runCommand(t.pool, store, users.editor.id, file, bold);
  expect(refused).toMatchObject({ result: 'conflict' });
  expect((refused as { text: string }).text).toContain('Hello there.');
  // Once the owner's typing has reached the editor, the same action applies and both see it.
  await until('the typing to arrive', () => editor.text.toString().includes('Hello there.'));
  const again = command(editor, 'Hello there.', '\\textbf{Hello there.}');
  expect(await runCommand(t.pool, store, users.editor.id, file, again)).toMatchObject({
    result: 'applied',
  });
  await until('both to see the command', () =>
    [owner, editor].every((c) => c.text.toString().includes('\\textbf{Hello there.}')),
  );
  expect(await stored(project)).toBe(MAIN.replace('Hello.', '\\textbf{Hello there.}'));
});

test('the log is compacted as it grows, and someone who was offline through it still merges', async () => {
  const { project, file } = await paper();
  const owner = client(users.owner, file);
  const editor = client(users.editor, file);
  await saved(owner, editor);
  // The editor goes offline and keeps typing.
  editor.provider.configuration.websocketProvider.disconnect();
  editor.text.insert(editor.text.toString().indexOf('Hello.'), 'OFFLINE ');
  // Meanwhile the owner types enough to compact the log more than once.
  for (let i = 0; i < 50; i++) {
    owner.text.insert(owner.text.length, `line ${i}\n`);
    await saved(owner);
  }
  await until('the log to be compacted', async () => (await logRows(file)) < 20);
  // A server edit made straight after a compaction still reaches the open file.
  await compactFile(t.pool, file);
  const at = (i: number) =>
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(owner.text, i));
  const first = owner.text.toString().indexOf('line 0\n');
  const done = await runCommand(t.pool, store, users.owner.id, file, {
    key: crypto.randomUUID(),
    from: at(first),
    to: at(first + 7),
    expected: 'line 0\n',
    replacement: '% first\n',
  });
  expect(done).toMatchObject({ result: 'applied' });
  await until('the command to arrive', () => owner.text.toString().includes('% first\n'));
  owner.text.insert(0, '% top\n');
  await saved(owner);
  await compactFile(t.pool, file);
  expect(await logRows(file)).toBe(1);

  await editor.provider.configuration.websocketProvider.connect();
  await saved(editor);
  const fresh = client(users.second, file);
  await saved(fresh);
  await until('everyone to agree', () =>
    [owner, editor].every((c) => c.text.toString() === fresh.text.toString()),
  );
  const text = fresh.text.toString();
  expect(text.startsWith('% top\n')).toBe(true);
  expect(text).toContain('OFFLINE Hello.');
  expect(text).toContain('% first\n');
  expect(text.match(/line \d+\n/g)).toHaveLength(49);
  expect(await stored(project)).toBe(text.replaceAll('\n', '\r\n'));
});

test('an edit that is too large is not saved, and its author is told why', async () => {
  const { project, file } = await paper();
  const refusals = (c: { state: { reasons: string[] } }) =>
    c.state.reasons.filter((r) => r.endsWith(':too-large')).length;

  // One edit of more than two megabytes.
  const owner = client(users.owner, file);
  const editor = client(users.editor, file);
  await saved(owner, editor);
  owner.text.insert(0, 'y'.repeat(2_100_000));
  // It is refused, and refused again when the client sends it again: never taken.
  // Refused with the reason, which is what stops the editor sending it again.
  await until('the large edit to be refused', () => refusals(owner) === 1);
  owner.provider.destroy();
  // Larger than anything read off the wire: the connection is closed before it is looked at.
  const huge = client(users.second, file);
  await saved(huge);
  huge.text.insert(0, 'z'.repeat(4_100_000));
  await until('the huge edit to close the connection', () =>
    huge.state.reasons.some((r) => r.startsWith('1009:')),
  );
  huge.provider.destroy();
  // Everyone else carries on, and nothing of either edit was kept.
  editor.text.insert(0, '% small\n');
  await saved(editor);
  const held = `% small\n${MAIN.replaceAll('\r\n', '\n')}`;
  expect(editor.text.toString()).toBe(held);
  expect(await stored(project)).toBe(`% small\r\n${MAIN}`);

  // A file cannot be typed past the limit either, here set low. Edits that do not take it over
  // are taken as before, and one that makes it shorter is taken at the limit.
  const low = await startSync({
    pool: t.pool,
    store,
    secret: SECRET,
    port: sync.port + 600,
    databaseUrl: t.url,
    maxFileText: held.length + 40,
  });
  try {
    const a = client(users.owner, file, low.port);
    const b = client(users.editor, file, low.port);
    await saved(a, b);
    a.text.insert(0, '% thirty characters of comment\n');
    await saved(a);
    b.text.insert(0, '% and this one is over\n');
    await until('the edit over the limit to be refused', () => refusals(b) >= 1);
    b.provider.destroy();
    a.text.delete(0, 9);
    a.text.insert(0, '% fine\n');
    await saved(a);
    const text = await stored(project);
    expect(text).not.toContain('over');
    expect(text.startsWith('% fine\r\n')).toBe(true);
    // A structural edit is held to the same limit.
    const place = (i: number) =>
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(a.text, i));
    const add = (n: number) =>
      runCommand(
        t.pool,
        store,
        users.owner.id,
        file,
        {
          key: crypto.randomUUID(),
          from: place(0),
          to: place(0),
          expected: '',
          replacement: 'x'.repeat(n),
        },
        { maxFileText: held.length + 40 },
      );
    await expect(add(60)).rejects.toThrow('it would make the file too large');
    expect(await add(5)).toMatchObject({ result: 'applied' });
  } finally {
    await low.stop();
  }
});

test('what someone typed as they left reaches whoever opens the file next', async () => {
  // The library can drop a connection from its file as its socket closes and still go on
  // through the edits that connection had sent. When the last other person then leaves, the
  // file is unloaded with those edits still to come. They are saved, and must still reach the
  // next person in, who will have opened the file from the log before they were written to it.
  //
  // A server whose writes to the log are slow, so that the edits are still queued when their
  // author has gone and the next person has arrived.
  const slow = new Proxy(t.pool, {
    get(pool, key) {
      if (key !== 'query') return Reflect.get(pool, key, pool);
      return async (...args: unknown[]) => {
        if (String(args[0]).includes('insert into file_updates'))
          await new Promise((r) => setTimeout(r, 25));
        return (pool.query as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
  const server = await startSync({
    pool: slow,
    store,
    secret: SECRET,
    port: sync.port + 700,
    databaseUrl: t.url,
  });
  try {
    const { project, file } = await paper();
    const leaving = client(users.owner, file, server.port);
    const other = client(users.second, file, server.port);
    await saved(leaving, other);
    // One message for each edit, so that the server has a queue of them.
    for (let i = 0; i < 20; i++) {
      leaving.text.insert(0, `<${i}>\n`);
      await new Promise((r) => setImmediate(r));
    }
    // The author goes with most of the edits still waiting their turn. Then the other person
    // goes, who has nothing waiting: with nobody listed, the file is unloaded there and then.
    leaving.socket.disconnect();
    await new Promise((r) => setTimeout(r, 80));
    other.socket.disconnect();
    await new Promise((r) => setTimeout(r, 80));
    expect(await stored(project)).not.toContain('<19>');
    const arriving = client(users.editor, file, server.port);
    await saved(arriving);
    // Neither comes back. Everything that was saved, the one who arrived has, without having
    // to open the file again.
    await until('the edits still queued to be saved', async () =>
      (await stored(project)).includes('<19>'),
    );
    await until(
      'the arrival to have the stored text',
      async () => arriving.text.toString().replaceAll('\n', '\r\n') === (await stored(project)),
      3000,
    );
    expect(arriving.text.toString()).toContain('<0>');
  } finally {
    await server.stop();
  }
});

test('the metrics page gives counts to whoever holds the token, and nothing to anyone else', async () => {
  const url = `http://127.0.0.1:${sync.port}/metrics`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { authorization: 'Bearer wrong-token' } })).status).toBe(401);
  // With no token set, there is no such page.
  const answer = { status: 0, writeHead: (code: number) => void (answer.status = code), end() {} };
  const asked = { url: '/metrics', headers: { authorization: 'Bearer anything' } };
  expect(await serveMetrics(asked as never, answer as never, undefined, async () => '')).toBe(true);
  expect(answer.status).toBe(404);

  const read = async () => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const value = (name: string) => Number(new RegExp(`^${name} (\\S+)$`, 'm').exec(text)?.[1]);
    return Object.assign(value, { text });
  };
  const { project, file } = await paper();
  const owner = client(users.owner, file);
  const reviewer = client(users.reviewer, file);
  await saved(owner, reviewer);
  const before = await read();
  await recordGrammarOutcome(t.pool, users.owner.id, project, 'grammar', 'rule_off');
  owner.text.insert(0, 'COUNTED-NOT-QUOTED ');
  await saved(owner);
  reviewer.text.insert(0, 'refused ');
  const outsider = client(users.outsider, file);
  await until('the outsider to be refused', () => outsider.state.refused);
  await until(
    'the refused edit to be counted',
    async () =>
      (await read())('paperweave_sync_edits_rejected_total') >
      before('paperweave_sync_edits_rejected_total'),
  );
  await requestBuild(t.pool, users.owner.id, project);
  const after = await read();
  const more = (name: string) => after(name) - before(name);
  expect(more('paperweave_sync_edits_saved_total')).toBeGreaterThanOrEqual(1);
  expect(more('paperweave_sync_edits_rejected_total')).toBe(1);
  expect(more('paperweave_sync_refused_connections_total')).toBe(1);
  expect(after('paperweave_sync_connections_open')).toBeGreaterThanOrEqual(2);
  expect(more('paperweave_builds_queued')).toBe(1);
  expect(after('paperweave_build_queue_age_seconds')).toBeGreaterThan(0);
  expect(after('paperweave_builds_last_hour{result="failed"}')).toBe(0);
  // How papers fare is there too: this paper was imported, and its owner has edited it.
  expect(after('paperweave_papers{origin="imported"}')).toBeGreaterThanOrEqual(1);
  expect(after('paperweave_papers_edited')).toBeGreaterThanOrEqual(1);
  expect(after.text).toMatch(/^# TYPE paperweave_papers_two_authors gauge$/m);
  // What became of the grammar checker's findings: a count by kind and outcome.
  expect(after.text).toMatch(/^# TYPE paperweave_grammar_suggestions gauge$/m);
  expect(after('paperweave_grammar_suggestions{kind="grammar",outcome="rule_off"}')).toBe(1);
  // Counts only: nothing anyone typed is on the page.
  expect(after.text).not.toContain('COUNTED');
  expect(after.text).toMatch(/^# TYPE paperweave_sync_edits_saved_total counter$/m);
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

test('an editor of a file that goes back to Latin-1 in a restore is closed', async () => {
  const { project, file: main } = await paper();
  const latin = Buffer.from('@book{a, author = {Jos\xe9}}\n', 'latin1');
  const bib = await createFile(t.pool, store, users.owner.id, project, 'refs.bib', latin);
  expect(bib).not.toBe(main);
  const r1 = await saveRevision(t.pool, store, users.owner.id, project, 'Latin-1');
  await replaceFile(
    t.pool,
    store,
    users.owner.id,
    project,
    'refs.bib',
    Buffer.from('@book{a, author = {Jos\u00e9}}\n'),
  );
  const editor = client(users.editor, bib);
  await saved(editor);
  const closedBefore = editor.state.closed;
  await restoreRevision(t.pool, store, users.owner.id, project, r1.id);
  await until('the editor to be closed', () => editor.state.closed > closedBefore);
  expect(editor.state.reasons.at(-1)).toMatch(/no-access/);
});

test('a paper deleted under its editors closes them for good, and the server serves on', async () => {
  const { project, file } = await paper();
  const other = await paper();
  const editor = client(users.editor, file);
  const owner = client(users.owner, file);
  await saved(editor);
  await saved(owner);
  // Someone is typing as it goes: whether this edit is saved first or refused, nothing breaks.
  editor.text.insert(0, 'LAST ');
  await deleteProject(t.pool, users.owner.id, project, 'Sync test');
  await until('both editors to be closed for good', () =>
    [editor, owner].every((c) => c.state.reasons.some((r) => r.endsWith('no-access'))),
  );
  editor.text.insert(0, 'AFTER ');
  const again = client(users.editor, file);
  await until('connecting again to be refused', () => again.state.refused);
  const { rows } = await t.pool.query(
    'select (select count(*)::int from all_files where project_id = $1) as files, (select count(*)::int from file_updates where file_id = $2) as edits',
    [project, file],
  );
  expect(rows[0]).toEqual({ files: 0, edits: 0 });
  // Another paper's editors are not disturbed, and what they type is saved.
  const elsewhere = client(users.editor, other.file);
  await saved(elsewhere);
  elsewhere.text.insert(0, 'STILL ');
  await saved(elsewhere);
  expect(await stored(other.project)).toContain('STILL ');
});

/** A server that holds each person to a small budget of edits, for as long as `run` takes. */
async function withBudget(
  editBudget: { burst: number; perMinute: number; floor: number },
  run: (port: number) => Promise<void>,
) {
  const server = await startSync({
    pool: t.pool,
    store,
    secret: SECRET,
    port: sync.port + 300,
    databaseUrl: t.url,
    metricsToken: METRICS_TOKEN,
    editBudget,
  });
  try {
    await run(server.port);
  } finally {
    await server.stop();
  }
}
const BIG = 1_200_000;
// The server's code is 1013; the client library is handed the reason of the close message, with
// the code 1000, and leaves its socket open: the editor closes it itself and connects again.
const refusals = (c: Client) => c.state.reasons.filter((r) => r.endsWith(':over-budget')).length;
const overBudget = (c: Client) => refusals(c) > 0;

test('an edit past a budget is refused and kept by its editor, and saved once the budget is given back', async () => {
  const { project, file } = await paper();
  // Two megabytes at once, and 100 kB a second given back.
  await withBudget({ burst: 2_000_000, perMinute: 6_000_000, floor: 512 }, async (port) => {
    const owner = client(users.owner, file, port);
    const editor = client(users.editor, file, port);
    await saved(owner, editor);
    owner.text.insert(0, 'X'.repeat(BIG));
    await saved(owner);
    // 0.8 MB is left, and this edit costs 1.2: refused, with the reason that makes the editor wait.
    owner.text.insert(0, 'Y'.repeat(BIG));
    await until('the edit to be refused', () => overBudget(owner));
    expect(await stored(project)).not.toContain('Y');
    // Someone else, and their own budget, are not touched.
    editor.text.insert(0, '% small\n');
    await saved(editor);
    expect(editor.text.toString()).not.toContain('YYYY');
    expect(await stored(project)).not.toContain('Y');
    // Connecting again at once sends it again and is refused again, and still costs nothing.
    owner.socket.disconnect();
    // The library ignores a request to connect made while a close is still going on.
    await until('the socket to close', () => owner.socket.status === 'disconnected');
    await owner.socket.connect();
    await until('the edit to be refused again', () => refusals(owner) >= 2);
    expect(await stored(project)).not.toContain('Y');
    // The rest is given back in four seconds: waited for, the owner's client connects again,
    // sends it again, and it is saved. Nothing was lost.
    owner.socket.disconnect();
    await new Promise((r) => setTimeout(r, 4500));
    await owner.socket.connect();
    await saved(owner);
    expect(owner.state.closed).toBeGreaterThanOrEqual(1);
    const text = await stored(project);
    expect(text.includes('Y'.repeat(BIG))).toBe(true);
    expect(text.includes('X'.repeat(BIG))).toBe(true);
    expect(text).toContain('% small');
    await until('the editor to have it', () => editor.text.toString().includes('Y'.repeat(BIG)));
    for (const c of [owner, editor]) c.provider.destroy();
  });
});

test('one person on two files has one budget', async () => {
  const { project, file } = await paper();
  const other = await createFile(
    t.pool,
    store,
    users.owner.id,
    project,
    'second.tex',
    Buffer.from('% second\n'),
  );
  await withBudget({ burst: 2_000_000, perMinute: 60_000, floor: 512 }, async (port) => {
    const a = client(users.owner, file, port);
    const b = client(users.owner, other, port);
    await saved(a, b);
    const before = await headSeq(other);
    a.text.insert(0, 'X'.repeat(BIG));
    await saved(a);
    // The other file has had nothing, but the person has had nearly all of theirs.
    b.text.insert(0, 'Y'.repeat(BIG));
    await until('the edit on the other file to be refused', () => overBudget(b));
    expect(overBudget(a)).toBe(false);
    expect(await headSeq(other)).toBe(before);
    for (const c of [a, b]) c.provider.destroy();
  });
});

test('a structural edit past the budget is answered with an error and changes nothing', async () => {
  const { project, file } = await paper();
  // Each costs a megabyte; nothing is given back during the test.
  await withBudget({ burst: 2_000_000, perMinute: 60_000, floor: 1_000_000 }, async (port) => {
    const owner = client(users.owner, file, port);
    const reviewer = client(users.reviewer, file, port);
    await saved(owner, reviewer);
    const ask = async (c: Client, expected: string, replacement: string) => {
      const key = crypto.randomUUID();
      const i = c.text.toString().indexOf(expected);
      const at = (n: number) =>
        Buffer.from(
          Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(c.text, n)),
        ).toString('base64url');
      c.provider.sendStateless(
        JSON.stringify({
          key,
          from: at(i),
          to: at(i + expected.length),
          expected,
          replacement,
        }),
      );
      await until('an answer', () => c.state.replies.some((r) => r.key === key));
      return c.state.replies.find((r) => r.key === key)!;
    };
    expect((await ask(owner, 'Hello', 'W1')).result).toBe('applied');
    await until('the first edit to arrive', () => owner.text.toString().includes('W1'));
    expect((await ask(owner, 'W1', 'W2')).result).toBe('applied');
    await until('the second edit to arrive', () => owner.text.toString().includes('W2'));
    const refused = await ask(owner, 'W2', 'W3');
    expect(refused.error).toBe('Too many edits at once. Try again in a moment.');
    expect(refused.result).toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(owner.text.toString()).toContain('W2');
    expect(owner.text.toString()).not.toContain('W3');
    expect(await stored(project)).toBe(MAIN.replace('Hello', 'W2'));
    // Someone who cannot edit is told so, as before, and is not charged for asking.
    await until('the reviewer to have it', () => reviewer.text.toString().includes('W2'));
    expect((await ask(reviewer, 'W2', 'W4')).error).toBe('You cannot edit this file.');
    for (const c of [owner, reviewer]) c.provider.destroy();
  });
});

/** Ask for a structural edit over a client's socket and wait for the answer. */
const askFor = async (c: Client, expected: string, replacement: string) => {
  const key = crypto.randomUUID();
  const i = c.text.toString().indexOf(expected);
  const at = (n: number) =>
    Buffer.from(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(c.text, n)),
    ).toString('base64url');
  c.provider.sendStateless(
    JSON.stringify({ key, from: at(i), to: at(i + expected.length), expected, replacement }),
  );
  await until('an answer', () => c.state.replies.some((r) => r.key === key));
  return c.state.replies.find((r) => r.key === key)!;
};

test('a structural edit is charged what it adds, and one the budget cannot take changes nothing', async () => {
  const { project, file } = await paper();
  // Two megabytes at once and next to nothing given back; the least an edit costs is small.
  await withBudget({ burst: 2_000_000, perMinute: 6_000, floor: 512 }, async (port) => {
    const owner = client(users.owner, file, port);
    await saved(owner);
    const big = (ch: string) => ch.repeat(900_000);
    expect((await askFor(owner, 'Hello', big('A'))).result).toBe('applied');
    await until('the first to arrive', () => owner.text.toString().includes(big('A')));
    expect((await askFor(owner, big('A'), big('B'))).result).toBe('applied');
    await until('the second to arrive', () => owner.text.toString().includes(big('B')));
    // 1.8 MB were added and 0.2 is left: a flat 512 each would let this in.
    const refused = await askFor(owner, big('B'), big('C'));
    expect(refused.error).toBe('Too many edits at once. Try again in a moment.');
    expect(refused.result).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    const text = await stored(project);
    expect(text.includes(big('B'))).toBe(true);
    expect(text).not.toContain('C');
    owner.provider.destroy();
  });
});

test('commands sent on a connection after the edit that closed it are not applied', async () => {
  const { project, file } = await paper();
  await withBudget({ burst: 2_000_000, perMinute: 6_000, floor: 512 }, async (port) => {
    const owner = client(users.owner, file, port);
    await saved(owner);
    owner.text.insert(0, 'X'.repeat(BIG));
    await saved(owner);
    // Past the budget. The commands are on the socket in the same burst, after the edit.
    owner.text.insert(0, 'Y'.repeat(BIG));
    const keys = [0, 1, 2].map(() => crypto.randomUUID());
    const at = (n: number) =>
      Buffer.from(
        Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(owner.text, n)),
      ).toString('base64url');
    const i = owner.text.toString().indexOf('Hello');
    for (const key of keys)
      owner.provider.sendStateless(
        JSON.stringify({
          key,
          from: at(i),
          to: at(i + 5),
          expected: 'Hello',
          replacement: 'CMD',
        }),
      );
    await until('the edit to be refused', () => overBudget(owner));
    await new Promise((r) => setTimeout(r, 500));
    expect(owner.state.replies.filter((r) => r.result === 'applied')).toEqual([]);
    const text = await stored(project);
    expect(text).not.toContain('CMD');
    expect(text).not.toContain('Y');
    owner.provider.destroy();
  });
});

test('a structural edit against a hostile paragraph does not hold up people on other files', async () => {
  // The server parses a window around the edit on its one thread. A paragraph of options that
  // never close took that parse ten seconds for 32 KB (twice), and everyone's answers waited.
  const a = await paper();
  const b = await paper();
  // A server of its own, in another process: a parse that blocks it must not block this test.
  const port = sync.port + 2;
  const env = { ...process.env, ...TEST_ENV, DATABASE_URL: t.url, SYNC_PORT: String(port) };
  await new Promise<void>((resolve, reject) => {
    child = spawn(process.execPath, [join(import.meta.dirname, 'main.ts')], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout!.once('data', () => resolve());
    child.once('error', reject);
  });
  const owner = client(users.owner, a.file, port);
  const other = client(users.editor, b.file, port);
  await saved(owner, other);
  const at = owner.text.toString().indexOf('Hello.');
  owner.text.insert(at, `\\sys{} ${'\\cite['.repeat(5460)} `);
  await saved(owner);

  let asked = 1_000_000;
  const answered = async (c: Client) => {
    // A number of its own, so that no earlier answer is taken for this one.
    const q = { ...c.changes.question(), n: asked++ };
    const t0 = Date.now();
    c.provider.sendStateless(JSON.stringify(q));
    await until(
      'an answer',
      () => c.state.replies.some((r) => r.n === q.n && 'saved' in r),
      120_000,
    );
    return Date.now() - t0;
  };
  const pos = (n: number) =>
    Buffer.from(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(owner.text, n)),
    ).toString('base64url');
  const key = crypto.randomUUID();
  const i = owner.text.toString().indexOf('\\sys{}');
  owner.provider.sendStateless(
    JSON.stringify({
      key,
      from: pos(i),
      to: pos(i + 6),
      expected: '\\sys{}',
      replacement: '\\cite{z}',
      contained: true,
    }),
  );
  // Asked again and again from the moment the command is sent until it is answered, so that one
  // lands while the server works it out, at the least 20 times.
  const waits: number[] = [];
  const done = () => owner.state.replies.some((r) => r.key === key);
  while (!done() || waits.length < 20) {
    await new Promise((r) => setTimeout(r, 50));
    waits.push(await answered(other));
  }
  expect(Math.max(...waits), `answers took ${waits.join(', ')} ms`).toBeLessThan(2000);
  expect(owner.state.replies.find((r) => r.key === key)?.result).toBe('applied');
  owner.provider.destroy();
  other.provider.destroy();
  child?.kill('SIGKILL');
});

test('the metrics count the edits refused for the budget', async () => {
  const { file } = await paper();
  await withBudget({ burst: 2_000_000, perMinute: 60_000, floor: 512 }, async (port) => {
    const read = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      });
      const text = await res.text();
      return {
        text,
        n: Number(/^paperweave_sync_edits_over_budget_total (\S+)$/m.exec(text)?.[1]),
      };
    };
    const first = await read();
    expect(first.text).toMatch(/^# TYPE paperweave_sync_edits_over_budget_total counter$/m);
    expect(first.n).toBe(0);
    const owner = client(users.owner, file, port);
    await saved(owner);
    owner.text.insert(0, 'X'.repeat(BIG));
    await saved(owner);
    owner.text.insert(0, 'Y'.repeat(BIG));
    await until('the edit to be refused', () => overBudget(owner));
    await until('the refusal to be counted', async () => (await read()).n >= 1);
    expect((await read()).text).not.toContain('XXXX');
    owner.provider.destroy();
  });
});

// Presence: names and cursors, which every connection on a file sends and every other receives.

const varUint = (n: number) => {
  const out: number[] = [];
  for (; n > 0x7f; n = Math.floor(n / 128)) out.push(0x80 | (n & 0x7f));
  return Buffer.from([...out, n]);
};
const varBytes = (b: Buffer) => Buffer.concat([varUint(b.length), b]);
/** An awareness message written by hand, for the file: whatever states, under whatever client IDs. */
function rawAwareness(file: string, states: [number, unknown][]) {
  const body = Buffer.concat([
    varUint(states.length),
    ...states.flatMap(([id, state]) => [
      varUint(id),
      varUint(1),
      varBytes(Buffer.from(JSON.stringify(state))),
    ]),
  ]);
  return Buffer.concat([varBytes(Buffer.from(file)), varUint(1), varBytes(body)]);
}
const sendRaw = (c: Client, bytes: Buffer) => c.socket.webSocket!.send(new Uint8Array(bytes));
const presenceDropped = async () => {
  const res = await fetch(`http://127.0.0.1:${sync.port}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  return Number(/^paperweave_sync_presence_dropped_total (\S+)$/m.exec(await res.text())?.[1]);
};
const longestName = (c: Client) =>
  Math.max(
    0,
    ...[...c.provider.awareness!.getStates().values()].map((s) =>
      typeof s.user?.name === 'string' ? s.user.name.length : 0,
    ),
  );

test('a viewer cannot fill everyone else with presence: a message of 1 MB is refused', async () => {
  const { file } = await paper();
  const viewer = client(users.viewer, file);
  const owner = client(users.owner, file);
  await saved(viewer, owner);
  const before = await presenceDropped();
  const crowd: [number, unknown][] = [];
  for (let i = 0; i < 1000; i++) crowd.push([1_000_000 + i, { user: { name: `p${i}` } }]);
  crowd.push([2_000_000, { user: { name: 'N'.repeat(1_000_000) } }]);
  sendRaw(viewer, rawAwareness(file, crowd));
  // Long enough for a message that was taken to have reached the other editor.
  await new Promise((r) => setTimeout(r, 1500));
  expect(owner.provider.awareness!.getStates().size).toBeLessThanOrEqual(2);
  expect(longestName(owner)).toBeLessThanOrEqual(80);
  expect(await presenceDropped()).toBeGreaterThan(before);
  // The connection is closed, with a reason the editor knows, and not for good.
  expect(viewer.state.reasons.some((r) => r.endsWith(':presence-too-large'))).toBe(true);
  expect(owner.state.closed).toBe(0);
});

test('a small presence message with many people and a long name is cut down to one', async () => {
  const { file } = await paper();
  const viewer = client(users.viewer, file);
  const owner = client(users.owner, file);
  await saved(viewer, owner);
  const crowd: [number, unknown][] = [];
  for (let i = 0; i < 40; i++) crowd.push([3_000_000 + i, { user: { name: `p${i}` } }]);
  crowd[0] = [3_000_000, { user: { name: 'N'.repeat(500), color: 'red', extra: 'x' } }];
  sendRaw(viewer, rawAwareness(file, crowd));
  await until('one of them to arrive', () => owner.provider.awareness!.getStates().has(3_000_000));
  await new Promise((r) => setTimeout(r, 500));
  expect(owner.provider.awareness!.getStates().size).toBeLessThanOrEqual(2);
  expect(owner.provider.awareness!.getStates().get(3_000_000)).toEqual({
    user: { name: users.viewer.email },
  });
  expect(viewer.state.closed).toBe(0);
});

test('5,000 cursor updates in a row are dropped, not the connection, and edits are still saved', async () => {
  const { project, file } = await paper();
  const a = client(users.second, file);
  const b = client(users.editor, file);
  await saved(a, b);
  const before = await presenceDropped();
  const awareness = a.provider.awareness!;
  for (let i = 0; i < 5000; i++) {
    const at = Y.createRelativePositionFromTypeIndex(a.text, i % 5);
    awareness.setLocalStateField('cursor', { anchor: at, head: at });
    awareness.setLocalStateField('tick', i);
  }
  a.text.insert(0, 'STILL-SAVED ');
  await saved(a);
  expect(a.state.closed).toBe(0);
  expect(a.state.reasons).toEqual([]);
  expect(await presenceDropped()).toBeGreaterThan(before);
  expect(await stored(project)).toContain('STILL-SAVED');
  await until('the other editor to have the edit', () => b.text.toString().includes('STILL-SAVED'));
  expect(b.state.closed).toBe(0);
});

test('people on a file, viewers and reviewers too, still see each other by name and cursor', async () => {
  const { file } = await paper();
  const [owner, editor, viewer, reviewer] = [
    client(users.owner, file),
    client(users.editor, file),
    client(users.viewer, file),
    client(users.reviewer, file),
  ];
  await saved(owner, editor, viewer, reviewer);
  owner.text.insert(0, 'Some text to point at. ');
  await saved(owner);
  await until('the text to arrive', () => viewer.text.length > 10 && reviewer.text.length > 10);
  const who: [Client, string, string][] = [
    [owner, users.owner.email, '#aabbcc'],
    [editor, users.editor.email, '#112233'],
    [viewer, users.viewer.email, '#445566'],
    [reviewer, users.reviewer.email, '#778899'],
  ];
  for (const [c, name, colour] of who) {
    // yCollab sends the positions themselves; the visual view their JSON, which leaves out nulls.
    const from = Y.createRelativePositionFromTypeIndex(c.text, 2);
    const to = Y.createRelativePositionFromTypeIndex(c.text, 6);
    const visual = c === editor || c === reviewer;
    c.provider.awareness!.setLocalStateField('user', {
      name,
      color: colour,
      colorLight: colour + '33',
    });
    c.provider.awareness!.setLocalStateField(
      'cursor',
      visual
        ? { anchor: Y.relativePositionToJSON(from), head: Y.relativePositionToJSON(to) }
        : { anchor: from, head: to },
    );
  }
  for (const [c] of who)
    for (const [other, name, colour] of who) {
      if (other === c) continue;
      await until(`${name} to be seen`, () => {
        const s = c.provider.awareness!.getStates().get(other.doc.clientID);
        return s?.user?.name === name && !!s.cursor;
      });
      const s = c.provider.awareness!.getStates().get(other.doc.clientID)!;
      expect(s.user).toEqual({ name, color: colour, colorLight: colour + '33' });
      const index = (r: unknown) =>
        Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(r), c.doc)
          ?.index;
      expect([index(s.cursor.anchor), index(s.cursor.head)]).toEqual([2, 6]);
    }
  for (const [c] of who) expect(c.state.closed).toBe(0);
});

// Presence belongs to the connection that sends it: its name is the server's, and a client ID is
// held by one connection at a time.

/** Like `rawAwareness`, with the clock each state carries (null removes the client). */
function rawAwarenessAt(file: string, states: [id: number, clock: number, state: unknown][]) {
  const body = Buffer.concat([
    varUint(states.length),
    ...states.flatMap(([id, clock, state]) => [
      varUint(id),
      varUint(clock),
      varBytes(Buffer.from(JSON.stringify(state))),
    ]),
  ]);
  return Buffer.concat([varBytes(Buffer.from(file)), varUint(1), varBytes(body)]);
}
const spot = { anchor: { tname: 'x', assoc: 0 }, head: { tname: 'x', assoc: 0 } };
const seenBy = (c: Client, of: number) => c.provider.awareness!.getStates().get(of);
// One paper for these tests: each makes its own clients, and the service sends only so many
// invitations an hour, which a paper for every test would add to.
let sharedPaper: ReturnType<typeof paper> | undefined;
const presencePaper = () => (sharedPaper ??= paper());

test('a viewer cannot go by the owner’s name: presence carries the viewer’s own', async () => {
  const { file } = await presencePaper();
  const [owner, editor, viewer] = [
    client(users.owner, file),
    client(users.editor, file),
    client(users.viewer, file),
  ];
  await saved(owner, editor, viewer);
  const mine = viewer.doc.clientID;
  sendRaw(
    viewer,
    rawAwarenessAt(file, [
      [mine, 1000, { user: { name: users.owner.email, color: '#445566' }, cursor: spot }],
    ]),
  );
  await until('the viewer to be seen', () => !!seenBy(editor, mine)?.cursor);
  expect(seenBy(editor, mine)?.user).toEqual({ name: users.viewer.email, color: '#445566' });
  expect(seenBy(owner, mine)?.user?.name).toBe(users.viewer.email);
  expect(viewer.state.closed).toBe(0);
});

test('a viewer cannot rewrite or remove the owner’s presence', async () => {
  const { file } = await presencePaper();
  const [owner, editor, viewer] = [
    client(users.owner, file),
    client(users.editor, file),
    client(users.viewer, file),
  ];
  await saved(owner, editor, viewer);
  const theirs = owner.doc.clientID;
  const awareness = owner.provider.awareness!;
  awareness.setLocalStateField('user', { name: users.owner.email, color: '#112233' });
  awareness.setLocalStateField('cursor', spot);
  await until('the owner to be seen', () => !!seenBy(editor, theirs)?.cursor);
  const clock = awareness.meta.get(theirs)!.clock;
  const was = seenBy(editor, theirs);
  sendRaw(viewer, rawAwarenessAt(file, [[theirs, clock + 1, { user: { name: 'Someone else' } }]]));
  sendRaw(viewer, rawAwarenessAt(file, [[theirs, clock + 2, null]]));
  // Long enough for what was taken to have reached the other editor.
  await new Promise((r) => setTimeout(r, 1000));
  expect(seenBy(editor, theirs)).toEqual(was);
  expect(seenBy(editor, theirs)?.user?.name).toBe(users.owner.email);
  expect(viewer.state.closed).toBe(0);
});

test('a viewer’s own cursor and colours still arrive, under the server’s name for them', async () => {
  const { file } = await presencePaper();
  const editor = client(users.editor, file);
  const viewer = client(users.viewer, file);
  await saved(editor, viewer);
  const at = Y.createRelativePositionFromTypeIndex(viewer.text, 0);
  viewer.provider.awareness!.setLocalStateField('user', {
    name: 'Chosen by the client',
    color: '#445566',
    colorLight: '#44556633',
  });
  viewer.provider.awareness!.setLocalStateField('cursor', { anchor: at, head: at });
  await until('the cursor to arrive', () => !!seenBy(editor, viewer.doc.clientID)?.cursor);
  const s = seenBy(editor, viewer.doc.clientID)!;
  expect(s.user).toEqual({ name: users.viewer.email, color: '#445566', colorLight: '#44556633' });
  expect(Object.keys(s.cursor).sort()).toEqual(['anchor', 'head']);
});

test('a client ID is held by one connection, and free again when it closes', async () => {
  const { file } = await presencePaper();
  const owner = client(users.owner, file);
  const first = client(users.viewer, file);
  const again = client(users.viewer, file);
  await saved(owner, first, again);
  const id = 777_001;
  sendRaw(first, rawAwarenessAt(file, [[id, 1000, { user: { color: '#111111' }, cursor: spot }]]));
  await until('the first to be seen', () => seenBy(owner, id)?.user?.color === '#111111');
  // Held: another connection cannot take it over while the first is open.
  sendRaw(again, rawAwarenessAt(file, [[id, 2000, { user: { color: '#222222' }, cursor: spot }]]));
  await new Promise((r) => setTimeout(r, 700));
  expect(seenBy(owner, id)?.user?.color).toBe('#111111');
  // Closed: its presence goes, and the ID can be claimed by a tab that comes back with it.
  first.provider.destroy();
  first.socket.destroy();
  await until('the first to be gone', () => !seenBy(owner, id));
  sendRaw(again, rawAwarenessAt(file, [[id, 3000, { user: { color: '#333333' }, cursor: spot }]]));
  await until('the next to be seen', () => seenBy(owner, id)?.user?.color === '#333333');
  expect(seenBy(owner, id)?.user?.name).toBe(users.viewer.email);
});

// Connections per person: at most two to a file and three in all, on a server of their own.
/** A server with a small cap on connections, for as long as `run` takes. */
async function withCap(run: (port: number) => Promise<void>) {
  const server = await startSync({
    pool: t.pool,
    store,
    secret: SECRET,
    port: sync.port + 400,
    databaseUrl: t.url,
    metricsToken: METRICS_TOKEN,
    connectionCap: { perFile: 2, perPerson: 3 },
  });
  try {
    await run(server.port);
  } finally {
    await server.stop();
  }
}
const metricsOf = async (port: number) => {
  const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  const text = await res.text();
  const number = (name: string) =>
    Number(new RegExp(`^paperweave_sync_${name} (\\S+)$`, 'm').exec(text)?.[1]);
  return { text, open: number('connections_open'), over: number('connections_over_limit_total') };
};
/** The server was told "too many" for this client, either as a refused ticket or as a close. */
const crowded = (c: Client) =>
  c.state.why === 'too-many' || c.state.reasons.some((r) => r.endsWith(':too-many'));
/** Let in and in step with the file, and never told "too many". */
const admitted = (c: Client) => c.provider.synced && !crowded(c);
/**
 * A relay to the server that can be cut: every socket through it is destroyed at once, with no
 * close frame, as when a laptop is shut or a network goes. The client in the test cannot do that
 * itself (Node's WebSocket does not give out its socket).
 */
async function relay(target: number) {
  const sockets = new Set<Socket>();
  const relayed = createServer((from) => {
    const to = createConnection({ port: target, host: '127.0.0.1' });
    for (const s of [from, to]) {
      sockets.add(s);
      s.on('error', () => {});
      s.on('close', () => sockets.delete(s));
    }
    from.pipe(to);
    to.pipe(from);
  });
  await new Promise<void>((resolve) => relayed.listen(0, '127.0.0.1', resolve));
  const cut = () => sockets.forEach((s) => s.destroy());
  return {
    port: (relayed.address() as AddressInfo).port,
    cut,
    stop: () => {
      cut();
      relayed.close();
    },
  };
}
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

test('a third connection to one file is refused, and the two that were there are left alone', async () => {
  const { file } = await paper();
  await withCap(async (port) => {
    const [a, b] = [client(users.owner, file, port), client(users.owner, file, port)];
    await saved(a, b);
    const c = client(users.owner, file, port);
    await until('the third to be turned away', () => crowded(c));
    expect(c.state.why).toBe('too-many');
    expect(c.provider.synced).toBe(false);
    expect(c.text.toString()).toBe('');
    // The ones that were there go on, and see each other's edits.
    a.text.insert(0, '% still here\n');
    await saved(a, b);
    await until('the other tab to have it', () => b.text.toString().startsWith('% still here'));
    expect(a.state.closed + b.state.closed).toBe(0);
    for (const x of [a, b, c]) x.provider.destroy();
  });
});

test('another person still connects when someone has all their connections to a file', async () => {
  const { file } = await paper();
  await withCap(async (port) => {
    const [a, b] = [client(users.owner, file, port), client(users.owner, file, port)];
    await saved(a, b);
    const editor = client(users.editor, file, port);
    await saved(editor);
    expect(admitted(editor)).toBe(true);
    expect((await metricsOf(port)).open).toBe(3);
    for (const x of [a, b, editor]) x.provider.destroy();
  });
});

test('a burst of six at once leaves exactly two live', async () => {
  const { file } = await paper();
  await withCap(async (port) => {
    const burst = Array.from({ length: 6 }, () => client(users.owner, file, port));
    await until('four to be turned away', () => burst.filter(crowded).length === 4);
    await until('two to be in step', () => burst.filter(admitted).length === 2);
    // Nothing more happens after that.
    await settle();
    expect(burst.filter(crowded).length).toBe(4);
    expect(burst.filter(admitted).length).toBe(2);
    expect((await metricsOf(port)).open).toBe(2);
    for (const x of burst) x.provider.destroy();
  });
});

test('closing a connection, or losing its socket, lets the next one in', async () => {
  const { file } = await paper();
  await withCap(async (port) => {
    const [a, b] = [client(users.owner, file, port), client(users.owner, file, port)];
    await saved(a, b);
    const refused = client(users.owner, file, port);
    await until('the third to be turned away', () => crowded(refused));
    // Closed properly.
    a.provider.destroy();
    a.socket.destroy();
    await until('the server to have one', async () => (await metricsOf(port)).open === 1);
    const next = client(users.owner, file, port);
    await saved(next);
    expect(admitted(next)).toBe(true);

    // The socket dies with no close frame, as a laptop's does. The editor would connect again
    // by itself; this one is told not to, so that it is the next one that takes the place.
    const lost = await relay(port);
    const [x, y] = [client(users.editor, file, port), client(users.editor, file, lost.port)];
    await saved(x, y);
    const full = client(users.editor, file, port);
    await until('the third of the editor to be turned away', () => crowded(full));
    y.socket.shouldConnect = false;
    lost.cut();
    await until('the server to drop it', async () => (await metricsOf(port)).open === 3);
    const after = client(users.editor, file, port);
    await saved(after);
    expect(admitted(after)).toBe(true);
    for (const c of [b, refused, next, x, y, full, after]) c.provider.destroy();
    lost.stop();
  });
});

test('a fourth connection to a third file is refused, though the file has none', async () => {
  const { project, file } = await paper();
  const [second, third] = [
    await createFile(t.pool, store, users.owner.id, project, 'second.tex', Buffer.from('% 2\n')),
    await createFile(t.pool, store, users.owner.id, project, 'third.tex', Buffer.from('% 3\n')),
  ];
  await withCap(async (port) => {
    const held = [
      client(users.owner, file, port),
      client(users.owner, file, port),
      client(users.owner, second, port),
    ];
    await saved(...held);
    const fourth = client(users.owner, third, port);
    await until('the fourth to be turned away', () => crowded(fourth));
    expect(fourth.state.why).toBe('too-many');
    expect(fourth.text.toString()).toBe('');
    // Someone else, on the same file, is not held by it.
    const editor = client(users.editor, third, port);
    await saved(editor);
    for (const c of [...held, fourth, editor]) c.provider.destroy();
  });
});

test('the metrics count the connections turned away', async () => {
  const { file } = await paper();
  await withCap(async (port) => {
    const first = await metricsOf(port);
    expect(first.text).toMatch(/^# TYPE paperweave_sync_connections_over_limit_total counter$/m);
    expect(first.text).toMatch(/^# HELP paperweave_sync_connections_over_limit_total \S/m);
    expect(first.over).toBe(0);
    const burst = Array.from({ length: 5 }, () => client(users.owner, file, port));
    await until('three to be turned away', () => burst.filter(crowded).length === 3);
    await settle();
    expect((await metricsOf(port)).over).toBe(3);
    for (const x of burst) x.provider.destroy();
  });
});

test('a server-side edit that lands on the threshold does not skip the round', async () => {
  const { project, file } = await paper();
  const THRESHOLD = 20;
  const own = await startSync({
    pool: t.pool,
    store,
    secret: SECRET,
    port: sync.port + 200,
    databaseUrl: t.url,
    compactEvery: THRESHOLD,
  });
  try {
    const owner = client(users.owner, file, own.port);
    await saved(owner);
    // The file's first entry, then 18 typed edits: the log holds 19.
    for (let i = 0; i < 18; i++) {
      owner.text.insert(owner.text.length, `live ${i}\n`);
      await saved(owner);
    }
    expect(await logRows(file)).toBe(19);
    // The 20th entry is the server's own.
    await editFile(t.pool, store, file, users.owner.id, (text) => text.insert(0, '% server\n'));
    await until('the open copy to have it', () => owner.text.toString().startsWith('% server\n'));
    for (let i = 0; i < 10; i++) {
      owner.text.insert(owner.text.length, `more ${i}\n`);
      await saved(owner);
    }
    await until('the log to be compacted', async () => (await logRows(file)) < THRESHOLD, 5000);
    expect(await logRows(file)).toBeLessThan(THRESHOLD);
    // Nothing was lost to it.
    const text = owner.text.toString();
    expect(text.startsWith('% server\n')).toBe(true);
    expect(text.match(/live \d+\n/g)).toHaveLength(18);
    expect(text.match(/more \d+\n/g)).toHaveLength(10);
    expect(await stored(project)).toBe(text.replaceAll('\n', '\r\n'));
  } finally {
    await own.stop();
  }
}, 60_000);
