'use client';

import type { Build } from '@paperweave/server';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Numbers, setNumbers } from '../../../../../lib/numbers';

type Builds = { latest: Build | null; lastGood: Build | null; edits: number };

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function BuildPane({
  projectId,
  canBuild,
}: {
  projectId: string;
  canBuild: boolean;
}) {
  const [builds, setBuilds] = useState<Builds | null>(null);
  const [auto, setAuto] = useState(true);
  const [problem, setProblem] = useState('');
  const url = `/projects/${projectId}/builds`;
  // How far edits had got at the last poll, to see that typing has paused.
  const seen = useRef<number | null>(null);

  const compile = useCallback(async () => {
    const res = await fetch(url, { method: 'POST' });
    setProblem(
      res.ok
        ? ''
        : ((await res.json().catch(() => ({}))).error ?? 'The build could not be started.'),
    );
  }, [url]);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      const res = await fetch(url).catch(() => null);
      if (stop || !res?.ok) return;
      const next: Builds = await res.json();
      setBuilds(next);
      // Build by itself once the text has been still for one poll and differs from what was built.
      const idle = seen.current === next.edits;
      seen.current = next.edits;
      const behind = !next.latest || (next.latest.status !== 'queued' && next.latest.stale);
      if (auto && canBuild && idle && behind) void compile();
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [url, auto, canBuild, compile]);

  const { latest, lastGood } = builds ?? { latest: null, lastGood: null };
  // The visual editor shows, beside each reference, the number its label has in this PDF.
  const pdf = lastGood?.id;
  const behind = !!lastGood && (lastGood.id !== latest?.id || lastGood.stale);
  const [found, setFound] = useState<{ pdf: string; labels: Numbers['labels'] } | null>(null);
  useEffect(() => {
    if (!pdf) return;
    let stop = false;
    void fetch(`${url}/${pdf}/labels`)
      .then((res) => (res.ok ? res.json() : {}))
      .then((labels: Numbers['labels']) => !stop && setFound({ pdf, labels }))
      .catch(() => {});
    return () => void (stop = true);
  }, [url, pdf]);
  useEffect(() => {
    if (found && found.pdf === pdf)
      setNumbers({ labels: found.labels, known: true, stale: behind });
  }, [found, pdf, behind]);
  useEffect(() => () => setNumbers({ labels: {}, known: false, stale: false }), []);
  const building = latest?.status === 'queued';
  const state = !builds
    ? 'Checking for a PDF…'
    : building
      ? 'Compiling…'
      : !latest
        ? 'Not compiled yet.'
        : latest.status === 'failed'
          ? latest.timedOut
            ? 'The latest build ran out of time.'
            : 'The latest build failed.'
          : latest.stale
            ? 'The PDF is behind the text.'
            : 'The PDF is up to date.';
  const errors =
    latest?.status === 'failed' ? latest.diagnostics.filter((d) => d.severity === 'error') : [];
  return (
    <section className="build" aria-label="Compiled PDF">
      <div className="editor-bar">
        <span role="status" aria-live="polite">
          {state}
        </span>
        {canBuild && (
          <>
            <button type="button" onClick={compile} disabled={building}>
              Compile now
            </button>
            <label>
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />{' '}
              Compile automatically
            </label>
          </>
        )}
      </div>
      {problem && <p role="alert">{problem}</p>}
      {errors.length > 0 && (
        <ul className="diagnostics" aria-label="Build errors">
          {errors.map((d, i) => (
            <li key={i}>
              <code>
                {d.file}
                {d.line ? `:${d.line}` : ''}
              </code>{' '}
              {d.message}
            </li>
          ))}
        </ul>
      )}
      {latest && latest.status !== 'queued' && (
        <p className="build-links">
          <a href={`${url}/${latest.id}/log`} target="_blank" rel="noreferrer">
            Build log
          </a>
        </p>
      )}
      {lastGood ? (
        <>
          <p className="build-links">
            Showing the PDF built at {time(lastGood.createdAt)}
            {behind ? ', before the latest edits.' : '.'}
          </p>
          <iframe title="Compiled PDF" src={`${url}/${lastGood.id}/pdf`} />
        </>
      ) : (
        builds && !building && <p className="build-links">There is no PDF to show yet.</p>
      )}
    </section>
  );
}
