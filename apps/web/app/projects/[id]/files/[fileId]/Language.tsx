'use client';

import type { LanguageFinding } from '@paperweave/server';
import { useCallback, useEffect, useRef, useState } from 'react';

const KIND = { spelling: 'Spelling', grammar: 'Grammar', style: 'Style' } as const;

/**
 * Spelling and grammar in a file's prose. Checked when the file opens and again each time what
 * was typed has been saved and left alone for a moment.
 */
export default function Language(props: {
  projectId: string;
  fileId: string;
  /** May edit: a suggestion is made at once. */
  canWrite: boolean;
  /** May comment but not edit: a suggestion becomes a proposed change. */
  canPropose: boolean;
  /** Whether something typed is still on its way to the server. */
  unsaved: boolean;
  /** Replace a stretch with other words, if it still says what it said. */
  change(from: string, to: string, expected: string, replacement: string): Promise<boolean>;
  show(from: string, to: string): boolean;
  /** Told the findings each time they are read, so that the editor can mark them in the text. */
  onFindings(findings: LanguageFinding[]): void;
}) {
  const { projectId, fileId, canWrite, canPropose, unsaved } = props;
  const [findings, setFindings] = useState<LanguageFinding[] | null>(null);
  const [note, setNote] = useState('');
  const [off, setOff] = useState('');
  const told = useRef(props.onFindings);
  told.current = props.onFindings;
  const url = `/projects/${projectId}/grammar`;

  const check = useCallback(async () => {
    // A little over the server's own 20 seconds for the checker.
    const res = await fetch(`${url}?file=${fileId}`, { signal: AbortSignal.timeout(25_000) }).catch(
      () => null,
    );
    // No answer at all (offline for a moment, or too slow): say so, and keep what was found.
    if (!res) return setOff('The spelling and grammar checker did not answer.');
    if (res.status === 503) {
      // No checker: say so once, and show nothing as if it were clean.
      setOff(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? '');
      setFindings(null);
      return told.current([]);
    }
    if (!res.ok) return;
    const found: LanguageFinding[] = await res.json();
    setOff('');
    setFindings(found);
    told.current(found);
  }, [url, fileId]);
  // Once what was typed is saved and nothing more has come for a moment, look again.
  useEffect(() => {
    if (unsaved) return;
    const timer = setTimeout(check, 1500);
    return () => clearTimeout(timer);
  }, [unsaved, check]);

  /** Take a finding off the list at once; the next check will agree or put it back. */
  const drop = (gone: (f: LanguageFinding) => boolean) =>
    setFindings((now) => {
      const left = (now ?? []).filter((f) => !gone(f));
      told.current(left);
      return left;
    });
  const post = async (to: string, body: object) => {
    const res = await fetch(to, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    return res?.ok
      ? null
      : (((await res?.json().catch(() => null)) as { error?: string } | null)?.error ??
          'That could not be sent. Check the connection and try again.');
  };
  const use = async (f: LanguageFinding, replacement: string) => {
    if (canWrite) {
      const done = await props.change(f.from, f.to, f.words, replacement);
      if (done) drop((x) => x === f);
      return setNote(done ? '' : 'That text has changed. It will be checked again in a moment.');
    }
    const wrong = await post(`/projects/${projectId}/proposals`, {
      file: fileId,
      from: f.from,
      to: f.to,
      replacement,
      reason: f.message,
    });
    if (!wrong) drop((x) => x === f);
    setNote(wrong ?? `Proposed changing “${f.words}” to “${replacement}”.`);
  };

  return (
    <section className="threads" id="language" aria-label="Spelling and grammar">
      <h2>Spelling and grammar</h2>
      {off && <p className="note">{off}</p>}
      <p className="note" aria-live="polite">
        {note}
      </p>
      {findings && findings.length === 0 && <p>Nothing found in this file.</p>}
      <ul>
        {findings?.map((f, i) => (
          <li key={`${f.from}:${f.rule}:${i}`}>
            <article aria-label={`${KIND[f.kind]}: “${f.words}”`}>
              <p>
                <strong>{KIND[f.kind]}.</strong> <q>{f.words}</q>: {f.message}
              </p>
              <p>
                {(canWrite || canPropose) &&
                  f.replacements.slice(0, 3).map((r) => (
                    <button key={r} type="button" onClick={() => use(f, r)}>
                      {canWrite ? 'Change to' : 'Propose'} “{r}”
                    </button>
                  ))}
                <button
                  type="button"
                  onClick={() =>
                    setNote(props.show(f.from, f.to) ? '' : 'That text is no longer in the file.')
                  }
                >
                  Show in the text
                </button>
                {canWrite && f.kind === 'spelling' && f.addable && (
                  <button
                    type="button"
                    onClick={async () => {
                      const wrong = await post(url, { word: f.words });
                      if (!wrong) drop((x) => x.kind === 'spelling' && x.words === f.words);
                      setNote(wrong ?? `“${f.words}” is now one of the paper's own words.`);
                    }}
                  >
                    It is a word of this paper
                  </button>
                )}
                {canWrite && f.kind !== 'spelling' && (
                  <button
                    type="button"
                    onClick={async () => {
                      const wrong = await post(url, { rule: f.rule });
                      if (!wrong) drop((x) => x.rule === f.rule);
                      setNote(
                        wrong ??
                          'That rule is off for this paper. It can be switched on again on the paper’s page.',
                      );
                    }}
                  >
                    Do not check this in this paper
                  </button>
                )}
              </p>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
