// Needs the services in infra/compose.yaml and the toolchain image. Run: pnpm test:sandbox
import {
  blobStore,
  createFromTemplate,
  editFile,
  exportZip,
  firstSteps,
  invite,
  listFiles,
  requestBuild,
  submissionChecks,
  TEMPLATES,
} from '@paperweave/server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { TEST_ENV, testDb } from '../../../packages/server/src/testing.ts';
import { buildNext, imageId } from './builder.ts';

const store = blobStore(TEST_ENV);
const image = imageId();
let t: Awaited<ReturnType<typeof testDb>>;
let owner: { id: string };

beforeAll(async () => {
  t = await testDb();
  owner = await t.signIn('owner@example.org');
});
afterAll(() => t.close());

test.each(TEMPLATES.map((x) => [x.id, x] as const))(
  'a paper started from the %s template builds as it is and is ready to send',
  async (_id, template) => {
    const project = await createFromTemplate(
      t.pool,
      store,
      owner.id,
      ' From a template ',
      template.id,
    );
    expect(project.name).toBe('From a template');
    expect((await listFiles(t.pool, owner.id, project.id)).map((f) => f.path).sort()).toEqual(
      Object.keys(template.files).sort(),
    );
    expect(
      (await t.pool.query('select template from projects where id = $1', [project.id])).rows[0]
        .template,
    ).toBe(template.id);

    await requestBuild(t.pool, owner.id, project.id);
    expect(await buildNext(t.pool, store, image)).toBe(true);
    // Built, every reference and citation resolved, nothing for the author to put right.
    const checks = await submissionChecks(t.pool, store, owner.id, project.id);
    expect(checks.findings.filter((f) => f.level === 'problem')).toEqual([]);
    expect(checks.findings.filter((f) => /undefined/i.test(f.message))).toEqual([]);
    expect(checks.ready).toBe(true);
  },
  120_000,
);

test('a new paper is shown how far it has come: written in, built, shared, taken away', async () => {
  const project = await createFromTemplate(t.pool, store, owner.id, 'First steps', 'article');
  const steps = () => firstSteps(t.pool, owner.id, project.id);
  const none = { hasFiles: true, written: false, built: false, shared: false, downloaded: false };
  expect(await steps()).toEqual(none);
  const [main] = (await listFiles(t.pool, owner.id, project.id)).filter(
    (f) => f.path === 'main.tex',
  );
  await editFile(t.pool, store, main.id, owner.id, (text) => text.insert(0, '% mine now\n'));
  expect(await steps()).toEqual({ ...none, written: true });
  await requestBuild(t.pool, owner.id, project.id);
  expect(await buildNext(t.pool, store, image)).toBe(true);
  expect(await steps()).toEqual({ ...none, written: true, built: true });
  // An invitation counts before it is taken up: the owner has done their part.
  await invite(t.pool, owner.id, project.id, 'colleague@example.org', 'editor');
  expect(await steps()).toEqual({ ...none, written: true, built: true, shared: true });
  await exportZip(t.pool, store, owner.id, project.id);
  expect(await steps()).toEqual({
    hasFiles: true,
    written: true,
    built: true,
    shared: true,
    downloaded: true,
  });
  const stranger = await t.signIn('stranger@example.org');
  await expect(firstSteps(t.pool, stranger.id, project.id)).rejects.toMatchObject({
    code: 'not_found',
  });
}, 120_000);

test('a template is chosen from the list, and the paper needs a name', async () => {
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e) => e.code ?? `unexpected: ${e.message}`,
    );
  expect(await code(createFromTemplate(t.pool, store, owner.id, 'x', 'nope'))).toBe(
    'invalid_input',
  );
  expect(await code(createFromTemplate(t.pool, store, owner.id, '  ', 'article'))).toBe(
    'invalid_input',
  );
});
