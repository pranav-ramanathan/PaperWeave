// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { readZip, writeZip } from './archive.ts';
import { blobStore } from './blobs.ts';
import { type Command, runCommand } from './commands.ts';
import { exportZip, importZip, listFiles } from './import.ts';
import { acceptInvitation, invite } from './projects.ts';
import { compactFile, editFile, loadUpdates, TEXT } from './sync.ts';
import { TEST_ENV, testDb } from './testing.ts';

const store = blobStore(TEST_ENV);
// CRLF on purpose: a command must leave the file's own line ends alone.
const MAIN =
  '\\documentclass{article}\r\n\\begin{document}\r\nAlpha beta gamma.\r\nSecond line.\r\n\\end{document}\r\n';
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };
let viewer: { id: string; email: string };
let outsider: { id: string };

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
  viewer = await t.signIn('viewer@example.org');
  outsider = await t.signIn('outsider@example.org');
});
afterAll(() => t.close());

async function paper() {
  const zip = await writeZip([
    { path: 'main.tex', bytes: Buffer.from(MAIN) },
    { path: 'other.tex', bytes: Buffer.from('Other.\n') },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Commands');
  const { token } = await invite(t.pool, owner.id, project.id, viewer.email, 'viewer');
  await acceptInvitation(t.pool, viewer.id, token);
  const ids = Object.fromEntries(
    (await listFiles(t.pool, owner.id, project.id)).map((f) => [f.path, f.id]),
  );
  return { id: project.id, main: ids['main.tex'], other: ids['other.tex'] };
}
/** The file's document as a client that has it open would hold it. */
async function open(file: string) {
  const doc = new Y.Doc();
  for (const u of await loadUpdates(t.pool, store, file)) Y.applyUpdate(doc, u);
  return doc.getText(TEXT);
}
/** A command that replaces the first occurrence of `expected`, as the bridge builds one. */
function replace(text: Y.Text, expected: string, replacement: string): Command {
  const from = text.toString().indexOf(expected);
  if (from < 0) throw new Error(`"${expected}" is not in the text`);
  const at = (i: number) =>
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, i));
  return {
    key: randomUUID(),
    from: at(from),
    to: at(from + expected.length),
    expected,
    replacement,
  };
}
const stored = async (project: string, path = 'main.tex') =>
  Buffer.from(
    (await readZip(await exportZip(t.pool, store, owner.id, project))).entries.find(
      (e) => e.path === path,
    )!.bytes,
  ).toString();
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e.code ?? `unexpected: ${e.message}`,
  );
const rows = async (file: string) =>
  (await t.pool.query('select count(*)::int as n from file_updates where file_id = $1', [file]))
    .rows[0].n;

test('a command replaces its stretch and nothing else', async () => {
  const p = await paper();
  const c = replace(await open(p.main), 'beta', '\\emph{beta}');
  expect(await runCommand(t.pool, store, owner.id, p.main, c)).toMatchObject({ result: 'applied' });
  expect(await stored(p.id)).toBe(MAIN.replace('beta', '\\emph{beta}'));
});

test('a \\textbf command wraps its stretch, and the one that takes it off restores the bytes', async () => {
  const p = await paper();
  const on = replace(await open(p.main), 'beta', '\\textbf{beta}');
  expect(await runCommand(t.pool, store, owner.id, p.main, on)).toMatchObject({
    result: 'applied',
  });
  expect(await stored(p.id)).toBe(MAIN.replace('beta', '\\textbf{beta}'));
  const off = replace(await open(p.main), '\\textbf{beta}', 'beta');
  expect(await runCommand(t.pool, store, owner.id, p.main, off)).toMatchObject({
    result: 'applied',
  });
  expect(await stored(p.id)).toBe(MAIN);
});

test('a command follows its text when others edit elsewhere', async () => {
  const p = await paper();
  const c = replace(await open(p.main), 'gamma', 'delta');
  // Text arrives before and after the stretch, so its offsets are no longer what they were.
  await editFile(t.pool, store, p.main, owner.id, (text) => {
    text.insert(0, '% a new first line\n');
    text.insert(text.length, 'Third line.\n');
  });
  expect(await runCommand(t.pool, store, owner.id, p.main, c)).toMatchObject({ result: 'applied' });
  expect(await stored(p.id)).toBe(
    '% a new first line\r\n' + MAIN.replace('gamma', 'delta') + 'Third line.\r\n',
  );
});

