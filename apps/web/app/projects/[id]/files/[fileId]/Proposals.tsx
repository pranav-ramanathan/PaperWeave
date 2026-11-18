'use client';

import type { Proposal } from '@paperweave/server';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Stretch } from './Threads';

const day = (iso: string) => iso.slice(0, 10);
const short = (text: string, n = 40) => (text.length > n ? `${text.slice(0, n)}…` : text);
/** How a stretch of source reads in a sentence about it. */
const named = (text: string) => (text ? `“${short(text)}”` : 'nothing');

/** What to put in place of a stretch, and why. */
function Change(props: {
  was: string;
  start: { replacement: string; reason: string };
  button: string;
  send(replacement: string, reason: string): Promise<string | null>;
  onCancel(): void;
}) {
  const [replacement, setReplacement] = useState(props.start.replacement);
  const [reason, setReason] = useState(props.start.reason);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const wrong = await props.send(replacement, reason);
        setBusy(false);
        setProblem(wrong ?? '');
      }}
    >
      <label>
        {props.was ? 'Replace it with' : 'Text to add at the caret'}
        <textarea
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          rows={3}
          maxLength={20000}
        />
      </label>
      <label>
        Why (optional)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </label>
      {problem && <p role="alert">{problem}</p>}
      <button type="submit" disabled={busy}>
        {props.button}
      </button>
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </form>
  );
}

/**
 * The edits proposed to a file. A proposal is beside the text, not in it: nothing changes until
 * someone who may edit accepts it.
 */
export default function Proposals(props: {
  projectId: string;
  fileId: string;
  canPropose: boolean;
  canDecide: boolean;
  /** The stretch selected in the editor now; with nothing selected, the place of the caret. */
  selection(): Stretch | null;
  show(from: string, to: string): boolean;
  /** Told the proposals each time they are read, so that the editor can mark them in the text. */
  onProposals(proposals: Proposal[]): void;
}) {
  const { projectId, fileId, canPropose, canDecide } = props;
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [starting, setStarting] = useState<Stretch | null>(null);
  const [revising, setRevising] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const url = `/projects/${projectId}/proposals`;
  const told = useRef(props.onProposals);
  told.current = props.onProposals;

  const read = useCallback(async () => {
    const res = await fetch(`${url}?file=${fileId}`).catch(() => null);
    if (!res?.ok) return;
    const found: Proposal[] = await res.json();
    setProposals(found);
    told.current(found);
  }, [url, fileId]);
  useEffect(() => {
    void read();
    const timer = setInterval(read, 5000);
    return () => clearInterval(timer);
  }, [read]);

  /** Post, read the proposals again, and return what went wrong, if anything did. */
  const post = async (to: string, body: object) => {
    const res = await fetch(to, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    const wrong = res?.ok
      ? null
      : (((await res?.json().catch(() => null)) as { error?: string } | null)?.error ??
        'That could not be sent. Check the connection and try again.');
    // Read again either way: a refusal usually means the proposal has moved on.
    await read();
    return wrong;
  };
  const act = async (p: Proposal, action: string) =>
    setNote((await post(`${url}/${p.id}`, { action })) ?? '');

  const one = (p: Proposal) => (
    <li key={p.id}>
      <article aria-label={`Proposal to change ${named(p.expected)}`}>
        <p className="change">
          <span>Now: </span>
          <del>{p.expected || '(nothing: text is added here)'}</del>
        </p>
        <p className="change">
          <span>Proposed: </span>
          <ins>{p.replacement || '(nothing: the text is removed)'}</ins>
        </p>
        {p.reason && <p>Why: {p.reason}</p>}
        <p className="note">
          {p.author ?? 'Someone who has left'}, {day(p.createdAt)}.{' '}
          {p.status === 'accepted' && `Accepted by ${p.decidedBy ?? 'someone who has left'}.`}
          {p.status === 'rejected' && `Rejected by ${p.decidedBy ?? 'someone who has left'}.`}
          {p.status === 'dismissed' && 'Withdrawn by its author.'}
        </p>
        {p.status === 'open' && p.stale && (
          <p className="note">
            <strong>Out of date.</strong> The text has changed since this was proposed. It now
            reads: <q>{p.now || '(nothing)'}</q>. It cannot be accepted as it is.
          </p>
        )}
        {p.status === 'accepted' && p.stale && (
          <p className="note">The accepted text has been changed since.</p>
        )}
        {revising === p.id ? (
          <Change
            was={p.now}
            start={{ replacement: p.replacement, reason: p.reason }}
            button="Save the proposal"
            onCancel={() => setRevising(null)}
            send={async (replacement, reason) => {
              const wrong = await post(`${url}/${p.id}`, { action: 'revise', replacement, reason });
              if (!wrong) setRevising(null);
              return wrong;
            }}
          />
        ) : (
          <p>
            {p.status !== 'rejected' && p.status !== 'dismissed' && (
              <button
                type="button"
                onClick={() =>
                  setNote(props.show(p.from, p.to) ? '' : 'That place is no longer in the file.')
                }
              >
                Show in the text
              </button>
            )}
            {p.status === 'open' && canDecide && (
              <>
                <button type="button" disabled={p.stale} onClick={() => act(p, 'accept')}>
                  Accept
                </button>
                <button type="button" onClick={() => act(p, 'reject')}>
                  Reject
                </button>
              </>
            )}
            {p.status === 'open' && (p.mine || canDecide) && (
              <button type="button" onClick={() => setRevising(p.id)}>
                Change the proposal
              </button>
            )}
            {p.status === 'open' && p.mine && (
              <button type="button" onClick={() => act(p, 'withdraw')}>
                Withdraw
              </button>
            )}
            {p.status === 'accepted' && canDecide && (
              <button type="button" disabled={p.stale} onClick={() => act(p, 'undo')}>
                Undo the accept
              </button>
            )}
          </p>
        )}
      </article>
    </li>
  );
  const open = proposals?.filter((p) => p.status === 'open') ?? [];
  const decided = proposals?.filter((p) => p.status !== 'open') ?? [];
  return (
    <section className="threads" id="proposals" aria-label="Proposed changes">
      <h2>Proposed changes</h2>
      {canPropose && !starting && (
        <button
          type="button"
          onClick={() => {
            const picked = props.selection();
            setStarting(picked);
            setNote(picked ? '' : 'Put the caret in the text, or select some of it, first.');
          }}
        >
          Propose a change here
        </button>
      )}
      {starting && (
        <>
          {starting.words && <blockquote>{short(starting.words, 200)}</blockquote>}
          <Change
            was={starting.words}
            start={{ replacement: starting.words, reason: '' }}
            button="Propose"
            onCancel={() => setStarting(null)}
            send={async (replacement, reason) => {
              const wrong = await post(url, {
                file: fileId,
                from: starting.from,
                to: starting.to,
                replacement,
                reason,
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
      {proposals && open.length === 0 && <p>No open proposals on this file.</p>}
      <ul>{open.map(one)}</ul>
      {decided.length > 0 && (
        <details>
          <summary>Decided ({decided.length})</summary>
          <ul>{decided.map(one)}</ul>
        </details>
      )}
    </section>
  );
}
