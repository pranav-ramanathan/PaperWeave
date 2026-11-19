// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  acceptInvitation,
  blobStore,
  compactFile,
  deleteFile,
  exportZip,
  importZip,
  invite,
  listFiles,
  readZip,
  removeMember,
  requestBuild,
  restoreRevision,
  runCommand,
  saveRevision,
  setRole,
  createFile,
  listRevisions,
  syncTicket,
  writeZip,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
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
    const { token } = await invite(t.pool, users.owner.id, project.id, users[who].email, role);
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
    port: 4200 + Math.floor(Math.random() * 500),
    databaseUrl: t.url,
    // Small, so that a test can type its way past it.
    compactEvery: 20,
    metricsToken: METRICS_TOKEN,
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