test('a stale command is refused with the text as it stands, and changes nothing', async () => {
  const p = await paper();
  const c = replace(await open(p.main), 'Alpha beta', '\\textbf{Alpha beta}');
  await editFile(t.pool, store, p.main, owner.id, (text) =>
    text.insert(text.toString().indexOf(' beta'), 'bet'),
  );
  const refused = await runCommand(t.pool, store, owner.id, p.main, c);
  const now = MAIN.replaceAll('\r\n', '\n').replace('Alpha', 'Alphabet');
  expect(refused).toEqual({ result: 'conflict', text: now });
  expect(await stored(p.id)).toBe(MAIN.replace('Alpha', 'Alphabet'));
  // Made again against that text, it applies.
  const again = replace(await open(p.main), 'Alphabet beta', '\\textbf{Alphabet beta}');
  expect(await runCommand(t.pool, store, owner.id, p.main, again)).toMatchObject({
    result: 'applied',
  });
  expect(await stored(p.id)).toBe(MAIN.replace('Alpha beta', '\\textbf{Alphabet beta}'));
  // A stretch that has been deleted altogether is stale too.
  const gone = replace(await open(p.main), 'Second', 'Next');
  await editFile(t.pool, store, p.main, owner.id, (text) =>
    text.delete(text.toString().indexOf('Second line.'), 12),
  );
  expect((await runCommand(t.pool, store, owner.id, p.main, gone)).result).toBe('conflict');
});

test('a command sent twice is applied once', async () => {
  const p = await paper();
  // Replacing "a" with "aa": applied twice it would show.
  const c = replace(await open(p.main), 'gamma', 'gamma gamma');
  expect(await runCommand(t.pool, store, owner.id, p.main, c)).toMatchObject({ result: 'applied' });
  expect(await runCommand(t.pool, store, owner.id, p.main, c)).toEqual({ result: 'duplicate' });
  expect(await stored(p.id)).toBe(MAIN.replace('gamma', 'gamma gamma'));
  // Both copies arriving at the same moment.
  const d = replace(await open(p.main), 'Second', 'Second Second');
  const both = await Promise.all([1, 2].map(() => runCommand(t.pool, store, owner.id, p.main, d)));
  expect(both.map((r) => r.result).sort()).toEqual(['applied', 'duplicate']);
  expect(await stored(p.id)).toContain('Second Second line.');
  expect(await stored(p.id)).not.toContain('Second Second Second');
  // A key cannot be used again for another file.
  const other = { ...replace(await open(p.other), 'Other', 'Another'), key: c.key };
  expect(await code(runCommand(t.pool, store, owner.id, p.other, other))).toBe('invalid_input');
  expect(await stored(p.id, 'other.tex')).toBe('Other.\n');
});

test('of two different commands on the same stretch at once, one applies', async () => {
  const p = await paper();
  const text = await open(p.main);
  const results = await Promise.all(
    ['\\emph{beta}', '\\textbf{beta}'].map((to) =>
      runCommand(t.pool, store, owner.id, p.main, replace(text, 'beta', to)),
    ),
  );
  expect(results.map((r) => r.result).sort()).toEqual(['applied', 'conflict']);
  const out = await stored(p.id);
  expect(
    out === MAIN.replace('beta', '\\emph{beta}') || out === MAIN.replace('beta', '\\textbf{beta}'),
  ).toBe(true);
});

test('only people who may write can run a command, and a malformed one is refused', async () => {
  const p = await paper();
  const c = replace(await open(p.main), 'beta', 'BETA');
  expect(await code(runCommand(t.pool, store, viewer.id, p.main, c))).toBe('permission_denied');
  expect(await code(runCommand(t.pool, store, outsider.id, p.main, c))).toBe('not_found');
  for (const bad of [
    null,
    'beta',
    { ...c, key: 'not-a-uuid' },
    { ...c, from: new Uint8Array() },
    { ...c, from: 'AAAA' },
    { ...c, to: new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]) },
    { ...c, expected: 7 },
    { ...c, replacement: 'a\r\nb' },
    { ...c, replacement: 'x'.repeat(1_000_001) },
  ])
    expect(
      await code(runCommand(t.pool, store, owner.id, p.main, bad)),
      JSON.stringify(bad)?.slice(0, 60),
    ).toBe('invalid_input');
  expect(await stored(p.id)).toBe(MAIN);
});

