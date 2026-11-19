'use client';

import type { Thread } from '@paperweave/server';
import { useCallback, useEffect, useRef, useState } from 'react';
import { whileShown } from '../../../../../lib/shown';

export type Member = { userId: string; email: string };
/** A stretch of the file as the editor holds it: its two ends, and the words between them. */
export type Stretch = { from: string; to: string; words: string };

const day = (iso: string) => iso.slice(0, 10);
const short = (text: string, n = 120) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** Something to say, and who to say it to. */
function Say(props: {
  label: string;
  button: string;
  members: Member[];
  send(body: string, mentions: string[]): Promise<string | null>;
  onCancel?(): void;
  /** Told whether something is written here and not yet sent. */
  onDraft?(written: boolean): void;
}) {
  const [body, setBody] = useState('');
  const [to, setTo] = useState<string[]>([]);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  // The people who can be mentioned are listed once someone starts on the form, not before.
  // Every open thread has a form for replying, so listing them at once drew a box for each
  // person under each thread: 2,900 of them for thirty people and a hundred threads.
  const [begun, setBegun] = useState(false);
  return (
    <form
      onFocus={() => setBegun(true)}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const wrong = await props.send(body, to);
        setBusy(false);
        setProblem(wrong ?? '');
        if (wrong) return;
        setBody('');
        setTo([]);
        setBegun(false);
        props.onDraft?.(false);
      }}
    >
      <label>
        {props.label}
        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            props.onDraft?.(e.target.value !== '');
          }}
          rows={2}
          maxLength={5000}
          required
        />
      </label>
      {begun && props.members.length > 0 && (
        <fieldset>
          <legend>Mention</legend>
          {props.members.map((m) => (
            <label key={m.userId}>
              <input
                type="checkbox"
                checked={to.includes(m.userId)}
                onChange={(e) =>
                  setTo(e.target.checked ? [...to, m.userId] : to.filter((x) => x !== m.userId))
                }
              />{' '}
              {m.email}
            </label>
          ))}
        </fieldset>
      )}
      {problem && <p role="alert">{problem}</p>}
      <button type="submit" disabled={busy}>
        {props.button}
      </button>
      {props.onCancel && (
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      )}
    </form>
  );
}

/**
 * The comments on a file: threads about stretches of its text. Read again every few seconds, so
 * that what others write appears without asking.
 */
