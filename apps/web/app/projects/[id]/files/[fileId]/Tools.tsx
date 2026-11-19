'use client';

// The small windows the visual editor opens: a formula's LaTeX with its preview, the list of
// labels to refer to, and the menu of things to do at a place in the text.
import type { CommandResult } from '@paperweave/bridge';
import { cellText } from '@paperweave/latex';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { numbers } from '../../../../../lib/numbers';
import { renderMath } from '../../../../../lib/visual';

type Apply = (latex: string) => Promise<CommandResult>;

/** A native dialog that is open exactly while `open` is true. It holds the focus while open. */
function useDialog(open: boolean): RefObject<HTMLDialogElement | null> {
  const box = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !box.current?.open) box.current?.showModal();
    if (!open && box.current?.open) box.current.close();
  }, [open]);
  return box;
}

/**
 * A formula to edit (`place` null: `src` is its whole source, delimiters and all) or to insert
 * (`place` says where: in the line, or on a line of its own with a number).
 */
export type FormulaRequest = { src: string; place: null | 'inline' | 'display'; apply: Apply };

export function FormulaBox(props: {
  request: FormulaRequest | null;
  macros: Record<string, string>;
  onDone(): void;
}) {
  const { request, macros, onDone } = props;
  const box = useDialog(!!request);
  const preview = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [place, setPlace] = useState<FormulaRequest['place']>(null);
  const [problem, setProblem] = useState('');
  const [undrawable, setUndrawable] = useState('');
  useEffect(() => {
    setDraft(request?.src ?? '');
    setPlace(request?.place ?? null);
    setProblem('');
  }, [request]);
  /** What goes into the paper: what was typed, inside the delimiters its place calls for. */
  const latex =
    place === 'inline'
      ? `$${draft.trim()}$`
      : place === 'display'
        ? `\\begin{equation}\n  ${draft.trim()}\n\\end{equation}`
        : draft;
  useEffect(() => {
    if (!request || !preview.current) return;
    try {
      renderMath(preview.current, latex, { macros });
      setUndrawable('');
    } catch (err) {
      preview.current.textContent = '';
      setUndrawable((err as Error).message);
    }
  }, [request, latex, macros]);
  const apply = async () => {
    if (!request) return;
    try {
      // A formula on its own line needs its own lines in the source too.
      const result = await request.apply(place === 'display' ? `\n${latex}\n` : latex);
      if (result !== 'conflict') return onDone();
      setProblem(
        'Someone changed this formula while you were editing it. Copy your text if you want to keep it, cancel, and open the formula again.',
      );
    } catch {
      setProblem('That edit could not be made. Check the connection and try again.');
    }
  };
  return (
    <dialog ref={box} className="tool" aria-labelledby="formula-title" onClose={onDone}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <h2 id="formula-title">{request?.place ? 'Insert an equation' : 'Edit formula'}</h2>
        {request?.place && (
          <fieldset>
            <legend>Where it goes</legend>
            <label>
              <input
                type="radio"
                name="place"
                checked={place === 'inline'}
                onChange={() => setPlace('inline')}
              />{' '}
              In the line
            </label>{' '}
            <label>
              <input
                type="radio"
                name="place"
                checked={place === 'display'}
                onChange={() => setPlace('display')}
              />{' '}
              On a line of its own, numbered
            </label>
          </fieldset>
        )}
        <label>
          LaTeX
          <textarea
            rows={request?.place ? 3 : 6}
            spellCheck={false}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem('');
            }}
          />
        </label>
        <p className="label">As it will look</p>
        <div className="preview" ref={preview} />
        {undrawable && draft.trim() && (
          <p className="note">
            This cannot be drawn here ({undrawable}). It can still be applied: the PDF is what
            decides.
          </p>
        )}
        {problem && <p role="alert">{problem}</p>}
        <p>
          <button type="submit" disabled={!draft.trim()}>
            {request?.place ? 'Insert' : 'Apply'}
          </button>{' '}
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        </p>
      </form>
    </dialog>
  );
}