test('compacting leaves one log entry, the same text, and old copies still merge', async () => {
  const p = await paper();
  const early = await open(p.main);
  for (let i = 0; i < 30; i++)
    await editFile(t.pool, store, p.main, owner.id, (text) => text.insert(text.length, `${i}\n`));
  await editFile(t.pool, store, p.main, owner.id, (text) => text.delete(0, 5));
  const before = await stored(p.id);
  const head = (await t.pool.query('select head_seq from files where id = $1', [p.main])).rows[0];
  expect(await rows(p.main)).toBe(32);

  expect(await compactFile(t.pool, p.main)).toBe(31);
  expect(await rows(p.main)).toBe(1);
  expect(await stored(p.id)).toBe(before);
  // The file's place in its history has not moved, and compacting again finds nothing to do.
  expect(
    (await t.pool.query('select head_seq from files where id = $1', [p.main])).rows[0],
  ).toEqual(head);
  expect(await compactFile(t.pool, p.main)).toBe(0);

  // A copy opened before all that, with an edit of its own, merges with the compacted log.
  early.insert(early.toString().indexOf('Second'), 'OFFLINE ');
  const late = await open(p.main);
  Y.applyUpdate(late.doc!, Y.encodeStateAsUpdate(early.doc!));
  Y.applyUpdate(early.doc!, Y.encodeStateAsUpdate(late.doc!));
  expect(early.toString()).toBe(late.toString());
  expect(late.toString()).toBe(before.replaceAll('\r\n', '\n').replace('Second', 'OFFLINE Second'));
  // Editing and commands carry on from the compacted log.
  const c = replace(await open(p.main), 'gamma', 'GAMMA');
  expect(await runCommand(t.pool, store, owner.id, p.main, c)).toMatchObject({ result: 'applied' });
  expect(await stored(p.id)).toBe(before.replace('gamma', 'GAMMA'));
});

test('600 server-side edits with no sync server leave a log of at most 500 entries, and the same text', async () => {
  const p = await paper();
  for (let i = 0; i < 600; i++)
    await editFile(t.pool, store, p.main, owner.id, (text) => text.insert(text.length, `${i}\n`));
  expect(await rows(p.main)).toBeLessThanOrEqual(500);
  const lines = (await open(p.main)).toString().split('\n');
  expect(lines.slice(-601, -1)).toEqual(Array.from({ length: 600 }, (_, i) => `${i}`));
}, 180_000);

test('edits that insert and delete large text do not leave a log of megabytes', async () => {
  const p = await paper();
  const before = process.env.SYNC_COMPACT_BYTES;
  process.env.SYNC_COMPACT_BYTES = '1000000';
  try {
    const big = 'abcdefghi\n'.repeat(30_000);
    for (let i = 0; i < 10; i++) {
      await editFile(t.pool, store, p.main, owner.id, (text) => text.insert(text.length, big));
      await editFile(t.pool, store, p.main, owner.id, (text) =>
        text.delete(text.length - big.length, big.length),
      );
    }
  } finally {
    if (before === undefined) delete process.env.SYNC_COMPACT_BYTES;
    else process.env.SYNC_COMPACT_BYTES = before;
  }
  const { bytes } = (
    await t.pool.query(
      'select sum(octet_length(update))::float8 as bytes from file_updates where file_id = $1',
      [p.main],
    )
  ).rows[0];
  expect(bytes).toBeLessThan(1_500_000);
  expect((await open(p.main)).toString()).toBe(MAIN.replaceAll('\r\n', '\n'));
}, 120_000);

test('with exactPlace, an insertion whose anchors were deleted is refused; without it, it applies', async () => {
  const p = await paper();
  const text = await open(p.main);
  const at = text.toString().indexOf(' beta');
  const insertion = (): Command => ({
    key: randomUUID(),
    from: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at, 0)),
    to: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at, -1)),
    expected: '',
    replacement: ' not',
  });
  const [a, b] = [insertion(), insertion()];
  // Both neighbours go: the two anchors close up to one place, which reads as "" as it did.
  await editFile(t.pool, store, p.main, owner.id, (x) => {
    const i = x.toString().indexOf('Alpha beta');
    x.delete(i, 'Alpha beta'.length);
    x.insert(i, 'Omega');
  });
  const before = await stored(p.id);
  expect(await runCommand(t.pool, store, owner.id, p.main, a, { exactPlace: true })).toMatchObject({
    result: 'conflict',
  });
  expect(await stored(p.id)).toBe(before);
  expect(await rows(p.main)).toBeGreaterThan(0);
  // The same command without the option applies, as it always has.
  expect(await runCommand(t.pool, store, owner.id, p.main, b)).toMatchObject({ result: 'applied' });
  expect(await stored(p.id)).not.toBe(before);
});

