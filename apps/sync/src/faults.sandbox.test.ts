// The fault suite: three people type in one file while connections drop, edits are delivered
// twice, the server is killed, access is taken away and given back, and the paper is restored.
// Nothing the server acknowledged may be lost, and everyone must end with the same text.
// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
// FAULTS=<n> sets the number of steps; SEED=<n> replays a run.
import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  acceptInvitation,
  blobStore,
  exportRevision,
  exportZip,
  importZip,
  invite,
  listFiles,
  listRevisions,
  readZip,
  restoreRevision,
  saveRevision,
  setRole,
  writeZip,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { type Client, closeAll, connect, saved, until } from './testing.ts';

const SECRET = TEST_ENV.BETTER_AUTH_SECRET;
const store = blobStore(TEST_ENV);
const STEPS = Number(process.env.FAULTS ?? 120);
const SEED = Number(process.env.SEED ?? Date.now() % 1_000_000_000);
const MAIN = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
let t: Awaited<ReturnType<typeof testDb>>;
let child: ChildProcess | undefined;

beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  child?.kill('SIGKILL');
  closeAll();
  await t.close();
});

/** A small seeded generator, so that a failing run can be replayed. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), a | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
/** Every line that is one of the marks people type, in order. */
const marks = (text: string) => text.split('\n').filter((line) => /^<\w+\.\d+>$/.test(line));

