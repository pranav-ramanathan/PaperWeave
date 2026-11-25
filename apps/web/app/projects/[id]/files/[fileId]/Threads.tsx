'use client';

import type { Thread } from '@paperweave/server';
import { useCallback, useEffect, useRef, useState } from 'react';
import { whenMarked } from '../../../../../lib/builds';

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
  /** Words to start from, when a comment is being changed. */
  initial?: string;
  send(body: string, mentions: string[]): Promise<string | null>;
  onCancel?(): void;
  /** Told whether something is written here and not yet sent. */
  onDraft?(written: boolean): void;
  /** Take the keyboard when the form appears (a form the person has just asked for). */
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState(props.initial ?? '');
  const [to, setTo] = useState<string[]>([]);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // The people who can be mentioned are listed once someone starts on the form, not before.
  // Every open thread has a form for replying, so listing them at once drew a box for each
  // person under each thread: 2,900 of them for thirty people and a hundred threads.
  const [begun, setBegun] = useState(false);
  return (
    <form
      onFocus={() => setBegun(true)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (sending.current) return;
        sending.current = true;
        setBusy(true);
        const wrong = await props.send(body, to).finally(() => {
          sending.current = false;
        });
        setBusy(false);
        setProblem(wrong ?? '');
        if (wrong) return;
        setBody(props.initial ?? '');
        setTo([]);
        // The list of people goes with the form being reset: if the keyboard was in it, it
        // goes to the text box first. (Focusing it asks for the list; closing it comes last.)
        if (document.activeElement?.closest('fieldset')) box.current?.focus();
        setBegun(false);
        props.onDraft?.(false);
      }}
    >
      <label>
        {props.label}
        <textarea
          ref={box}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            props.onDraft?.(e.target.value !== '');
          }}
          rows={2}
          maxLength={5000}
          required
          autoFocus={props.autoFocus ?? props.initial !== undefined}
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
      <button type="submit" aria-disabled={busy || undefined}>
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
  show(from: string, to: string): Promise<boolean>;
  /** Where a stretch stands in the editor's text now, or null if nothing is there. */
  standing(from: string, to: string): Stretch | null;
  /** Told the threads each time they are read, so that the editor can mark them in the text. */
  onThreads(threads: Thread[]): void;
}) {
  const { projectId, fileId, canComment, members } = props;
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [starting, setStarting] = useState<Stretch | null>(null);
  const [note, setNote] = useState('');
  /** The threads this person has a reply written to and not yet sent. */
  const [drafts, setDrafts] = useState<string[]>([]);
  /** The thread the address names (?thread=), as an email's link does. */
  const [named, setNamed] = useState<string | null>(null);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  /** The comment this person is changing, and the one they were asked whether to delete. */
  const [editing, setEditing] = useState<{ thread: string; comment: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const found = useRef(false);
  /** The heading and the button that starts a thread: where the keyboard goes when what it was on is gone. */
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasStarting = useRef(false);
  const [moved, setMoved] = useState(0);
  const section = useRef<HTMLElement>(null);
  const was = useRef<{ editing: string | null; removing: string | null }>({
    editing: null,
    removing: null,
  });
  // Change and Delete are replaced by what they open. The keyboard goes to the question, and
  // back to the button when the form or the question closes (or to the heading, if the comment is gone).
  useEffect(() => {
    const before = was.current;
    was.current = { editing: editing?.comment ?? null, removing };
    const go = (selector: string) =>
      (section.current?.querySelector<HTMLElement>(selector) ?? heading.current)?.focus();
    if (removing && !before.removing) go(`[data-ask="${removing}"]`);
    else if (!removing && before.removing && document.activeElement === document.body)
      go(`[data-delete="${before.removing}"]`);
    if (!editing && before.editing && document.activeElement === document.body)
      go(`[data-change="${before.editing}"]`);
  }, [editing, removing]);
  // A thread that was decided has moved to the other list, and the button the keyboard was on with it.
  useEffect(() => {
    if (moved && document.activeElement === document.body) heading.current?.focus();
  }, [moved]);
  // The form for a new thread takes the button's place, and the button comes back when it closes.
  useEffect(() => {
    if (wasStarting.current && !starting) opener.current?.focus();
    wasStarting.current = !!starting;
  }, [starting]);
  useEffect(() => {
    setNamed(new URLSearchParams(location.search).get('thread'));
  }, []);
  const url = `/projects/${projectId}/threads`;
  const told = useRef(props.onThreads);
  told.current = props.onThreads;

  const standingNow = useRef(props.standing);
  standingNow.current = props.standing;
  const read = useCallback(async () => {
    const get = async () => {
      const res = await fetch(`${url}?file=${fileId}`).catch(() => null);
      return res?.ok ? ((await res.json()) as Thread[]) : null;
    };
    let found = await get();
    if (!found) return false;
    // After an undo, the words of a detached thread are written again as new characters. This
    // tab knows where they stand, and tells the server, which checks them. A refusal (not saved
    // yet, or not the same words) is silent: it is tried again at the next read.
    if (canComment) {
      const tried = await Promise.all(
        found
          .filter((t) => t.state === 'detached')
          .flatMap((t) => {
            const now = standingNow.current(t.from, t.to);
            return now ? [{ id: t.id, from: now.from, to: now.to }] : [];
          })
          .map(({ id, from, to }) =>
            fetch(`${url}/${id}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ attach: true, from, to }),
            })
              .then((r) => r.ok)
              .catch(() => false),
          ),
      );
      if (tried.some(Boolean)) found = (await get()) ?? found;
    }
    setThreads(found);
    told.current(found);
    return true;
  }, [url, fileId, canComment]);
  // Read when first shown, and then only when the build pane's poll says the paper's text or its
  // comments and proposals are not what they were, or after this person's own doing. A tab
  // that shows nothing new asks for nothing.
  useEffect(() => whenMarked(read), [read]);

  /** Post, read the threads again, and return what went wrong, if anything did. */
  const post = async (to: string, body: object, said = '') => {
    const res = await fetch(to, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    const answer = (await res?.json().catch(() => null)) as {
      error?: string;
      note?: string;
    } | null;
    if (!res?.ok)
      return answer?.error ?? 'That could not be sent. Check the connection and try again.';
    // What the server has to say about a comment that was saved (the limit on emails).
    setNote(answer?.note || said);
    await read();
    return null;
  };

  // Once the threads are read: the one the address names is opened (if resolved), scrolled
  // into view and marked, or the person is told it is gone. Done once.
  useEffect(() => {
    if (!named || !threads || found.current) return;
    const t = threads.find((x) => x.id === named);
    if (!t) {
      found.current = true;
      setNote('The comment this link was about is no longer here.');
    } else if (t.status === 'resolved' && !resolvedOpen) setResolvedOpen(true);
    else {
      found.current = true;
      document.getElementById(`thread-${named}`)?.scrollIntoView({ block: 'center' });
    }
  }, [named, threads, resolvedOpen]);

  // A comment deleted while this person was changing it: the form goes, and they are told.
  useEffect(() => {
    if (!editing || !threads) return;
    if (!threads.some((t) => t.comments.some((c) => c.id === editing.comment))) {
      setEditing(null);
      setNote('The comment you were changing has been deleted.');
    }
  }, [editing, threads]);

  // A thread someone else resolves while this person is part-way through a reply to it stays
  // where it is until the reply is sent or rubbed out. Moved among the resolved ones, its
  // form would go, and what was written in it would go too, without a word.
  const held = (t: Thread) =>
    t.status === 'resolved' && (drafts.includes(t.id) || editing?.thread === t.id);
  const one = (t: Thread) => (
    <li key={t.id}>
      <article
        id={`thread-${t.id}`}
        aria-label={`Thread on “${short(t.excerpt, 40)}”`}
        aria-current={t.id === named ? 'true' : undefined}
      >
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
              {c.editedAt && <span className="note"> (changed)</span>}
              {c.mentions.length > 0 && <span className="note"> to {c.mentions.join(', ')}</span>}
              {editing?.comment === c.id ? (
                <Say
                  label="Your comment"
                  button="Save"
                  initial={c.body}
                  members={[]}
                  onCancel={() => setEditing(null)}
                  send={async (body) => {
                    const wrong = await post(
                      `${url}/${t.id}`,
                      { comment: c.id, body },
                      'Comment changed.',
                    );
                    if (!wrong) setEditing(null);
                    return wrong;
                  }}
                />
              ) : (
                <p>{c.body}</p>
              )}
              {canComment && c.yours && editing?.comment !== c.id && (
                <button
                  type="button"
                  data-change={c.id}
                  onClick={() => setEditing({ thread: t.id, comment: c.id })}
                >
                  Change
                </button>
              )}
              {c.removable && removing !== c.id && (
                <button type="button" data-delete={c.id} onClick={() => setRemoving(c.id)}>
                  Delete
                </button>
              )}
              {c.removable && removing === c.id && (
                <span role="group" aria-label="Delete this comment?" data-ask={c.id} tabIndex={-1}>
                  Delete this comment for everyone?{' '}
                  <button
                    type="button"
                    onClick={async () => {
                      const wrong = await post(
                        `${url}/${t.id}`,
                        { comment: c.id, delete: true },
                        'Comment deleted.',
                      );
                      setRemoving(null);
                      if (wrong) setNote(wrong);
                    }}
                  >
                    Delete it
                  </button>
                  <button type="button" onClick={() => setRemoving(null)}>
                    Keep it
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
        <p>
          {t.state !== 'detached' && (
            <button
              type="button"
              onClick={async () =>
                setNote(
                  (await props.show(t.from, t.to)) ? '' : 'That text is no longer in the file.',
                )
              }
            >
              Show in the text
            </button>
          )}
          {canComment && t.state === 'detached' && (
            <button
              type="button"
              onClick={async () => {
                const wrong = await post(`${url}/${t.id}`, { attach: true });
                if (wrong) return setNote(wrong);
                // The button is gone once the words are found: say so, and keep the keyboard in the comments.
                setNote('The words were found again.');
                setMoved((n) => n + 1);
              }}
            >
              Attach to the same words again
            </button>
          )}
          {canComment && (
            <button
              type="button"
              onClick={async () => {
                const resolving = t.status === 'open';
                const wrong = await post(
                  `${url}/${t.id}`,
                  resolving ? { status: 'resolved', seen: t.mark } : { status: 'open' },
                );
                if (wrong) {
                  // Shown again as it now reads, and the person told why it was not resolved.
                  await read();
                  return setNote(wrong);
                }
                setNote(resolving ? 'Thread resolved.' : 'Thread opened again.');
                setMoved((n) => n + 1);
              }}
            >
              {t.status === 'open' ? 'Resolve' : 'Open again'}
            </button>
          )}
        </p>
        {held(t) && (
          <p className="note" role="status">
            {drafts.includes(t.id) ? (
              <>
                <strong>This thread was resolved while you were writing.</strong> Your reply can
                still be sent.
              </>
            ) : (
              <>
                <strong>This thread was resolved while you were changing a comment.</strong> What
                you wrote can still be saved.
              </>
            )}
          </p>
        )}
        {canComment && (t.status === 'open' || held(t)) && (
          <Say
            label={`Reply about “${short(t.excerpt, 40)}”`}
            button="Reply"
            members={members}
            send={(body, mentions) => post(`${url}/${t.id}`, { body, mentions }, 'Reply sent.')}
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
    <section className="threads" id="comments" aria-label="Comments" ref={section}>
      <h2 ref={heading} tabIndex={-1}>
        Comments
      </h2>
      {canComment && !starting && (
        <button
          type="button"
          ref={opener}
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
            autoFocus
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
        <details open={resolvedOpen} onToggle={(e) => setResolvedOpen(e.currentTarget.open)}>
          <summary>Resolved ({resolved.length})</summary>
          <ul>{resolved.map(one)}</ul>
        </details>
      )}
    </section>
  );
}