test('a contained command is refused when another editor deleted the space after its atom', async () => {
  const zip = await writeZip([
    {
      path: 'main.tex',
      bytes: Buffer.from(
        '\\documentclass{article}\n\\begin{document}\n\\newcommand{\\sys}{S}\n\nUse \\sys{} now and later.\n',
      ),
    },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Contained');
  const file = (await listFiles(t.pool, owner.id, project.id))[0].id;
  const flagged = { ...replace(await open(file), '\\sys{}', '\\sys'), contained: true };
  const bare = { ...replace(await open(file), '\\sys{}', '\\sys'), key: randomUUID() };
  await editFile(t.pool, store, file, owner.id, (text) =>
    text.delete(text.toString().indexOf('{} now') + 2, 1),
  );
  const before = await rows(file);
  const refused = await runCommand(t.pool, store, owner.id, file, flagged);
  expect(refused).toEqual({
    result: 'conflict',
    text: '\\documentclass{article}\n\\begin{document}\n\\newcommand{\\sys}{S}\n\nUse \\sys{}now and later.\n',
  });
  expect(await rows(file)).toBe(before);
  // Not flagged, the same command applies and breaks the text: the flag is what protects.
  expect((await runCommand(t.pool, store, owner.id, file, bare)).result).toBe('applied');
  expect((await open(file)).toString()).toContain('Use \\sysnow and');
  // A flag that is not a boolean is refused.
  expect(
    await code(
      runCommand(t.pool, store, owner.id, file, { ...bare, key: randomUUID(), contained: 'yes' }),
    ),
  ).toBe('invalid_input');
});

test('a contained command in a large file is checked on a window and still applies', async () => {
  const para =
    'A paragraph of ordinary words with \\cite{a} and some $x + y$ in it, to fill space.';
  const head = '\\documentclass{article}\n\\begin{document}\n\\newcommand{\\sys}{S}\n\n';
  // About 5 MB; a full parse of it twice would take seconds inside the row lock.
  const half = `${Array(30_000).fill(para).join('\n\n')}\n\n`;
  const zip = await writeZip([
    {
      path: 'main.tex',
      bytes: Buffer.from(`${head}${half}Use \\sys{} now and later.\n\n${half}\\end{document}\n`),
    },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Large');
  const file = (await listFiles(t.pool, owner.id, project.id))[0].id;
  const text = await open(file);
  expect(text.length).toBeGreaterThan(4_000_000);
  const flagged = { ...replace(text, '\\sys{}', '\\cite{k}'), contained: true };
  const started = performance.now();
  expect(await runCommand(t.pool, store, owner.id, file, flagged)).toMatchObject({
    result: 'applied',
  });
  expect(performance.now() - started).toBeLessThan(1000);
  expect((await open(file)).toString()).toContain('Use \\cite{k} now and later.');
  // One that spills into its neighbour is still caught.
  const spill = { ...replace(await open(file), '\\cite{k}', '\\sys'), contained: true };
  await editFile(t.pool, store, file, owner.id, (y) =>
    y.delete(y.toString().indexOf('\\cite{k} now') + 8, 1),
  );
  expect((await runCommand(t.pool, store, owner.id, file, spill)).result).toBe('conflict');
});

test('a contained command on a display formula is applied', async () => {
  const zip = await writeZip([
    {
      path: 'main.tex',
      bytes: Buffer.from(
        '\\documentclass{article}\n\\begin{document}\n\nBefore.\n\n\\begin{equation}\nx = 1\n\\end{equation}\n\nAfter.\n',
      ),
    },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Display');
  const file = (await listFiles(t.pool, owner.id, project.id))[0].id;
  const was = '\\begin{equation}\nx = 1\n\\end{equation}';
  const now = '\\begin{equation}\ny = 2\n\\end{equation}';
  const flagged = { ...replace(await open(file), was, now), contained: true };
  expect(await runCommand(t.pool, store, owner.id, file, flagged)).toMatchObject({
    result: 'applied',
  });
  expect((await open(file)).toString()).toContain(`Before.\n\n${now}\n\nAfter.`);
  // Losing its end swallows the paragraph after it, and is refused.
  const spill = { ...replace(await open(file), now, '\\begin{equation}\nz'), contained: true };
  expect((await runCommand(t.pool, store, owner.id, file, spill)).result).toBe('conflict');
});

test('a command that would cut an emoji in two is refused, and changes nothing', async () => {
  const p = await paper();
  await editFile(t.pool, store, p.main, owner.id, (text) =>
    text.insert(text.toString().indexOf('beta'), '\u{1F600}'),
  );
  const text = await open(p.main);
  const now = text.toString();
  const at = (i: number) =>
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, i));
  const emoji = now.indexOf('\u{1F600}');
  const was = await rows(p.main);
  // Starting between the halves, ending between them, and a replacement that is half an emoji.
  for (const [from, to, replacement] of [
    [emoji + 1, emoji + 3, '\\emph{x}'],
    [emoji - 1, emoji + 1, '\\emph{x}'],
    [emoji, emoji, '\ud83d'],
    [emoji + 2, emoji + 2, '\ude00'],
  ] as const) {
    const c: Command = {
      key: randomUUID(),
      from: at(from),
      to: at(to),
      expected: now.slice(from, to),
      replacement,
    };
    expect(await runCommand(t.pool, store, owner.id, p.main, c)).toEqual({
      result: 'conflict',
      text: now,
    });
  }
  expect(await rows(p.main)).toBe(was);
  expect((await open(p.main)).toString()).toBe(now);
});

test("a contained command inside a paper's own theorem environment is checked with the names it carries", async () => {
  const zip = await writeZip([
    {
      path: 'main.tex',
      bytes: Buffer.from(
        '\\documentclass{article}\n\\newtheorem{observation}{Observation}\n\\begin{document}\n\n' +
          '\\begin{observation}\nWords \\cite{a} here.\n\\end{observation}\n\nAfter.\n',
      ),
    },
  ]);
  const [project] = await importZip(t.pool, store, owner.id, zip, 'Own theorem');
  const file = (await listFiles(t.pool, owner.id, project.id))[0].id;
  const edit = async (replacement: string, extra: Partial<Command> = {}) => ({
    ...replace(await open(file), '\\cite{a}', replacement),
    contained: true,
    ...extra,
  });
  // The editor that made the command held the name; the server uses the command's own set.
  const none = await edit('\\cite{b}');
  expect((await runCommand(t.pool, store, owner.id, file, none)).result).toBe('conflict');
  const named = await edit('\\cite{b}', { prose: ['observation'] });
  expect((await runCommand(t.pool, store, owner.id, file, named)).result).toBe('applied');
  expect((await open(file)).toString()).toContain('Words \\cite{b} here.');
  // The name does not make a spill acceptable.
  const spill = { ...replace(await open(file), '\\cite{b}', '\\cite{c}\n\nnew'), contained: true };
  expect(
    (await runCommand(t.pool, store, owner.id, file, { ...spill, prose: ['observation'] })).result,
  ).toBe('conflict');
  // Names that are not environments of prose, or too many, are refused as malformed.
  const again = { ...replace(await open(file), '\\cite{b}', '\\cite{d}'), contained: true };
  for (const prose of [['verbatim'], ['align*'], ['a{b'], [7], 'observation', ['x'.repeat(33)]])
    expect(
      await code(
        runCommand(t.pool, store, owner.id, file, { ...again, key: randomUUID(), prose } as never),
      ),
    ).toBe('invalid_input');
  const many = Array.from(
    { length: 65 },
    (_, i) =>
      'e' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)),
  );
  expect(
    await code(
      runCommand(t.pool, store, owner.id, file, { ...again, key: randomUUID(), prose: many }),
    ),
  ).toBe('invalid_input');
  expect(
    await code(
      runCommand(t.pool, store, owner.id, file, {
        ...again,
        key: randomUUID(),
        prose: many.slice(0, 64),
      }),
    ),
  ).toBe('ok');
});
