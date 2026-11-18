import { afterEach, expect, test } from 'vitest';
import { POST } from './route.ts';

const was = process.env.SPIKE;
afterEach(() => {
  if (was === undefined) delete process.env.SPIKE;
  else process.env.SPIKE = was;
});
const ask = (body: unknown) =>
  POST(
    new Request('http://localhost/api/spike/compile', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

test('the workbench compiles for nobody unless the server was started with SPIKE=1', async () => {
  const good = { project: 'article-basic', file: 'main.tex', text: 'x' };
  delete process.env.SPIKE;
  expect((await ask(good)).status).toBe(404);
  process.env.SPIKE = 'yes';
  expect((await ask(good)).status).toBe(404);
  // Switched on, it still takes only a file of one of its own fixtures. (Asked for something
  // else, it answers before it would compile anything.)
  process.env.SPIKE = '1';
  expect((await ask({ ...good, project: 'elsewhere' })).status).toBe(400);
  expect((await ask({ ...good, file: '../../etc/passwd.tex' })).status).toBe(400);
});