/** A figure or a table to insert where the caret is. */
export type FloatRequest = { kind: 'figure' | 'table'; apply: Apply };

/** A label made from a caption: "Merge latency by writers" gives fig:merge-latency-by-writers. */
function labelFor(prefix: string, caption: string, taken: Set<string>) {
  const words =
    caption
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.slice(0, 4) ?? [];
  const base = `${prefix}:${words.join('-') || (prefix === 'fig' ? 'figure' : 'table')}`;
  for (let n = 1; ; n++) {
    const label = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(label)) return label;
  }
}

type Picture = { path: string; target: string; caption?: string; alt?: string };

/** The window that asks what a new figure or table should hold, and inserts it. */
export function FloatBox(props: {
  request: FloatRequest | null;
  projectId: string;
  onDone(): void;
}) {
  const { request, projectId, onDone } = props;
  const box = useDialog(!!request);
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [labels, setLabels] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [alt, setAlt] = useState('');
  const [caption, setCaption] = useState('');
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  const [problem, setProblem] = useState('');
  /** A drawn chart brings the caption and description its author gave it. */
  const choose = (p?: Picture) => {
    setTarget(p?.target ?? '');
    if (p?.caption === undefined) return;
    setCaption(p.caption);
    setAlt(p.alt ?? '');
  };
  useEffect(() => {
    if (!request) return;
    let stop = false;
    setAlt('');
    setCaption('');
    setProblem('');
    const read = <T,>(url: string, then: (found: T) => void) =>
      void fetch(url)
        .then((res) => (res.ok ? res.json() : []))
        .then((found: T) => !stop && then(found))
        .catch(() => {});
    read<Picture[]>(`/projects/${projectId}/pictures`, (found) => {
      setPictures(found);
      choose(found[0]);
    });
    // So that the new label is not one the paper already has.
    read<{ key: string }[]>(`/projects/${projectId}/labels`, (found) =>
      setLabels(new Set(found.map((l) => l.key))),
    );
    return () => void (stop = true);
  }, [request, projectId]);
  const figure = request?.kind === 'figure';
  const insert = async () => {
    if (!request) return;
    const said = alt.replace(/\s+/g, ' ').trim();
    const cap = caption.replace(/\s+/g, ' ').trim();
    if (/[{}%#\\\]]/.test(said))
      return setProblem(
        'A description cannot hold { } % # ] or a backslash. Say it in plain words.',
      );
    if (!cellText(cap))
      return setProblem('A caption cannot hold an unescaped & or %, and its braces must match.');
    const label = `  \\label{${labelFor(figure ? 'fig' : 'tab', cap, labels)}}`;
    const lines = figure
      ? [
          '\\begin{figure}[t]',
          '  \\centering',
          ...(target
            ? [`  \\includegraphics[width=\\linewidth${said ? `,alt={${said}}` : ''}]{${target}}`]
            : []),
          `  \\caption{${cap}}`,
          label,
          '\\end{figure}',
        ]
      : [
          '\\begin{table}[t]',
          '  \\centering',
          `  \\caption{${cap}}`,
          label,
          `  \\begin{tabular}{${'l'.repeat(columns)}}`,
          '    \\hline',
          `    ${Array.from({ length: columns }, (_, i) => `Column ${i + 1}`).join(' & ')} \\\\`,
          '    \\hline',
          ...Array.from({ length: rows - 1 }, () => `    ${' & '.repeat(columns - 1)} \\\\`),
          '    \\hline',
          '  \\end{tabular}',
          '\\end{table}',
        ];
    // What was wrong with the last try is not said of this one.
    setProblem('');
    try {
      // On lines of its own, like any figure or table in the source.
      await request.apply(`\n${lines.join('\n')}\n`);
      onDone();
    } catch (err) {
      // Why, for whoever is looking into it: no answer in time, or the server's own words.
      console.warn('edit not made:', (err as Error).message);
      setProblem('That edit could not be made. Check the connection and try again.');
    }
  };
  const count = (value: number, set: (n: number) => void, max: number, min: number) => (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => set(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
    />
  );
  return (
    <dialog ref={box} className="tool" aria-labelledby="float-title" onClose={onDone}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void insert();
        }}
      >
        <h2 id="float-title">{figure ? 'Insert a figure' : 'Insert a table'}</h2>
        {figure ? (
          <>
            <label>
              Picture
              <select
                value={target}
                onChange={(e) => choose(pictures.find((p) => p.target === e.target.value))}
              >
                {pictures.map((p) => (
                  <option key={p.path} value={p.target}>
                    {p.path}
                  </option>
                ))}
                <option value="">None yet</option>
              </select>
            </label>
            {pictures.length === 0 && (
              <p className="note">
                This paper has no pictures yet. Add them on the paper&apos;s page, under Files.
              </p>
            )}
            <label>
              Description, for people who cannot see the picture
              <input value={alt} onChange={(e) => setAlt(e.target.value)} disabled={!target} />
            </label>
          </>
        ) : (
          <>
            <label>Rows, the heading row included {count(rows, setRows, 30, 2)}</label>
            <label>Columns {count(columns, setColumns, 12, 1)}</label>
          </>
        )}
        <label>
          Caption
          <input value={caption} onChange={(e) => setCaption(e.target.value)} required />
        </label>
        {problem && <p role="alert">{problem}</p>}
        <p>
          <button type="submit">Insert</button>{' '}
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        </p>
      </form>
    </dialog>
  );
}

/** One thing that can be chosen: what the list shows, what typing matches, and what it inserts. */
type Choice = { key: string; text: string; match: string; latex: string };

/** A window to choose one of a list read from the paper, and insert what it stands for. */
function Picker(props: {
  request: { apply: Apply } | null;
  id: string;
  title: string;
  find: string;
  listed: string;
  /** What to say when the paper has none. */
  none: string;
  load(): Promise<Choice[]>;
  onDone(): void;
}) {
  const { request, load, onDone } = props;
  const box = useDialog(!!request);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState('');
  const [problem, setProblem] = useState('');
  // The loader is made anew on every render; the list is read once per opening.
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (!request) return;
    let stop = false;
    setChoices(null);
    setFilter('');
    setProblem('');
    loader
      .current()
      .then((found) => !stop && setChoices(found))
      .catch(() => !stop && setChoices([]));
    return () => void (stop = true);
  }, [request]);
  const shown = (choices ?? []).filter((c) => c.match.toLowerCase().includes(filter.toLowerCase()));
  const pick = shown.find((c) => c.key === chosen) ?? shown[0];
  const insert = async () => {
    if (!request || !pick) return;
    try {
      await request.apply(pick.latex);
      onDone();
    } catch {
      setProblem('That edit could not be made. Check the connection and try again.');
    }
  };
  return (
    <dialog ref={box} className="tool" aria-labelledby={props.id} onClose={onDone}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void insert();
        }}
      >
        <h2 id={props.id}>{props.title}</h2>
        <label>
          {props.find}
          <input value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        {choices === null ? (
          <p>Reading the paper…</p>
        ) : shown.length === 0 ? (
          <p>{choices.length ? 'Nothing matches.' : props.none}</p>
        ) : (
          <label>
            {props.listed}
            <select
              size={Math.max(2, Math.min(8, shown.length))}
              value={pick?.key ?? ''}
              onChange={(e) => setChosen(e.target.value)}
            >
              {shown.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.text}
                </option>
              ))}
            </select>
          </label>
        )}
        {pick && (
          <p className="note">
            Inserts <code>{pick.latex}</code>.
          </p>
        )}
        {problem && <p role="alert">{problem}</p>}
        <p>
          <button type="submit" disabled={!pick}>
            Insert
          </button>{' '}
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        </p>
      </form>
    </dialog>
  );
}

