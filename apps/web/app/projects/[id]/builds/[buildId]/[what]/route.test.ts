import { expect, test, vi } from 'vitest';

vi.mock('@paperweave/server', async (original) => ({
  ...(await original<typeof import('@paperweave/server')>()),
  buildOutputDigest: async () => 'digest',
  getProject: async () => ({ name: 'Paper' }),
}));
vi.mock('../../../../../../lib/server', () => ({
  currentUser: async () => ({ id: 'u' }),
  db: () => ({}),
  sendBlob: async (_request: Request, _digest: string, headers: Record<string, string>) =>
    new Response('body', { headers }),
}));

const { GET } = await import('./route.ts');

const get = (what: string) =>
  GET(new Request(`http://localhost/projects/p/builds/b/${what}`), {
    params: Promise.resolve({ id: 'p', buildId: 'b', what }),
  });

test('the log is served as UTF-8, because that is what TeX echoes of the sources', async () => {
  expect((await get('log')).headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect((await get('pdf')).headers.get('content-type')).toBe('application/pdf');
});
