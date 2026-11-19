'use client';

import type { Build } from '@paperweave/server';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Numbers, setNumbers } from '../../../../../lib/numbers';
import { onShow, showInEditor } from '../../../../../lib/pdfsync';
import { whileShown } from '../../../../../lib/shown';
import PdfView, { type Mark } from './PdfView';

type Builds = { latest: Build | null; lastGood: Build | null; edits: string };

/** A build takes a minute at most once it starts. Waiting twice that, it has not started. */
const STUCK_AFTER_MS = 120_000;

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
  // The paper's mark at the last poll, to see that it has been still since.
  const seen = useRef<string | null>(null);
  // The paper's mark, and the revision of the newest build, when this pane last asked for a
  // build by itself.
  const asked = useRef<string | null>(null);

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
      // Build by itself once the paper has been still for one poll and differs from what was built.
      const idle = seen.current === next.edits;
      seen.current = next.edits;
      const behind = !next.latest || (next.latest.status !== 'queued' && next.latest.stale);
      // Once for each state of the paper and revision the newest build is of. A build that
      // comes back behind, of the same revision, is not asked for again until something
      // changes: asked for every two seconds, a paper would use up its builds for the hour.
      // The revision is part of it because someone may build an older revision, which then
      // is the newest build: the paper has not changed, and still wants building.
      const state = `${next.edits} ${next.latest?.revisionId}`;
      if (auto && canBuild && idle && behind && asked.current !== state) {
        asked.current = state;
        void compile();
      }
    };
    const off = whileShown(() => void poll(), 2000);
    return () => {
      stop = true;
      off();
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
  // The editor asks for a line to be shown in this PDF; a double-click on a page asks the
  // editor for the line that made what is there.
  const [mark, setMark] = useState<(Mark & { pdf: string }) | null>(null);
  const [said, setSaid] = useState('');
  const middle = useRef(() => {});
  const ask = useCallback(
    async (query: string) => {
      const res = await fetch(`${url}/${pdf}/sync?${query}`).catch(() => null);
      return res?.ok ? res.json() : null;
    },
    [url, pdf],
  );
  useEffect(() => {
    if (!pdf) return;
    return onShow('pdf', async ({ fileId, line }) => {
      const place: Mark | null = await ask(`file=${fileId}&line=${line}`);
      if (!place) return setSaid('The PDF does not say where that line is.');
      setMark({ ...place, pdf });
      setSaid(`Shown on page ${place.page} of the PDF.`);
    });
  }, [pdf, ask]);
  const pick = async (page: number, x: number, y: number) => {
    const place = await ask(`page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`);
    if (!place) return setSaid('The PDF does not say where that came from.');
    setSaid(`That is line ${place.line} of ${place.path}.`);
    showInEditor(place);
  };
  const building = latest?.status === 'queued';
  // A build that has waited this long is not being built: the worker that builds is busy with
  // a long queue, or is not running. "Compiling" for ever would say nothing was wrong.
  const stuck = building && Date.now() - Date.parse(latest.createdAt) > STUCK_AFTER_MS;
  const state = !builds
    ? 'Checking for a PDF…'
    : building
      ? stuck
        ? 'Still waiting to compile after two minutes. The build service may be busy or not running.'
        : 'Compiling…'
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
          <p className="build-links">
            <a href={`${url}/${lastGood.id}/pdf`} target="_blank" rel="noreferrer">
              Open the PDF by itself
            </a>
            . Double-click a place on a page to go to its line in the text, or scroll the pages
            until it is in the middle and use the button.{' '}
            <button type="button" onClick={() => middle.current()}>
              Go to the text for the middle of the pages shown
            </button>{' '}
            <span aria-live="polite" className="pdf-said">
              {said}
            </span>
          </p>
          <PdfView
            src={`${url}/${lastGood.id}/pdf`}
            mark={mark && mark.pdf === lastGood.id ? mark : null}
            onPick={pick}
            middle={middle}
          />
        </>
      ) : (
        builds && !building && <p className="build-links">There is no PDF to show yet.</p>
      )}
    </section>
  );
}
