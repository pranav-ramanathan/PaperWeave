'use client';

import type { Proposal } from '@paperweave/server';
import { useCallback, useEffect, useRef, useState } from 'react';
import { whenMarked } from '../../../../../lib/builds';
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
  const sending = useRef(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (sending.current) return;
        sending.current = true;
        setBusy(true);
        const wrong = await props.send(replacement, reason).finally(() => {
          sending.current = false;
        });
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
  /** The paper's owner allows passages to be sent to a model for a review. */
  canReview: boolean;
  /** The stretch selected in the editor now; with nothing selected, the place of the caret. */
  selection(): Stretch | null;
  show(from: string, to: string): boolean;
  /** Told the proposals each time they are read, so that the editor can mark them in the text. */
  onProposals(proposals: Proposal[]): void;
}) {
  const { projectId, fileId, canPropose, canDecide, canReview } = props;
  const [reviewing, setReviewing] = useState(false);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [starting, setStarting] = useState<Stretch | null>(null);
  const [revising, setRevising] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const url = `/projects/${projectId}/proposals`;
  const told = useRef(props.onProposals);
  told.current = props.onProposals;

  const read = useCallback(async () => {
    const res = await fetch(`${url}?file=${fileId}`).catch(() => null);
    if (!res?.ok) return false;
    const found: Proposal[] = await res.json();
    setProposals(found);
    told.current(found);
    return true;
  }, [url, fileId]);
  // Read when first shown, and then only when the build pane's poll says the paper's text or its
  // comments and proposals are not what they were, or after this person's own doing. A tab
  // that shows nothing new asks for nothing.
  useEffect(() => whenMarked(read), [read]);

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

  // A proposal someone else decides while this person is part-way through changing it stays
  // where it is, with what they have written, until they put the form away. Moved among the
  // decided ones, the form would start again from the old words, out of sight.
  const held = (p: Proposal) => p.status !== 'open' && revising === p.id;
  // Its words have gone from the file, so there is nowhere left to show, and nothing to change.
  const gone = (p: Proposal) =>
    p.now === '' && (p.status === 'accepted' ? p.replacement : p.expected) !== '';
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
        {p.origin === 'critique' && (
          <p className="note">
            From a model review ({p.madeBy}), asked for by {p.author ?? 'someone who has left'}.
            {p.evidence.length > 0 && ` It rests on: ${p.evidence.join('; ')}.`}
          </p>
        )}
        {p.flags.length > 0 && p.status === 'open' && (
          <div className="flags">
            <strong>This changes more than the wording. Check before accepting:</strong>
            <ul>
              {p.flags.map((flag) => (
                <li key={flag}>{flag}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="note">
          {p.author ?? 'Someone who has left'}, {day(p.createdAt)}.{' '}
          {p.status === 'accepted' && (p.decidedBy ? `Accepted by ${p.decidedBy}.` : 'Accepted.')}
          {p.status === 'rejected' && (p.decidedBy ? `Rejected by ${p.decidedBy}.` : 'Rejected.')}
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
        {held(p) && (
          <p className="note" role="status">
            <strong>
              This proposal was {p.status === 'dismissed' ? 'withdrawn' : p.status} while you were
              changing it.
            </strong>{' '}
            It can no longer be changed. What you wrote is still below, to copy if you want it.
          </p>
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
                  setNote(
                    gone(p)
                      ? 'Those words are no longer in the file.'
                      : props.show(p.from, p.to)
                        ? ''
                        : 'That place is no longer in the file.',
                  )
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
            {gone(p) &&
              (p.status === 'open' || p.status === 'accepted') &&
              (p.mine || canDecide) && (
                <button type="button" onClick={() => act(p, 'attach')}>
                  Find these words again
                </button>
              )}
            {p.status === 'open' && !gone(p) && (p.mine || canDecide) && (
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
  const open = proposals?.filter((p) => p.status === 'open' || held(p)) ?? [];
  const decided = proposals?.filter((p) => p.status !== 'open' && !held(p)) ?? [];
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
      {canPropose && canReview && !starting && (
        <button
          type="button"
          disabled={reviewing}
          onClick={async () => {
            const picked = props.selection();
            if (!picked?.words) return setNote('Select the passage to review first.');
            setReviewing(true);
            setNote('Asking the model. This can take a minute…');
            const res = await fetch(`/projects/${projectId}/review`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ file: fileId, from: picked.from, to: picked.to }),
            }).catch(() => null);
            const answer = (await res?.json().catch(() => null)) as {
              error?: string;
              proposed?: number;
              asked?: number;
            } | null;
            setReviewing(false);
            await read();
            setNote(
              res?.ok && answer
                ? `The review proposed ${answer.proposed} ${answer.proposed === 1 ? 'change' : 'changes'} and asked ${answer.asked} ${answer.asked === 1 ? 'question' : 'questions'}. Nothing has been changed.`
                : (answer?.error ?? 'The review could not be asked for. Try again.'),
            );
          }}
        >
          Ask a model to review the selected text
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