type Label = { key: string; path: string; line: number };

/** Choose one of the paper's labels and insert a reference to it. */
export function ReferencePicker(props: {
  request: { apply: Apply } | null;
  projectId: string;
  onDone(): void;
}) {
  const load = async () => {
    const res = await fetch(`/projects/${props.projectId}/labels`);
    const found: Label[] = res.ok ? await res.json() : [];
    return (
      found
        // A name used twice is one choice: a reference cannot say which it means.
        .filter((l, i) => found.findIndex((x) => x.key === l.key) === i)
        .map((l) => {
          const number = numbers().labels[l.key]?.number;
          return {
            key: l.key,
            text: `${l.key}${number ? `, number ${number}` : ''} (${l.path})`,
            match: l.key,
            // Equations are referred to in brackets.
            latex: `\\${/^eqn?[:.-]/i.test(l.key) ? 'eqref' : 'ref'}{${l.key}}`,
          };
        })
    );
  };
  return (
    <Picker
      request={props.request}
      id="reference-title"
      title="Insert a reference"
      find="Find a label"
      listed="Label"
      none="This paper has no labels yet."
      load={load}
      onDone={props.onDone}
    />
  );
}

type Cited = { entries: { key: string; description: string; path: string }[]; command: string };

/** Choose an entry of the paper's bibliography and insert a citation of it. */
export function CitationPicker(props: {
  request: { apply: Apply } | null;
  projectId: string;
  onDone(): void;
}) {
  const load = async () => {
    const res = await fetch(`/projects/${props.projectId}/citations`);
    const { entries, command }: Cited = res.ok ? await res.json() : { entries: [], command: '' };
    return (
      entries
        .filter((e, i) => entries.findIndex((x) => x.key === e.key) === i)
        // The command the paper already uses most, so that the new citation looks like the rest.
        .map((e) => ({
          key: e.key,
          text: `${e.key}: ${e.description}`,
          match: `${e.key} ${e.description}`,
          latex: `\\${command}{${e.key}}`,
        }))
    );
  };
  return (
    <Picker
      request={props.request}
      id="citation-title"
      title="Insert a citation"
      find="Find an entry, by key, author, year or title"
      listed="Entry"
      none="This paper's bibliography has no entries yet. Add them to a .bib file."
      load={load}
      onDone={props.onDone}
    />
  );
}

