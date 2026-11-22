// Content-addressed storage for file bytes: the key is the SHA-256 of the content, so the same
// bytes are stored once and a stored blob can never change.
import { createHash, randomUUID } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { AppError } from './errors.ts';

export type BlobStore = {
  /** Store bytes and return their digest. Storing the same bytes twice is harmless. */
  put(bytes: Uint8Array): Promise<string>;
  /** The bytes for a digest, or null if there are none. */
  get(digest: string): Promise<Uint8Array | null>;
  /** The size in bytes of a stored blob, or null if there is none. Nothing is read. */
  size(digest: string): Promise<number | null>;
  /**
   * An address the browser may fetch a stored blob from for a few minutes, with no further
   * sign-in. It names the file the browser saves it as and says what it is.
   */
  link(
    digest: string,
    opts: { type: string; disposition: string; seconds?: number },
  ): Promise<string>;
  /**
   * An address the browser may PUT one file to, once, for a few minutes, and the key it is
   * stored under until it is taken. The address accepts only a body of exactly `size` bytes: the
   * length is one of the signed headers, so a store that checks signatures refuses another. The
   * object is private: only a signed address reads it.
   */
  uploadUrl(userId: string, size: number): Promise<{ key: string; url: string }>;
  /** The size of an object put through `uploadUrl`, or null if nothing was put. */
  uploadSize(key: string): Promise<number | null>;
  /** The bytes of an object put through `uploadUrl`. */
  uploadRead(key: string): Promise<Uint8Array>;
  /** Remove an object put through `uploadUrl`. Removing one that is gone is harmless. */
  uploadDrop(key: string): Promise<void>;
  /** Remove every upload older than this many milliseconds. Returns how many. */
  uploadSweep(olderThanMs: number): Promise<number>;
};

/** Where uploads wait between the browser's PUT and the call that takes them. */
const UPLOAD_KEY = /^tmp\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

