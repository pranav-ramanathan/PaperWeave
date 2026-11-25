'use client';

// The small windows the visual editor opens: a formula's LaTeX with its preview, the list of
// labels to refer to, and the menu of things to do at a place in the text.
import type { CommandResult } from '@paperweave/bridge';
import { captionText, cellText, footnoteBody, stray, strayAdvice } from '@paperweave/latex';
import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useLook } from '../../../../../components/look';
import { Button } from '../../../../../components/ui/button';
import { numbers } from '../../../../../lib/numbers';
import { tooLongText, TooLong } from '../../../../../lib/mathlimit';
import { renderMath } from '../../../../../lib/visual';

type Apply = (latex: string) => Promise<CommandResult | 'spills' | { problem: string }>;

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
 * One of the small windows: a native <dialog> that holds the focus while it is open (`box`, from
 * useDialog), with its title and a form. The same element in both looks; the new look only draws
 * it differently (windows.css) and gives its buttons the kit's classes.
 *
 * It stays a native <dialog> in the new look, not Radix's Dialog (PLAN.md section 7, fallback):
 * Radix hides the rest of the page from the accessibility tree while it is open (aria-hidden on
 * everything outside it), and the figure and footnote specs read the page behind a window that
 * is still open after a refusal. The native one keeps the rest inert without hiding it, takes
 * the keys typed straight after it opens, and gives the keyboard back to the text on Escape.
 */
function Window(props: {
  box: RefObject<HTMLDialogElement | null>;
  /** The id of the title, which names the window. */
  id: string;
  title: ReactNode;
  onSubmit(): void;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <dialog ref={props.box} className="tool" aria-labelledby={props.id} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit();
        }}
      >
        <h2 id={props.id}>{props.title}</h2>
        {props.children}
      </form>
    </dialog>
  );
}

/** A button of the window: the new look's button there, the plain one in the old. */
function Btn({ variant, ...rest }: ComponentProps<'button'> & { variant?: 'outline' | 'default' }) {
  if (useLook() === 'next') return <Button variant={variant ?? 'default'} {...rest} />;
  return <button {...rest} />;
}

/**
 * The window's buttons: the action, then Cancel, in that order for the keyboard. The new look
 * draws them as the footer of a dialog, Cancel first, and so lays them out in the other direction.
 */
function Actions(props: { action: ComponentProps<'button'>; label: string; onCancel(): void }) {
  const cancel = (
    <Btn variant="outline" type="button" onClick={props.onCancel}>
      Cancel
    </Btn>
  );
  const action = (
    <Btn type="submit" {...props.action}>
      {props.label}
    </Btn>
  );
  if (useLook() === 'next')
    return (
      <div className="tool-actions">
        {action}
        {cancel}
      </div>
    );
  return (
    <p>
      {action} {cancel}
    </p>
  );
}

/**
 * A formula to edit (`place` null: `src` is its whole source, delimiters and all) or to insert
 * (`place` says where: in the line, or on a line of its own with a number).
 */
export type FormulaRequest = {
  src: string;
  place: null | 'inline' | 'display';
  apply: Apply;
  /** Set for an inline atom that is not a formula (a citation, say): no preview, and edits that spill are refused. */
  what?: string;
};