/** The menu that opens on a right click, or the menu key, in the visual view. */
export function EditorMenu(props: {
  at: { x: number; y: number; formula?: () => void } | null;
  onClose(): void;
  onReference(): void;
  onCitation(): void;
  onEquation(): void;
  onFigure(): void;
  onTable(): void;
}) {
  const { at, onClose } = props;
  const menu = useRef<HTMLUListElement>(null);
  // The first item takes the keyboard when the menu opens, and only then. The editor draws
  // itself again whenever anyone arrives, moves or types, and hands this a new `onClose` each
  // time: taking the keyboard again on those would throw someone working down the menu with
  // the arrow keys back to the top.
  useEffect(() => {
    if (at) menu.current?.querySelector('button')?.focus();
  }, [at]);
  useEffect(() => {
    if (!at) return;
    // A click anywhere else puts the menu away.
    const away = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [at, onClose]);
  if (!at) return null;
  const items: [string, () => void][] = [
    ...(at.formula ? ([['Edit formula…', at.formula]] as [string, () => void][]) : []),
    ['Insert a reference…', props.onReference],
    ['Insert a citation…', props.onCitation],
    ['Insert an equation…', props.onEquation],
    ['Insert a figure…', props.onFigure],
    ['Insert a table…', props.onTable],
  ];
  const move = (by: number) => {
    const buttons = [...(menu.current?.querySelectorAll('button') ?? [])];
    const next = buttons.indexOf(document.activeElement as HTMLButtonElement) + by;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };
  return (
    <ul
      ref={menu}
      role="menu"
      aria-label="At this place"
      className="menu"
      style={{ left: at.x, top: at.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        else if (e.key === 'ArrowDown') move(1);
        else if (e.key === 'ArrowUp') move(-1);
        else return;
        e.preventDefault();
      }}
    >
      {items.map(([name, run]) => (
        <li key={name} role="none">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              run();
            }}
          >
            {name}
          </button>
        </li>
      ))}
      <li role="none" className="hint">
        Shift + right click for the browser&apos;s own menu
      </li>
    </ul>
  );
}