test(`${STEPS} steps of typing through faults lose nothing (seed ${SEED})`, async () => {
  const rand = random(SEED);
  const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)];
  const names = ['owner', 'editor', 'second'] as const;
  const users = Object.fromEntries(
    await Promise.all(names.map(async (n) => [n, await t.signIn(`${n}@example.org`)] as const)),
  );
  const zip = await writeZip([{ path: 'main.tex', bytes: Buffer.from(MAIN) }]);
  const [project] = await importZip(t.pool, store, users.owner.id, zip, 'Faults');
  for (const n of ['editor', 'second'] as const) {
    const { token } = await invite(t.pool, users.owner.id, project.id, users[n].email, 'editor');
    await acceptInvitation(t.pool, users[n].id, token);
  }
  const [{ id: file }] = await listFiles(t.pool, users.owner.id, project.id);

  // The server runs as a process of its own so that it can be killed without warning. It
  // compacts often, so that compaction is one of the things that happens mid-run.
  const port = 4800 + Math.floor(Math.random() * 400);
  const env = {
    ...process.env,
    ...TEST_ENV,
    DATABASE_URL: t.url,
    SYNC_PORT: String(port),
    SYNC_COMPACT_EVERY: '15',
  };
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

  type Person = Client & { name: string; online: boolean; last?: Uint8Array; mine: string[] };
  const people: Person[] = names.map((name) => {
    const c = connect(SECRET, users[name], file, port) as Person;
    c.name = name;
    c.online = true;
    c.mine = [];
    // Remember the last edit each person made, to deliver it a second time later.
    c.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== c.provider && origin !== 'again') c.last = update;
    });
    return c;
  });
  await saved(...people);

  /** The file as the stored log has it, read the way a download reads it. */
  const stored = async () => {
    const { entries } = await readZip(await exportZip(t.pool, store, users.owner.id, project.id));
    return Buffer.from(entries[0].bytes).toString();
  };
  const typed = new Set<string>();
  /** Marks the server has acknowledged, and that no restore has taken away since. */
  let acknowledged = new Set<string>();
  /** Marks a restore took away. */
  let gone = new Set<string>();
  const saves: { id: string; marks: Set<string> }[] = [];
  /** Whether the editor's write access is currently taken away. */
  let revoked = false;
  let count = 0;
  const history: string[] = [];

  /** Everyone who can reach the server and may write has had their edits confirmed. */
  const settle = async () => {
    const able = people.filter((p) => p.online && !(revoked && p.name === 'editor'));
    await saved(...able);
    const now = marks(await stored());
    // The server holds everything these people typed. What a restore took away stays away.
    for (const p of able) for (const m of p.mine) if (!gone.has(m)) acknowledged.add(m);
    const set = new Set(now);
    if (set.size !== now.length) throw new Error('a mark is stored twice');
    for (const m of acknowledged)
      if (!set.has(m)) throw new Error(`acknowledged mark ${m} is missing from the stored text`);
    return set;
  };
  /**
   * Connect someone who was disconnected on purpose. The library ignores a request to connect
   * made while the old connection is still closing, so wait until it no longer counts as
   * connected before asking.
   */
  const reconnect = async (p: Person) => {
    await until('the old connection to close', () => p.socket.status !== 'connected');
    void p.socket.connect();
    await until(`${p.name} to reconnect`, () => p.socket.status === 'connected');
  };
  const type = (p: Person) => {
    const text = p.text.toString();
    // Marks are whole lines, put at the start of a line, so one never lands inside another.
    const starts = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
    const mark = `<${p.name}.${count++}>`;
    typed.add(mark);
    p.mine.push(mark);
    p.text.insert(pick(starts), `${mark}\n`);
  };

  const steps: [number, string, () => Promise<void> | void][] = [
    [50, 'type', () => type(pick(people))],
    [8, 'burst', () => void Array.from({ length: 12 }, () => type(pick(people)))],
    [
      8,
      'drop',
      () => {
        const p = pick(people.filter((x) => x.online));
        if (!p) return;
        p.online = false;
        p.socket.disconnect();
      },
    ],
    [
      10,
      'return',
      async () => {
        const p = pick(people.filter((x) => !x.online));
        if (!p) return;
        p.online = true;
        await reconnect(p);
      },
    ],
    [
      6,
      'again',
      () => {
        // The same edit arrives a second time, as after a retry whose answer was lost.
        const p = pick(people.filter((x) => x.last));
        if (p) p.doc.emit('update', [p.last!, 'again', p.doc, null as never]);
      },
    ],
    [
      5,
      'kill',
      async () => {
        child!.kill('SIGKILL');
        await until('the server to be gone', () => child!.exitCode !== null || !!child!.signalCode);
        // With the server dead, the log alone must hold everything it acknowledged.
        const now = new Set(marks(await stored()));
        for (const m of acknowledged)
          if (!now.has(m)) throw new Error(`after a kill, acknowledged mark ${m} is not stored`);
        await start();
      },
    ],
    [
      4,
      'revoke',
      async () => {
        revoked = !revoked;
        await setRole(
          t.pool,
          users.owner.id,
          project.id,
          users.editor.id,
          revoked ? 'viewer' : 'editor',
        );
        if (revoked) return;
        // Given back: what the editor typed meanwhile is sent when they next connect.
        const editor = people[1];
        if (!editor.online) return;
        editor.socket.disconnect();
        await reconnect(editor);
      },
    ],
    [4, 'check', async () => void (await settle())],
    [
      3,
      'save',
      async () => {
        const now = await settle();
        const { id } = await saveRevision(t.pool, store, users.owner.id, project.id, `s${count}`);
        saves.push({ id, marks: now });
      },
    ],
    [
      2,
      'restore',
      async () => {
        const to = pick(saves);
        if (!to) return;
        const before = await settle();
        const restored = await restoreRevision(t.pool, store, users.owner.id, project.id, to.id);
        // The restore itself: the stored text is the saved text, mark for mark.
        const after = marks(await stored());
        if ([...to.marks].some((m) => !after.includes(m)) || after.length !== new Set(after).size)
          throw new Error('right after a restore, the stored text is not the restored revision');
        // The paper as it stood is the revision before the restore. It holds everything stored
        // until then, including an edit that arrived a moment before from someone now offline.
        const kept = (await listRevisions(t.pool, users.owner.id, project.id)).find(
          (r) => r.number === restored.number - 1,
        )!;
        const { zip } = await exportRevision(t.pool, store, users.owner.id, project.id, kept.id);
        const was = marks(Buffer.from((await readZip(zip)).entries[0].bytes).toString());
        if ([...before].some((m) => !was.includes(m)))
          throw new Error('the revision kept before a restore lacks text that was stored');
        // What the restore took away is gone on purpose; what it brought back is back.
        gone = new Set([...gone, ...was].filter((m) => !to.marks.has(m)));
        acknowledged = new Set([...acknowledged].filter((m) => to.marks.has(m)));
      },
    ],
  ];
  const total = steps.reduce((n, [weight]) => n + weight, 0);

  try {
    for (let i = 0; i < STEPS; i++) {
      let roll = rand() * total;
      const [, name, run] = steps.find(([weight]) => (roll -= weight) < 0)!;
      history.push(name);
      await run();
      await new Promise((r) => setTimeout(r, Math.floor(rand() * 12)));
    }
    // The faults stop: everyone comes back, the editor may write again, and all is confirmed.
    if (revoked) {
      revoked = false;
      await setRole(t.pool, users.owner.id, project.id, users.editor.id, 'editor');
    }
    for (const p of people) {
      p.online = true;
      p.socket.disconnect();
    }
    await Promise.all(people.map(reconnect));
    await settle();
    const final = await stored();
    await until('everyone to have the stored text', () =>
      people.every((p) => p.text.toString() === final),
    );
    // Every mark anyone typed is there exactly once, unless a restore took it away.
    const want = [...typed].filter((m) => !gone.has(m)).sort();
    expect(marks(final).sort()).toEqual(want);
    expect(typed.size).toBeGreaterThan(STEPS / 3);
  } catch (err) {
    (err as Error).message +=
      ` (replay with SEED=${SEED} FAULTS=${STEPS}; steps: ${history.slice(-25).join(' ')})`;
    throw err;
  }
}, 240_000);