export default function Threads(props: {
  projectId: string;
  fileId: string;
  canComment: boolean;
  /** The other people on the paper, who can be mentioned. */
  members: Member[];
  /** The stretch selected in the editor now, or null if nothing is. */
  selection(): Stretch | null;
  /** Select a stretch in the editor. False if it is no longer there. */
  show(from: string, to: string): boolean;
  /** Told the threads each time they are read, so that the editor can mark them in the text. */
  onThreads(threads: Thread[]): void;
}) {
  const { projectId, fileId, canComment, members } = props;
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [starting, setStarting] = useState<Stretch | null>(null);
  const [note, setNote] = useState('');
  /** The threads this person has a reply written to and not yet sent. */
  const [drafts, setDrafts] = useState<string[]>([]);
  const url = `/projects/${projectId}/threads`;
  const told = useRef(props.onThreads);
  told.current = props.onThreads;

  const read = useCallback(async () => {
    const res = await fetch(`${url}?file=${fileId}`).catch(() => null);
    if (!res?.ok) return;
    const found: Thread[] = await res.json();
    setThreads(found);
    told.current(found);
  }, [url, fileId]);
  useEffect(() => whileShown(() => void read(), 5000), [read]);

  /** Post, read the threads again, and return what went wrong, if anything did. */
  const post = async (to: string, body: object) => {
    const res = await fetch(to, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok)
      return (
        ((await res?.json().catch(() => null)) as { error?: string } | null)?.error ??
        'That could not be sent. Check the connection and try again.'
      );
    await read();
    return null;
  };

  // A thread someone else resolves while this person is part-way through a reply to it stays
  // where it is until the reply is sent or rubbed out. Moved among the resolved ones, its
  // form would go, and what was written in it would go too, without a word.
  const held = (t: Thread) => t.status === 'resolved' && drafts.includes(t.id);
  const one = (t: Thread) => (
    <li key={t.id}>
      <article aria-label={`Thread on “${short(t.excerpt, 40)}”`}>
        <blockquote>{short(t.excerpt)}</blockquote>
        {t.state === 'changed' && (
          <p className="note">
            Changed since. It now reads: <q>{short(t.now)}</q>
          </p>
        )}
        {t.state === 'detached' && (
          <p className="note">
            <strong>This text has been deleted.</strong> It stood in: …{t.before.slice(-60)}
            <mark>{short(t.excerpt, 60)}</mark>
            {t.after.slice(0, 60)}…
          </p>
        )}
        <ol>
          {t.comments.map((c) => (
            <li key={c.id}>
              <strong>{c.author ?? 'Someone who has left'}</strong>{' '}
              <time dateTime={c.createdAt}>{day(c.createdAt)}</time>
              {c.mentions.length > 0 && <span className="note"> to {c.mentions.join(', ')}</span>}
              <p>{c.body}</p>
            </li>
          ))}
        </ol>
        <p>
          {t.state !== 'detached' && (
            <button
              type="button"
              onClick={() =>
                setNote(props.show(t.from, t.to) ? '' : 'That text is no longer in the file.')
              }
            >
              Show in the text
            </button>
          )}
          {canComment && t.state === 'detached' && (
            <button
              type="button"
              onClick={async () => setNote((await post(`${url}/${t.id}`, { attach: true })) ?? '')}
            >
              Attach to the same words again
            </button>
          )}
          {canComment && (
            <button
              type="button"
              onClick={async () =>
                setNote(
                  (await post(`${url}/${t.id}`, {
                    status: t.status === 'open' ? 'resolved' : 'open',
                  })) ?? '',
                )
              }
            >
              {t.status === 'open' ? 'Resolve' : 'Open again'}
            </button>
          )}
        </p>
        {held(t) && (
          <p className="note" role="status">
            <strong>This thread was resolved while you were writing.</strong> Your reply can still
            be sent.
          </p>
        )}
        {canComment && (t.status === 'open' || held(t)) && (
          <Say
            label={`Reply about “${short(t.excerpt, 40)}”`}
            button="Reply"
            members={members}
            send={(body, mentions) => post(`${url}/${t.id}`, { body, mentions })}
            onDraft={(written) =>
              setDrafts((now) =>
                written === now.includes(t.id)
                  ? now
                  : written
                    ? [...now, t.id]
                    : now.filter((id) => id !== t.id),
              )
            }
          />
        )}
      </article>
    </li>
  );
  const open = threads?.filter((t) => t.status === 'open' || held(t)) ?? [];
  const resolved = threads?.filter((t) => t.status === 'resolved' && !held(t)) ?? [];
  return (
    <section className="threads" id="comments" aria-label="Comments">
      <h2>Comments</h2>
      {canComment && !starting && (
        <button
          type="button"
          onClick={() => {
            const picked = props.selection();
            setStarting(picked);
            setNote(picked ? '' : 'Select the text the comment is about first.');
          }}
        >
          Comment on the selected text
        </button>
      )}
      {starting && (
        <>
          <blockquote>{short(starting.words)}</blockquote>
          <Say
            label="Comment"
            button="Start thread"
            members={members}
            onCancel={() => setStarting(null)}
            send={async (body, mentions) => {
              const wrong = await post(url, {
                file: fileId,
                from: starting.from,
                to: starting.to,
                body,
                mentions,
              });
              if (!wrong) setStarting(null);
              return wrong;
            }}
          />
        </>
      )}
      <p className="note" aria-live="polite">
        {note}
      </p>
      {threads && open.length === 0 && <p>No open threads on this file.</p>}
      <ul>{open.map(one)}</ul>
      {resolved.length > 0 && (
        <details>
          <summary>Resolved ({resolved.length})</summary>
          <ul>{resolved.map(one)}</ul>
        </details>
      )}
    </section>
  );
}
