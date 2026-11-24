// The build pane's clock, moved by hand, against a made-up server and worker.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { autobuild, type Builds, NO_ANSWER } from './autobuild';

const L = 30; // a request's round trip
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const page = { hidden: false, listeners: [] as (() => void)[] };

type Made = { id: string; status: 'queued' | 'succeeded'; cut: number | null };
/** A paper, its builds and one page's pane. `buildMs`: how long the worker takes. */
function paper(buildMs = 1500) {
  let edits = 0;
  let latest: Made | null = null;
  let lastGood: Made | null = null;
  const posts: number[] = [];
  const gets: number[] = [];
  // What the server says to the next automatic request, once, instead of building.
  // `cutAt`: a worker that builds a paper as it stood at that mark, whatever has been typed since.
  const server = { refuse: '', down: false, cutAt: null as number | null };
  const view = (b: Made | null) =>
    b && {
      id: b.id,
      status: b.status,
      stale: b.status !== 'queued' && b.cut !== edits,
      revisionId: b.status === 'queued' ? null : `r${b.cut}`,
    };
  const answer = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', async (_url: string, init?: { method?: string }) => {
    await sleep(L);
    if (server.down) return answer({}, 503);
    if (init?.method !== 'POST') {
      gets.push(Date.now());
      return answer({ latest: view(latest), lastGood: view(lastGood), edits: `${edits}` });
    }
    posts.push(Date.now());
    if (server.refuse) {
      const paused = server.refuse;
      server.refuse = '';
      return answer({ id: null, paused });
    }
    if (latest?.status !== 'queued') {
      const b: Made = { id: `b${posts.length}`, status: 'queued', cut: null };
      latest = b;
      // The worker is told at once, and builds the paper as it stands then.
      setTimeout(() => (b.cut = server.cutAt ?? edits), 20);
      setTimeout(() => {
        b.status = 'succeeded';
        lastGood = b;
      }, buildMs);
    }
    return answer({ id: latest!.id });
  });
  const heard: Builds[] = [];
  const said = { problem: '', paused: '' };
  const pane = autobuild({
    url: '/projects/p/builds',
    canBuild: true,
    heard: (next) => heard.push(next),
    problem: (p) => (said.problem = typeof p === 'function' ? p(said.problem) : p),
    paused: (why) => (said.paused = why),
  });
  let asking: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  return {
    pane,
    posts,
    gets,
    heard,
    said,
    server,
    wait: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    /** When the pane first heard of a PDF that is of the paper as it stands. */
    upToDate: () => heard.find((h) => h.latest?.status === 'succeeded' && !h.latest.stale),
    /** A key in this page's editor: the editor says "saved" 300 ms and a round trip later. */
    key() {
      edits++;
      const v = ++version;
      pane.typed(true);
      clearTimeout(asking);
      asking = setTimeout(() => setTimeout(() => v === version && pane.typed(false), L), 300);
    },
    /** Someone else's key: the paper changes and this page's editor says nothing. */
    other: () => void edits++,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  page.hidden = false;
  page.listeners = [];
  vi.stubGlobal('document', {
    get hidden() {
      return page.hidden;
    },
    addEventListener: (_: string, fn: () => void) => page.listeners.push(fn),
    removeEventListener: () => {},
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A paper built once and left alone, `phase` ms into the quiet poll's turn. */
async function quiet(phase = 0, buildMs = 1500) {
  const p = paper(buildMs);
  await p.wait(buildMs + 20_000 + phase);
  expect(p.posts.length).toBe(1);
  p.posts.length = p.gets.length = p.heard.length = 0;
  return p;
}

test.each([0, 1300, 2600, 3900, 4900])(
  "this editor's edit is asked for two seconds after its last key, %i ms into a quiet turn",
  async (phase) => {
    const p = await quiet(phase);
    const t = Date.now();
    p.key();
    await p.wait(10_000);
    expect(p.posts.length).toBe(1);
    expect(p.posts[0] - t).toBeGreaterThanOrEqual(2000);
    expect(p.posts[0] - t).toBeLessThan(2200);
    p.pane.stop();
  },
);

test('nothing is asked for while the typing goes on, and one build follows it', async () => {
  const p = await quiet();
  for (let i = 0; i < 50; i++) {
    p.key();
    await p.wait(200);
  }
  expect(p.posts).toEqual([]);
  await p.wait(10_000);
  expect(p.posts.length).toBe(1);
  p.pane.stop();
});

test("someone else's edit is built once the paper has been still for a poll, as before", async () => {
  const p = await quiet(1000);
  const t = Date.now();
  p.other();
  await p.wait(12_000);
  expect(p.posts.length).toBe(1);
  // Seen at the next quiet poll, built at the one after: two seconds on.
  const saw = p.gets.find((g) => g >= t)!;
  expect(p.posts[0] - saw).toBeGreaterThanOrEqual(2000);
  expect(p.posts[0] - saw).toBeLessThan(2200);
  p.pane.stop();
});

test('a finished build is heard of within half a second, at every phase', async () => {
  for (const buildMs of [700, 1500, 2300, 4100]) {
    const p = await quiet(0, buildMs);
    p.key();
    await p.wait(12_000);
    const done = p.posts[0] + buildMs;
    const at = p.gets.find((g) => g >= done)!;
    expect(at - done).toBeLessThanOrEqual(500 + 2 * L);
    p.pane.stop();
  }
});

test('a build that takes long is asked about every two seconds after its first ten', async () => {
  const p = await quiet(0, 40_000);
  p.key();
  await p.wait(2500);
  expect(p.posts.length).toBe(1);
  const t = p.posts[0];
  await p.wait(30_000);
  const late = p.gets.filter((g) => g > t + 12_000 && g <= t + 30_000);
  expect(late.length).toBeLessThanOrEqual(9);
  expect(late.length).toBeGreaterThanOrEqual(8);
  p.pane.stop();
});

test('a paper nobody touches is asked about every five seconds', async () => {
  const p = await quiet();
  await p.wait(30_000);
  expect(p.gets.length).toBe(6);
  expect(p.posts).toEqual([]);
  p.pane.stop();
});

test('Compile now from quiet: the PDF is heard of within half a second of being made', async () => {
  const p = await quiet(700);
  p.pane.setAuto(false);
  await p.wait(11_000);
  p.key();
  await p.wait(4000);
  expect(p.posts).toEqual([]);
  p.heard.length = 0;
  void p.pane.compile();
  await p.wait(L + 1500 + 500 + 2 * L);
  expect(p.upToDate()).toBeTruthy();
  p.pane.stop();
});

test('a refusal for now is asked about again after thirty seconds, with nothing typed', async () => {
  const p = await quiet();
  p.server.refuse = 'for now';
  p.key();
  await p.wait(5000);
  expect(p.posts.length).toBe(1);
  expect(p.said.paused).toBe('for now');
  await p.wait(20_000);
  expect(p.posts.length).toBe(1);
  await p.wait(15_000);
  expect(p.posts.length).toBe(2);
  expect(p.said.paused).toBe('');
  expect(p.upToDate()).toBeTruthy();
  p.pane.stop();
});

test('a page nobody is looking at asks for nothing, whatever its editor says', async () => {
  const p = await quiet();
  page.hidden = true;
  p.key();
  await p.wait(20_000);
  expect(p.gets).toEqual([]);
  expect(p.posts).toEqual([]);
  page.hidden = false;
  for (const tell of page.listeners) tell();
  // Looked at again: it asks at once, and builds what was typed meanwhile.
  await p.wait(200);
  expect(p.gets.length).toBeGreaterThanOrEqual(1);
  expect(p.posts.length).toBe(1);
  p.pane.stop();
});

test('a server that stops answering is said so after two tries, and unsaid when it answers', async () => {
  const p = await quiet();
  p.server.down = true;
  await p.wait(11_000);
  expect(p.said.problem).toBe(NO_ANSWER);
  p.server.down = false;
  await p.wait(6000);
  expect(p.said.problem).toBe('');
  p.pane.stop();
});

test('the box unticked: an edit is seen at once and not built; ticked, it is built at once', async () => {
  const p = await quiet(2500);
  p.pane.setAuto(false);
  await p.wait(6000);
  p.heard.length = 0;
  const t = Date.now();
  p.key();
  await p.wait(2200);
  // "The PDF is behind the text" is said two seconds after the key, not at the next turn.
  expect(p.heard.some((h) => h.latest?.stale)).toBe(true);
  expect(Date.now() - t).toBeLessThan(2300);
  await p.wait(10_000);
  expect(p.posts).toEqual([]);
  p.pane.setAuto(true);
  await p.wait(200);
  expect(p.posts.length).toBe(1);
  p.pane.stop();
});

test('a build that comes back behind is not asked for again until the paper changes', async () => {
  const p = await quiet();
  // A build that is of the paper as it was before the key, and says the same revision twice.
  p.server.cutAt = 0;
  p.key();
  await p.wait(30_000);
  expect(p.posts.length).toBe(1);
  expect(p.heard.at(-1)?.latest?.stale).toBe(true);
  p.key();
  await p.wait(10_000);
  expect(p.posts.length).toBe(2);
  p.pane.stop();
});

test('an edit made while a build is under way is asked for as soon as that build is done, if two seconds have passed', async () => {
  const p = await quiet(0, 4000);
  p.key();
  // The first build is asked for 2.0 to 2.2 s after the key: 2.3 s on, it is under way.
  await p.wait(2300);
  expect(p.posts.length).toBe(1);
  p.key(); // the build is under way, and was cut before this key
  await p.wait(10_000);
  expect(p.posts.length).toBe(2);
  const done = p.posts[0] + 4000;
  expect(p.posts[1] - done).toBeGreaterThanOrEqual(0);
  expect(p.posts[1] - done).toBeLessThan(600);
  p.pane.stop();
});