const ANSWER_MS = 10_000;
const BYTES_PER_MS = 100;
/** The longest a body of unknown length (chunked) may take. */
const UNKNOWN_LENGTH_MS = 10 * 60_000;

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
  // The address browsers use for the store, if it is not the one this process uses.
  const publicBucket = `${(env.S3_PUBLIC_ENDPOINT || need('S3_ENDPOINT')).replace(/\/$/, '')}/${need('S3_BUCKET')}`;
  const path = (digest: string) => {
    // A digest is the only thing that may become part of a storage key.
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('not a sha256 digest');
    return `sha256/${digest.slice(0, 2)}/${digest}`;
  };
  const url = (digest: string) => `${bucket}/${path(digest)}`;
  const uploadKey = (key: string) => {
    if (!UPLOAD_KEY.test(key)) throw new Error('not an upload key');
    return `${bucket}/${key}`;
  };
  let ready: Promise<unknown> | undefined;
  /** The timers that watch a response's body, to be cleared when it has been read. */
  const watching = new WeakMap<Response, ReturnType<typeof setTimeout>>();
  /**
   * A request to the store that gives up when the line has gone quiet: the store has 10 seconds
   * to answer, and then the body, in or out, is allowed to move at 100 kB/s at least (a body of
   * unknown length, ten minutes). A flat limit would cut a large download or leave a dead line
   * hanging for minutes. A caller that has the response calls `settle` when it is done with it.
   */
  const ask = async (address: string, init: RequestInit = {}, sending = 0) => {
    const stop = new AbortController();
    const allow = (ms: number) =>
      setTimeout(
        () =>
          stop.abort(
            new AppError('unavailable', 'The file store did not answer. Try again in a moment.'),
          ),
        ms,
      ).unref();
    const first = allow(ANSWER_MS + sending / BYTES_PER_MS);
    const res = await s3
      .fetch(address, { ...init, signal: stop.signal })
      .finally(() => clearTimeout(first));
    // A HEAD has no body to wait for.
    if (init.method !== 'HEAD') {
      const length = res.headers.get('content-length');
      watching.set(
        res,
        allow(length === null ? UNKNOWN_LENGTH_MS : ANSWER_MS + Number(length) / BYTES_PER_MS),
      );
    }
    return res;
  };
  const settle = (res: Response) => clearTimeout(watching.get(res));
  // Creating a bucket that exists is an error we can ignore; a real failure shows on the PUT.
  // A failure is not kept: the next call asks again.
  const bucketReady = () =>
    (ready ??= ask(bucket, { method: 'PUT' }).then(settle, (err) => {
      ready = undefined;
      throw err;
    }));
  /** A signed address, to be used by whoever holds it, until it expires. */
  const signed = async (
    address: string,
    method: string,
    seconds: number,
    query: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) => {
    const u = new URL(address);
    u.searchParams.set('X-Amz-Expires', String(seconds));
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    // allHeaders: the length of a body is a header the library does not sign unless told to.
    const request = await s3.sign(u.href, {
      method,
      headers,
      aws: { signQuery: true, allHeaders: true },
    });
    return request.url;
  };
  const head = async (address: string) => {
    const res = await ask(address, { method: 'HEAD' });
    settle(res);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`blob store refused a read: ${res.status}`);
    return Number(res.headers.get('content-length'));
  };
  return {
    async put(bytes) {
      await bucketReady();
      const digest = sha256(bytes);
      const res = await ask(url(digest), { method: 'PUT', body: bytes as BodyInit }, bytes.length);
      settle(res);
      if (!res.ok) throw new Error(`blob store refused a write: ${res.status}`);
      return digest;
    },
    async get(digest) {
      const res = await ask(url(digest));
      if (res.status === 404 || !res.ok) settle(res);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`blob store refused a read: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer().finally(() => settle(res)));
      // Never hand back bytes that are not what was asked for.
      if (sha256(bytes) !== digest) throw new Error(`blob ${digest} is corrupt`);
      return bytes;
    },
    size: (digest) => head(url(digest)),
    async link(digest, { type, disposition, seconds = 300 }) {
      return signed(`${publicBucket}/${path(digest)}`, 'GET', seconds, {
        'response-content-type': type,
        'response-content-disposition': disposition,
      });
    },
    async uploadUrl(userId, size) {
      await bucketReady();
      if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('not a user id');
      const key = `tmp/${userId}/${randomUUID()}`;
      if (!Number.isInteger(size) || size < 1) throw new Error('not a size');
      const headers = { 'content-length': String(size) };
      return { key, url: await signed(`${publicBucket}/${key}`, 'PUT', 600, {}, headers) };
    },
    uploadSize: (key) => head(uploadKey(key)),
    async uploadRead(key) {
      const res = await ask(uploadKey(key));
      if (!res.ok) settle(res);
      if (!res.ok) throw new Error(`blob store refused a read: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer().finally(() => settle(res)));
    },
    async uploadDrop(key) {
      const res = await ask(uploadKey(key), { method: 'DELETE' });
      settle(res);
      if (!res.ok && res.status !== 404)
        throw new Error(`blob store refused a delete: ${res.status}`);
    },
    async uploadSweep(olderThanMs) {
      await bucketReady();
      let swept = 0;
      let token = '';
      do {
        const list = new URL(bucket);
        list.search = new URLSearchParams({
          'list-type': '2',
          prefix: 'tmp/',
          ...(token ? { 'continuation-token': token } : {}),
        }).toString();
        const res = await ask(list.href);
        if (!res.ok) settle(res);
        if (!res.ok) throw new Error(`blob store refused a listing: ${res.status}`);
        const xml = await res.text().finally(() => settle(res));
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = /<Key>([^<]*)<\/Key>/.exec(m[1])?.[1];
          const when = Date.parse(/<LastModified>([^<]*)<\/LastModified>/.exec(m[1])?.[1] ?? '');
          if (key && UPLOAD_KEY.test(key) && Date.now() - when > olderThanMs) {
            await this.uploadDrop(key);
            swept++;
          }
        }
        token = /<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? '';
      } while (token);
      return swept;
    },
  };
}
