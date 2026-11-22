// Helpers for requests the server makes to other hosts: read an answer only up to a size, and
// do not follow a redirect (it could lead to a host we did not choose).

/** The body as text, or null when it is longer than `max` bytes (the rest is never read). */
export async function boundedText(res: Response, max: number): Promise<string | null> {
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** The body parsed as JSON, or null when it is too long or is not JSON. */
export async function boundedJson(res: Response, max: number): Promise<unknown> {
  const text = await boundedText(res, max);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A 3xx answer: not followed, so treated as no answer. */
export const redirected = (res: Response) => res.status >= 300 && res.status < 400;
