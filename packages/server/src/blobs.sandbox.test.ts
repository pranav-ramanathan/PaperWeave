// Needs the services in infra/compose.yaml. Run: pnpm test:sandbox
import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { blobStore, sha256 } from './blobs.ts';
import { TEST_ENV } from './testing.ts';

const store = blobStore(TEST_ENV);

test('bytes come back exactly, keyed by their digest', async () => {
  const bytes = randomBytes(50_000);
  const digest = await store.put(bytes);
  expect(digest).toBe(sha256(bytes));
  expect(await store.put(bytes)).toBe(digest);
  expect(Buffer.from((await store.get(digest))!).equals(bytes)).toBe(true);
});

test('an unknown digest is null and a malformed one is refused', async () => {
  expect(await store.get(sha256(randomBytes(16)))).toBeNull();
  await expect(store.get('../../etc/passwd')).rejects.toThrow('not a sha256 digest');
});
