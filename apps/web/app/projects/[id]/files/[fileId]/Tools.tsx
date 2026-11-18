'use client';

// The small windows the visual editor opens: a formula's LaTeX with its preview, the list of
// labels to refer to, and the menu of things to do at a place in the text.
import type { CommandResult } from '@paperweave/bridge';
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

type Label = { key: string; path: string; line: number };

/** Choose one of the paper's labels and insert a reference to it. */
export function ReferencePicker(props: {
  request: { apply: Apply } | null;
  projectId: string;
  onDone(): void;
}) {
  const { request, projectId, onDone } = props;
  const box = useDialog(!!request);
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState('');
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!request) return;
    let stop = false;
    setLabels(null);
    setFilter('');
    setProblem('');
    void fetch(`/projects/${projectId}/labels`)
      .then((res) => (res.ok ? res.json() : []))
      .then((found: Label[]) => {
        // A name used twice is one choice: a reference cannot say which it means.
        if (!stop) setLabels(found.filter((l, i) => found.findIndex((x) => x.key === l.key) === i));
      })
      .catch(() => !stop && setLabels([]));
    return () => void (stop = true);
  }, [request, projectId]);
  const shown = (labels ?? []).filter((l) => l.key.toLowerCase().includes(filter.toLowerCase()));
  const key = shown.some((l) => l.key === chosen) ? chosen : (shown[0]?.key ?? '');
  // Equations are referred to in brackets.
  const latex = key ? `\\${/^eqn?[:.-]/i.test(key) ? 'eqref' : 'ref'}{${key}}` : '';
  const insert = async () => {
    if (!request || !latex) return;
    try {
      await request.apply(latex);
      onDone();
    } catch {
      setProblem('That edit could not be made. Check the connection and try again.');
    }
  };
  return (
    <dialog ref={box} className="tool" aria-labelledby="picker-title" onClose={onDone}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void insert();
        }}
      >
        <h2 id="picker-title">Insert a reference</h2>
        <label>
          Find a label
          <input value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        {labels === null ? (
          <p>Reading the paper&apos;s labels…</p>
        ) : shown.length === 0 ? (
          <p>{labels.length ? 'No label matches.' : 'This paper has no labels yet.'}</p>
        ) : (
          <label>
            Label
            <select
              size={Math.max(2, Math.min(8, shown.length))}
              value={key}
              onChange={(e) => setChosen(e.target.value)}
            >
              {shown.map((l) => {
                const number = numbers().labels[l.key]?.number;
                return (
                  <option key={l.key} value={l.key}>
                    {l.key}
                    {number ? `, number ${number}` : ''} ({l.path})
                  </option>
                );
              })}
            </select>
          </label>
        )}
        {latex && (
          <p className="note">
            Inserts <code>{latex}</code>.
          </p>
        )}
        {problem && <p role="alert">{problem}</p>}
        <p>
          <button type="submit" disabled={!latex}>
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

/** The menu that opens on a right click, or the menu key, in the visual view. */
export function EditorMenu(props: {
  at: { x: number; y: number; formula?: () => void } | null;
  onClose(): void;
  onReference(): void;
  onEquation(): void;
}) {
  const { at, onClose } = props;
  const menu = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!at) return;
    menu.current?.querySelector('button')?.focus();
    // A click anywhere else puts the menu away.
    const away = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [at, onClose]);
  if (!at) return null;
  const items: [string, () => void][] = [
    ...(at.formula ? ([['Edit formula…', at.formula]] as [string, () => void][]) : []),
    ['Insert a reference…', props.onReference],
    ['Insert an equation…', props.onEquation],
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
