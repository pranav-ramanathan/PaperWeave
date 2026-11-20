'use client';
import { type ReactNode, useState } from 'react';

/** What a function takes in a request is 4.5 MB (docs/deploy.md); this leaves room for the rest of the form. */
const DIRECT_ABOVE = 4_000_000;

/**
 * A form that posts a file. A large file does not go to this site: a function on Vercel takes no
 * more than 4.5 MB in a request. The browser asks this site for an address in the store, puts
 * the file there, and posts the form without the file, with the key it was put under. A file of
 * 4 MB or less, or any file in a browser without scripts, is posted with the form.
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
        if (!file || file.size <= DIRECT_ABOVE) return;
        event.preventDefault();
        setProblem('');
        try {
          const asked = await fetch('/api/uploads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: props.kind, projectId: props.projectId, size: file.size }),
          });
          if (!asked.ok)
            throw new Error(
              ((await asked.json().catch(() => null)) as { error?: string } | null)?.error ??
                'The upload could not be started.',
            );
          const { key, url } = (await asked.json()) as { key: string; url: string };
          const put = await fetch(url, { method: 'PUT', body: file });
          if (!put.ok) throw new Error('The file did not reach the store. Try again.');
          const hidden = (name: string, value: string) => {
            const h = document.createElement('input');
            h.type = 'hidden';
            h.name = name;
            h.value = value;
            form.append(h);
          };
          hidden('key', key);
          hidden('name', file.name);
          input.disabled = true; // a disabled field is not posted
          form.submit(); // does not run this handler again
        } catch (err) {
          setProblem(err instanceof Error ? err.message : 'The upload failed.');
          // The button that sends a form once is free again.
          window.dispatchEvent(new Event('pageshow'));
        }
      }}
    >
      {props.children}
      {problem && <p role="alert">{problem}</p>}
    </form>
  );
}
