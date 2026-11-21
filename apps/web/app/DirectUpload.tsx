'use client';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { waiting } from '../lib/waiting';

/** What a function takes in a request is 4.5 MB (docs/deploy.md); this leaves room for the rest of the form. */
const DIRECT_ABOVE = 4_000_000;
/** How long the site has to give an address, as the build pane's requests. */
const ASK = 15_000;
/** How long the put may go without a byte leaving before it is given up. */
const STALLED = 30_000;

/** An error whose message is meant for the person, in the page's words. */
class Said extends Error {}

/** Put a file at an address in the store, saying how many bytes have gone. Sets no header. */
function put(url: string, file: File, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const failed = () =>
      reject(new Said('The file did not reach the store. Check your connection and try again.'));
    let timer = setTimeout(() => xhr.abort(), STALLED);
    const settle = (end: () => void) => {
      clearTimeout(timer);
      end();
    };
    xhr.upload.onprogress = (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => xhr.abort(), STALLED);
      onProgress(e.loaded);
    };
    xhr.onload = () => settle(xhr.status >= 200 && xhr.status < 300 ? resolve : failed);
    xhr.onerror = () => settle(failed);
    xhr.onabort = () => settle(failed);
    xhr.open('PUT', url);
    xhr.send(file);
  });
}

/**
 * A form that posts a file. A large file does not go to this site: a function on Vercel takes no
 * more than 4.5 MB in a request. The browser asks this site for an address in the store, puts
 * the file there, and posts the form without the file, with the key it was put under. A file of
 * 4 MB or less, or any file in a browser without scripts, is posted with the form.
 *
 * While a large file goes, the page says which file and how far it has got, and gives it up if no
 * byte leaves for 30 s. A message for the person is a `Said`; any other failure gets a general one.
 * Once the form is posted, the waiting line (lib/waiting.ts) takes over until the next page is
 * drawn, for a small file as well.
 */
export default function DirectUpload(props: {
  action: string;
  /** What is being uploaded: a ZIP to import, or a file for a paper. */
  kind: 'zip' | 'file';
  projectId?: string;
  /** The name of the form's file field. */
  field: string;
  children: ReactNode;
}) {
  const [problem, setProblem] = useState('');
  const [sending, setSending] = useState<{ name: string; done: number; of: number } | null>(null);
  const held = useRef<(() => void) | null>(null);
  /** What the post added to the form: the file field it disabled and the fields it appended. */
  const posted = useRef<{ input: HTMLInputElement; added: HTMLInputElement[] } | null>(null);
  const hold = () => {
    held.current ??= waiting();
  };
  // A page restored from the back/forward cache, or a failed upload (which dispatches this
  // itself), is not waiting any more, and its form is as it was before the post.
  useEffect(() => {
    const release = () => {
      held.current?.();
      held.current = null;
      setSending(null);
      if (posted.current) {
        posted.current.input.disabled = false;
        for (const h of posted.current.added) h.remove();
        posted.current = null;
      }
    };
    window.addEventListener('pageshow', release);
    return () => window.removeEventListener('pageshow', release);
  }, []);
  return (
    <form
      method="post"
      action={props.action}
      encType="multipart/form-data"
      onSubmit={async (event) => {
        const form = event.currentTarget;
        const input = form.elements.namedItem(props.field) as HTMLInputElement;
        const file = input.files?.[0];
        // No file: a blank text file, or the browser's own "choose a file" message. A small file
        // is posted with the form, as it always was, in one step. Only one that a function
        // could not take (4.5 MB, with the form's own few bytes) goes by way of the store.
        if (!file || file.size <= DIRECT_ABOVE) {
          hold(); // the browser posts it; the waiting line speaks for it
          return;
        }
        event.preventDefault();
        setProblem('');
        setSending({ name: file.name, done: 0, of: file.size });
        try {
          const asked = await fetch('/api/uploads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: props.kind, projectId: props.projectId, size: file.size }),
            signal: AbortSignal.timeout(ASK),
          }).catch(() => null);
          if (!asked)
            throw new Said('The server did not answer, so nothing was uploaded. Try again.');
          if (!asked.ok)
            throw new Said(
              ((await asked.json().catch(() => null)) as { error?: string } | null)?.error ??
                'The upload could not be started.',
            );
          const { key, url } = (await asked.json()) as { key: string; url: string };
          await put(url, file, (done) => setSending((s) => s && { ...s, done }));
          setSending((s) => s && { ...s, done: s.of });
          const hidden = (name: string, value: string) => {
            const h = document.createElement('input');
            h.type = 'hidden';
            h.name = name;
            h.value = value;
            form.append(h);
            return h;
          };
          posted.current = { input, added: [hidden('key', key), hidden('name', file.name)] };
          input.disabled = true; // a disabled field is not posted
          hold();
          form.submit(); // does not run this handler again
        } catch (err) {
          setSending(null);
          setProblem(err instanceof Said ? err.message : 'The upload failed. Try again.');
          // The button that sends a form once is free again.
          window.dispatchEvent(new Event('pageshow'));
        }
      }}
    >
      {props.children}
      <p aria-live="polite">
        {sending &&
          (sending.done === sending.of
            ? `${sending.name} is uploaded. Waiting for the server to take it.`
            : `Uploading ${sending.name} (${(sending.of / 1e6).toFixed(1)} MB). Keep this page open.`)}
      </p>
      {sending && <progress aria-label="Uploaded so far" max={sending.of} value={sending.done} />}
      {problem && <p role="alert">{problem}</p>}
    </form>
  );
}
