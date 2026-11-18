'use client';

import { useEffect, useRef, useState } from 'react';
import { createSession, type Session, type Status } from './session';

declare global {
  interface Window {
    __spike?: Session;
  }
}

const AUTHORS = ['A', 'B'] as const;

type Build = { state: 'idle' | 'building' | 'failed'; url?: string; problems: string[] };

export default function Spike({
  projects,
  sourceOnly,
  compilable,
}: {
  projects: Record<string, Record<string, string>>;
  sourceOnly: Record<string, string[]>;
  compilable: string[];
}) {
  const names = Object.keys(projects);
  const [project, setProject] = useState(names.includes('big') ? 'big' : names[0]);
  const files = Object.keys(projects[project]);
  const [file, setFile] = useState(files.find((f) => f.includes('intro')) ?? files[0]);
  const [delay, setDelay] = useState(150);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<Status>({ pending: 0, message: '' });
  const session = useRef<Session | null>(null);
  const els = useRef<Record<string, HTMLDivElement | null>>({});
  const text = projects[project][file] ?? projects[project][files[0]];

  useEffect(() => {
    const at = (k: string) => els.current[k]!;
    const s = createSession(
      {
        A: { source: at('A-source'), visual: at('A-visual') },
        B: { source: at('B-source'), visual: at('B-visual') },
      },
      text,
      setStatus,
      !!sourceOnly[project]?.includes(file),
    );
    session.current = window.__spike = s;
    return () => {
      s.destroy();
      setPaused(false);
      setStatus({ pending: 0, message: '' });
    };
    // The session is rebuilt when the file changes; `text` is that file's content.
  }, [text]);
  const [build, setBuild] = useState<Build>({ state: 'idle', problems: [] });
  const compile = async () => {
    setBuild({ state: 'building', problems: [] });
    const body = JSON.stringify({ project, file, text: session.current!.A.src() });
    const res = await fetch('/api/spike/compile', { method: 'POST', body });
    if (res.ok)
      return setBuild({ state: 'idle', problems: [], url: URL.createObjectURL(await res.blob()) });
    const { diagnostics = [], error, timedOut } = await res.json();
    const problems = diagnostics
      .filter((d: { severity: string }) => d.severity === 'error')
      .map(
        (d: { file?: string; line?: number; message: string }) =>
          `${d.file}:${d.line}: ${d.message}`,
      );
    setBuild({
      state: 'failed',
      problems: [
        ...problems,
        ...(timedOut ? ['The build ran out of time.'] : []),
        ...(error ? [error] : []),
      ],
    });
  };
  useEffect(() => {
    if (session.current) session.current.relay.delay = delay;
  }, [delay, text]);
  useEffect(() => session.current?.setPaused(paused), [paused, text]);

  return (
    <main className="spike">
      <header>
        <h1>Editor spike</h1>
        <label>
          Project{' '}
          <select
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setFile(Object.keys(projects[e.target.value])[0]);
            }}
          >
            {names.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          File{' '}
          <select value={file} onChange={(e) => setFile(e.target.value)}>
            {files.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <label>
          Network delay{' '}
          <input
            type="number"
            min={0}
            max={5000}
            step={50}
            value={delay}
            onChange={(e) => setDelay(+e.target.value)}
          />{' '}
          ms
        </label>
        <button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>
          {paused ? 'Reconnect authors' : 'Disconnect authors'}
        </button>
        {compilable.includes(project) && (
          <button type="button" onClick={compile} disabled={build.state === 'building'}>
            {build.state === 'building' ? 'Compiling…' : 'Compile PDF'}
          </button>
        )}
        {build.url && (
          <a href={build.url} target="_blank" rel="noreferrer">
            Open the compiled PDF
          </a>
        )}
        <p role="status" aria-live="polite">
          {paused ? 'Disconnected. ' : ''}
          {status.pending
            ? `${status.pending} unsynced edit${status.pending > 1 ? 's' : ''}. `
            : 'All edits synced. '}
          {status.message}
        </p>
      </header>
      {build.state === 'failed' && (
        <div className="problems" role="alert">
          <strong>The paper did not compile.</strong>
          <ul>
            {build.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="authors">
        {AUTHORS.map((a) => (
          <section key={a} aria-label={`Author ${a}`}>
            <h2>Author {a}</h2>
            <div className="toolbar">
              <button type="button" onClick={() => session.current?.[a].emph()}>
                Emphasise
              </button>
              <button type="button" onClick={() => session.current?.[a].undo.undo()}>
                Undo
              </button>
              <button type="button" onClick={() => session.current?.[a].undo.redo()}>
                Redo
              </button>
              <button type="button" onClick={() => session.current?.[a].showInSource()}>
                Show selection in source
              </button>
              <button type="button" onClick={() => session.current?.[a].showInVisual()}>
                Show selection in visual
              </button>
            </div>
            <div className="panes">
              <div className="visual" ref={(e) => void (els.current[`${a}-visual`] = e)} />
              <div className="source" ref={(e) => void (els.current[`${a}-source`] = e)} />
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