export function FormulaBox(props: {
  request: FormulaRequest | null;
  macros: Record<string, string>;
  onDone(): void;
}) {
  const { request, macros, onDone } = props;
  const box = useDialog(!!request);
  const preview = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [place, setPlace] = useState<FormulaRequest['place']>(null);
  const [problem, setProblem] = useState('');
  const [undrawable, setUndrawable] = useState('');
  // While the answer to an edit is awaited, it cannot be asked for again.
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(request?.src ?? '');
    setPlace(request?.place ?? null);
    setProblem('');
  }, [request]);
  // The window opens on its first control, which for an equation is where it goes. What is typed
  // next is the formula, so the keyboard starts there (the window's own effect has opened it).
  useEffect(() => {
    if (request) field.current?.focus();
  }, [request]);
  /** What goes into the paper: what was typed, inside the delimiters its place calls for. */
  const latex =
    place === 'inline'
      ? `$${draft.trim()}$`
      : place === 'display'
        ? `\\begin{equation}\n  ${draft.trim()}\n\\end{equation}`
        : draft;
  useEffect(() => {
    if (!request || request.what || !preview.current) return;
    try {
      renderMath(preview.current, latex, { macros });
      setUndrawable('');
    } catch (err) {
      if (err instanceof TooLong) {
        preview.current.textContent = tooLongText(latex);
        setUndrawable('');
        return;
      }
      preview.current.textContent = '';
      setUndrawable((err as Error).message);
    }
  }, [request, latex, macros]);
  const apply = async () => {
    if (!request || busy) return;
    setBusy(true);
    try {
      // A formula on its own line needs its own lines in the source too.
      const result = await request.apply(place === 'display' ? `\n${latex}\n` : latex);
      if (typeof result === 'object') setProblem(result.problem);
      else if (result === 'spills')
        setProblem(
          'This would change how the text around it is read (an unclosed brace, a blank line, a % at the end, or a command run into the next word). Fix it here, or make the change in the source.',
        );
      else if (result === 'conflict')
        setProblem(
          `Someone changed this ${request.what ? '' : 'formula '}while you were editing it. Copy your text if you want to keep it, cancel, and open it again.`,
        );
      else return onDone();
    } catch {
      setProblem('That edit could not be made. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Window
      box={box}
      id="formula-title"
      title={
        request?.place
          ? 'Insert an equation'
          : request?.what
            ? `Edit ${request.what}`
            : 'Edit formula'
      }
      onSubmit={() => void apply()}
      onClose={onDone}
    >
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
          ref={field}
          rows={request?.place ? 3 : 6}
          spellCheck={false}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem('');
          }}
        />
      </label>
      {!request?.what && <p className="label">As it will look</p>}
      {!request?.what && (
        <div
          className="preview"
          ref={preview}
          tabIndex={0}
          role="group"
          aria-label="As it will look"
        />
      )}
      {!request?.what && undrawable && draft.trim() && (
        <p className="note">
          This cannot be drawn here ({undrawable}). It can still be applied: the PDF is what
          decides.
        </p>
      )}
      {problem && <p role="alert">{problem}</p>}
      <Actions
        action={{ disabled: !draft.trim() || busy }}
        label={request?.place ? 'Insert' : 'Apply'}
        onCancel={onDone}
      />
    </Window>
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
  /** The picture's name in the source: '' for none, null until one has been chosen. */
  const [target, setTarget] = useState<string | null>(null);
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [alt, setAlt] = useState('');
  const [caption, setCaption] = useState('');
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
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
    // Nothing is carried over from the last time the window was open.
    setAlt('');
    setCaption('');
    setProblem('');
    setPictures([]);
    setTarget(null);
    setLoad('loading');
    const read = <T,>(url: string, then: (found: T) => void, fail?: () => void) =>
      void fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`);
          return res.json();
        })
        .then((found: T) => !stop && then(found))
        .catch(() => !stop && fail?.());
    read<Picture[]>(
      `/projects/${projectId}/pictures`,
      (found) => {
        setPictures(found);
        // No guess among several: one picture, or none, leaves nothing to choose.
        if (found.length <= 1) choose(found[0]);
        setLoad('ready');
      },
      () => setLoad('failed'),
    );
    // So that the new label is not one the paper already has.
    read<{ key: string }[]>(`/projects/${projectId}/labels`, (found) =>
      setLabels(new Set(found.map((l) => l.key))),
    );
    return () => void (stop = true);
  }, [request, projectId, attempt]);
  const figure = request?.kind === 'figure';
  const insert = async () => {
    if (!request || busy) return;
    if (figure && load !== 'ready')
      return setProblem(
        load === 'loading'
          ? 'The pictures are still loading. Try again in a moment.'
          : 'The pictures could not be loaded. Use Retry first.',
      );
    if (figure && target === null)
      return setProblem('Choose a picture first, or choose No picture yet.');
    const said = alt.replace(/\s+/g, ' ').trim();
    const cap = caption.replace(/\s+/g, ' ').trim();
    if (/[{}%#\\\]]/.test(said))
      return setProblem(
        'A description cannot hold { } % # ] or a backslash. Say it in plain words.',
      );
    if (!captionText(cap))
      return setProblem(
        'A caption cannot hold an unescaped & or %, its braces must match, and it cannot end in a backslash.',
      );
    const strayCap = stray(cap);
    if (strayCap) return setProblem(strayAdvice(strayCap));
    if (figure && target && /[%#"{}]/.test(target))
      return setProblem("LaTeX cannot use this picture's name. Rename it first.");
    const label = `  \\label{${labelFor(figure ? 'fig' : 'tab', cap, labels)}}`;
    const lines = figure
      ? [
          '\\begin{figure}[t]',
          '  \\centering',
          ...(figure && target
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
    setBusy(true);
    try {
      // On lines of its own, like any figure or table in the source.
      await request.apply(`\n${lines.join('\n')}\n`);
      onDone();
    } catch (err) {
      // Why, for whoever is looking into it: the server's own words.
      console.warn('edit not made:', (err as Error).message);
      setProblem('That edit could not be made. Check the connection and try again.');
    } finally {
      setBusy(false);
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
    <Window
      box={box}
      id="float-title"
      title={figure ? 'Insert a figure' : 'Insert a table'}
      onSubmit={() => void insert()}
      onClose={onDone}
    >
      {figure ? (
        <>
          <label>
            Picture
            <select
              value={target ?? '?'}
              onChange={(e) => choose(pictures.find((p) => p.target === e.target.value))}
            >
              {load === 'loading' && (
                <option value="?" disabled>
                  Loading pictures…
                </option>
              )}
              {load === 'failed' && (
                <option value="?" disabled>
                  Pictures not loaded
                </option>
              )}
              {load === 'ready' && target === null && (
                <option value="?" disabled>
                  Choose a picture…
                </option>
              )}
              {pictures.map((p) => (
                <option key={p.path} value={p.target}>
                  {p.path}
                </option>
              ))}
              {load === 'ready' && <option value="">No picture yet</option>}
            </select>
          </label>
          {load === 'failed' && (
            <p className="note">
              Could not load the pictures.{' '}
              <Btn variant="outline" type="button" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Btn>
            </p>
          )}
          {load === 'ready' && pictures.length === 0 && (
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
      <Actions
        // aria-disabled, not disabled, so the button keeps the keyboard while it waits.
        action={{ 'aria-disabled': busy || (figure && load !== 'ready') || undefined }}
        label="Insert"
        onCancel={onDone}
      />
    </Window>
  );
}

/** A section heading to insert where the caret is. `apply` takes its level and its title. */
export type Level = 'section' | 'subsection' | 'subsubsection';
export type HeadingRequest = {
  apply: (level: Level, title: string) => Promise<CommandResult | 'spills'>;
};

/** The window that asks for a heading's level and title, and inserts it. */
export function HeadingBox(props: {
  request: HeadingRequest | null;
  /** Done with this request: a later one, if there is one, is not done with. */
  onDone(request: HeadingRequest | null): void;
}) {
  const { request, onDone } = props;
  const box = useDialog(!!request);
  const field = useRef<HTMLInputElement>(null);
  /** The request the window was last opened for. */
  const shown = useRef<HeadingRequest | null>(null);
  const [level, setLevel] = useState<Level>('section');
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setLevel('section');
    setTitle('');
    setProblem('');
  }, [request]);
  // `useDialog` opens the window when a request appears. One that replaces another at once (the
  // key pressed just after Escape, before the close was heard) finds it closed by the browser
  // with the request still there, so each request opens it again if it is shut.
  useEffect(() => {
    if (request && !box.current?.open) box.current?.showModal();
  }, [request, box]);
  // The title is what is typed first: the keyboard starts there (the window's own effect has opened it).
  useEffect(() => {
    if (!request) return;
    shown.current = request;
    field.current?.focus();
  }, [request]);
  const insert = async () => {
    if (!request || busy) return;
    // One line: a line break in a title would end the paragraph the heading is in.
    const text = title.replace(/\s+/g, ' ').trim();
    if (!text) return setProblem('A heading needs a title.');
    if (!cellText(text))
      return setProblem('A title cannot hold an unescaped & or %, and its braces must match.');
    const strayTitle = stray(text);
    if (strayTitle) return setProblem(strayAdvice(strayTitle));
    setProblem('');
    setBusy(true);
    try {
      await request.apply(level, text);
      onDone(request);
    } catch (err) {
      console.warn('edit not made:', (err as Error).message);
      setProblem('That edit could not be made. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Window
      box={box}
      id="heading-title"
      title="Insert a heading"
      onSubmit={() => void insert()}
      // A close event can arrive after the window was asked for again (a key pressed just after
      // Escape): it is about the window that went, so it ends that request and not the new one.
      onClose={() => !box.current?.open && onDone(shown.current)}
    >
      <label>
        Level
        <select value={level} onChange={(e) => setLevel(e.target.value as Level)}>
          <option value="section">Section</option>
          <option value="subsection">Subsection</option>
          <option value="subsubsection">Subsubsection</option>
        </select>
      </label>
      <label>
        Title
        <input
          ref={field}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-invalid={!!problem}
        />
      </label>
      {problem && <p role="alert">{problem}</p>}
      <Actions action={{ disabled: busy }} label="Insert" onCancel={() => onDone(request)} />
    </Window>
  );
}

/** A footnote to insert where the caret was when it was asked for. */
export type FootnoteRequest = { apply: (text: string) => Promise<CommandResult | 'spills'> };

/** The window that asks what a new footnote says, and inserts it. */
export function FootnoteBox(props: {
  request: FootnoteRequest | null;
  /** Done with this request: a later one, if there is one, is not done with. */
  onDone(request: FootnoteRequest | null): void;
}) {
  const { request, onDone } = props;
  const box = useDialog(!!request);
  const field = useRef<HTMLTextAreaElement>(null);
  /** The request the window was last opened for. */
  const shown = useRef<FootnoteRequest | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft('');
    setProblem('');
  }, [request]);
  // As in the heading window: a request that replaces another at once finds the window shut.
  useEffect(() => {
    if (request && !box.current?.open) box.current?.showModal();
  }, [request, box]);
  useEffect(() => {
    if (!request) return;
    shown.current = request;
    field.current?.focus();
  }, [request]);
  const insert = async () => {
    if (!request || busy) return;
    const body = footnoteBody(draft);
    if ('problem' in body) return setProblem(body.problem);
    setProblem('');
    setBusy(true);
    try {
      const result = await request.apply(body.text);
      if (result === 'spills')
        setProblem(
          'Only running text can go in a footnote added here: no list, heading or equation on a line of its own, and nothing left open. Add anything else in the source.',
        );
      else if (result === 'conflict')
        setProblem(
          'The text changed where the footnote was going. Copy your text if you want to keep it, cancel, and try again.',
        );
      else onDone(request);
    } catch (err) {
      console.warn('edit not made:', (err as Error).message);
      setProblem('That edit could not be made. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Window
      box={box}
      id="footnote-title"
      title="Insert a footnote"
      onSubmit={() => void insert()}
      onClose={() => !box.current?.open && onDone(shown.current)}
    >
      <label>
        Text
        <textarea
          ref={field}
          rows={3}
          value={draft}
          aria-invalid={!!problem}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem('');
          }}
          onKeyDown={(e) => {
            // One paragraph: Enter inserts, as in the heading window.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void insert();
            }
          }}
        />
      </label>
      <p className="note">
        Goes in where the caret is, as a numbered note at the foot of the page. LaTeX works here
        too: a formula between $ signs, {'\\cite'}, {'\\url'}.
      </p>
      {problem && <p role="alert">{problem}</p>}
      <Actions action={{ disabled: busy }} label="Insert" onCancel={() => onDone(request)} />
    </Window>
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
  const [busy, setBusy] = useState(false);
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
    if (!request || !pick || busy) return;
    setBusy(true);
    try {
      await request.apply(pick.latex);
      onDone();
    } catch {
      setProblem('That edit could not be made. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Window
      box={box}
      id={props.id}
      title={props.title}
      onSubmit={() => void insert()}
      onClose={onDone}
    >
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
      <Actions action={{ disabled: !pick || busy }} label="Insert" onCancel={onDone} />
    </Window>
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
  at: { x: number; y: number; top: number; edit?: { name: string; run(): void } } | null;
  onClose(): void;
  onReference(): void;
  onCitation(): void;
  onFootnote(): void;
  onEquation(): void;
  onFigure(): void;
  onTable(): void;
  onHeading(): void;
  onBulleted(): void;
  onNumbered(): void;
}) {
  const { at, onClose } = props;
  const menu = useRef<HTMLUListElement>(null);
  // The first item takes the keyboard when the menu opens, and only then. The editor draws
  // itself again whenever anyone arrives, moves or types, and hands this a new `onClose` each
  // time: taking the keyboard again on those would throw someone working down the menu with
  // the arrow keys back to the top.
  // Where it goes is worked out before it is first drawn on screen, from its own size: below
  // the place if it fits there, else above it, and always inside the window.
  const [put, setPut] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const m = menu.current;
    if (!at || !m) return setPut(null);
    const { offsetWidth: w, offsetHeight: h } = m;
    const room = window.innerHeight - 8;
    const top = at.y + h <= room ? at.y : Math.max(8, Math.min(at.top - h, room - h));
    const left = Math.max(8, Math.min(at.x, window.innerWidth - w - 8));
    setPut({ left, top });
  }, [at]);
  useEffect(() => {
    if (at && put) menu.current?.querySelector('button')?.focus();
  }, [put, at]);
  useEffect(() => {
    if (!at) return;
    // A click anywhere else puts the menu away.
    const away = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [at, onClose]);
  if (!at) return null;
  const items: [string, () => void][] = [
    ...(at.edit ? ([[`Edit ${at.edit.name}…`, at.edit.run]] as [string, () => void][]) : []),
    ['Insert a reference…', props.onReference],
    ['Insert a citation…', props.onCitation],
    ['Insert an equation…', props.onEquation],
    ['Insert a footnote…', props.onFootnote],
    ['Insert a figure…', props.onFigure],
    ['Insert a table…', props.onTable],
    ['Insert a heading…', props.onHeading],
    ['Insert a bulleted list', props.onBulleted],
    ['Insert a numbered list', props.onNumbered],
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
      style={put ?? { left: at.x, top: at.y, visibility: 'hidden' }}
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
