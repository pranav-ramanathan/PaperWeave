// Content-addressed storage for file bytes: the key is the SHA-256 of the content, so the same
// bytes are stored once and a stored blob can never change.
import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';

export type BlobStore = {
  /** Store bytes and return their digest. Storing the same bytes twice is harmless. */
  put(bytes: Uint8Array): Promise<string>;
  /** The bytes for a digest, or null if there are none. */
  get(digest: string): Promise<Uint8Array | null>;
};

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function blobStore(env: Record<string, string | undefined> = process.env): BlobStore {
  const need = (k: string) => {
    if (!env[k]) throw new Error(`${k} is not set`);
    return env[k];
  };
  const s3 = new AwsClient({
    accessKeyId: need('S3_ACCESS_KEY'),
    secretAccessKey: need('S3_SECRET_KEY'),
    region: env.S3_REGION ?? 'us-east-1',
    service: 's3',
  });
  const bucket = `${need('S3_ENDPOINT').replace(/\/$/, '')}/${need('S3_BUCKET')}`;
  const url = (digest: string) => {
    // A digest is the only thing that may become part of a storage key.
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('not a sha256 digest');
    return `${bucket}/sha256/${digest.slice(0, 2)}/${digest}`;
  };
  let ready: Promise<unknown> | undefined;
  return {
    async put(bytes) {
      // Creating a bucket that exists is an error we can ignore; a real failure shows on the PUT.
      await (ready ??= s3.fetch(bucket, { method: 'PUT' }));
      const digest = sha256(bytes);
      const res = await s3.fetch(url(digest), { method: 'PUT', body: bytes as BodyInit });
      if (!res.ok) throw new Error(`blob store refused a write: ${res.status}`);
      return digest;
    },
    async get(digest) {
      const res = await s3.fetch(url(digest));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`blob store refused a read: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Never hand back bytes that are not what was asked for.
      if (sha256(bytes) !== digest) throw new Error(`blob ${digest} is corrupt`);
      return bytes;
    },
  };
}
