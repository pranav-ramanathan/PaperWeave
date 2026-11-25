'use client';

import { defaultKeymap } from '@codemirror/commands';
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  openSearchPanel,
  search,
} from '@codemirror/search';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  type Command,
  type CommandResult,
  LATEX_TYPE,
  pasteable,
  watchSaved,
} from '@paperweave/bridge';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { useLook } from '../../../../../components/look';
import { setBibliography } from '../../../../../lib/bibliography';
import { pageNonce } from '../../../../../lib/nonce';
import {
  atRisk,
  LEAVE,
  leavesPage,
  place,
  samePage,
  stepsBack,
  wentTo,
} from '../../../../../lib/leaving';
import { carry, onShow, showInPdf, taken } from '../../../../../lib/pdfsync';
import { wordAt } from '../../../../../lib/pdfword';
import { onFiles, refreshFiles } from '../../../../../lib/paperfiles';
import {
  goneWords,
  isNews,
  type Left,
  restoreChanges,
  restoreHistory,
  restoredWords,
  whyGone,
} from '../../../../../lib/restored';
import { setTyping } from '../../../../../lib/typing';
import { createVisual, type Visual } from '../../../../../lib/visual';
import type { LanguageFinding, Proposal, RestoreNote, Thread } from '@paperweave/server';
import { ReviewPanel } from '../../../../../components/review-card';
import Language from './Language';
import Proposals from './Proposals';
import {
  Bold,
  FileSearch,
  Heading,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquareText,
  Quote,
  Redo2,
  Search,
  Sigma,
  Table2,
  Undo2,
} from 'lucide-react';
import Toolbar, { Tool } from './Toolbar';
import Threads, { type Member, type Stretch } from './Threads';
import {
  CitationPicker,
  EditorMenu,
  FloatBox,
  FootnoteBox,
  type FootnoteRequest,
  HeadingBox,
  type HeadingRequest,
  type FloatRequest,
  FormulaBox,
  type FormulaRequest,
  ReferencePicker,
} from './Tools';

// The stretches of text with a thread of comments or a proposed change, marked in the source view.
type Range = { from: number; to: number; kind: 'thread' | 'proposal' | 'finding' };
const setMarks = StateEffect.define<Range[]>();
const MARK = {
  thread: Decoration.mark({ class: 'thread-mark' }),
  proposal: Decoration.mark({ class: 'proposal-mark' }),
  finding: Decoration.mark({ class: 'finding-mark' }),
};
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setMarks))
        set = Decoration.set(
          e.value
            .filter((r) => r.to <= tr.newDoc.length)
            .map((r) => MARK[r.kind].range(r.from, r.to)),
          true,
        );
    return set;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Must match TEXT in packages/server/src/sync.ts.
const TEXT = 'source';
// Must match the reason apps/sync/src/server.ts gives when it closes a file.
const NO_ACCESS = 'no-access';
/** The sync server's word for an edit it will not take for its size. */
const TOO_LARGE = 'too-large';
/** Its word for closing a connection whose person has sent too many edits lately. */
const OVER_BUDGET = 'over-budget';
/** Its word for closing a connection that sent more presence (names, cursors) than it reads. */
const PRESENCE_TOO_LARGE = 'presence-too-large';
/** Its word for a person who has this file open in too many windows already. Not final. */
const TOO_MANY = 'too-many';
/** The longest name shown, and sent: the sync server keeps no more of one. */
const NAME_MAX = 80;
/** How long to wait before connecting again after that: the budget is given back as time goes. */
const PAUSE_MS = 10_000;
/** Its word, when a connection is turned away, for "not now" as against "no". */
const TRY_AGAIN = 'try-again';
/** Its word for closing a connection whose sign-in has ended. */
const SIGNED_OUT = 'signed-out';
// Presence colours, chosen to stay readable on white. People are told apart by name as well.
const COLOURS = ['#1f5fbf', '#8a4b00', '#1a7f55', '#9b2d86', '#b3261e', '#5b5bd6'];
const colourFor = (name: string) =>
  COLOURS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % COLOURS.length];

type Sync = {
  connected: boolean;
  loaded: boolean;
  /** This person has made changes that the server has not confirmed it holds. */
  unsaved: boolean;
  refused: boolean;
  /** The paper was restored while this person was offline with edits of their own. */
  held: boolean;
  /** The server would not take an edit for its size. Their unsaved edits cannot be kept. */
  tooLarge: boolean;
  /** The server is not taking edits from them for a moment, for how many they have sent. Kept. */
  paused: boolean;
  /** The server turned this window away: the person has the file open in too many. Kept until a connection holds. */
  crowded: boolean;
  /** Their sign-in has ended. The page waits for them to sign in again. */
  signedOut: boolean;
  /** Their role on the paper, if it is no longer the one this page was made for, and whether
   * with it they have lost the editing this page offers. */
  role: { now: string; lost: boolean } | null;
};
type Mode = 'visual' | 'source';
/** The sync server's answer to a structural edit. */
type Reply = { result?: CommandResult; update?: string; error?: string };
/** Its answer to "do you have all my changes?". */
type Saved = { n: number; saved: boolean };
/** What it says, unasked, of the person's role: on connecting, and when it changes. */
type Role = { role: string; canWrite: boolean };

const toBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

// Which view this person last chose, kept in this browser. Storage can be shut (private
// windows, a setting): then nothing is remembered and nothing breaks.
const VIEW = 'paperweave.view';
const chosenView = (): Mode | null => {
  try {
    const v = localStorage.getItem(VIEW);
    return v === 'visual' || v === 'source' ? v : null;
  } catch {
    return null;
  }
};
const rememberView = (m: Mode) => {
  try {
    localStorage.setItem(VIEW, m);
  } catch {
    // Shut: nothing is remembered.
  }
};

/**
 * The source view in the new look: the mono face, the new look's colours, and three token colours
 * (a comment, a control sequence, a dollar sign). Only face and colour: no size, line height or
 * padding is set, so a line is as tall as in the classic look and the caret lands in the same
 * places. The token colours are variables (next/source.css), so the dark theme changes them there.
 */
const nextTokens = {
  comment: Decoration.mark({ class: 'pw-src-comment' }),
  command: Decoration.mark({ class: 'pw-src-command' }),
  math: Decoration.mark({ class: 'pw-src-math' }),
};
const nextDecorator = new MatchDecorator({
  // A comment to the end of the line, a control sequence (`\%` is one, so not a comment), `$`.
  regexp: /%.*|\\(?:[a-zA-Z@]+\*?|[^a-zA-Z@])|\$\$?/g,
  decoration: (m) =>
    m[0][0] === '%' ? nextTokens.comment : m[0][0] === '\\' ? nextTokens.command : nextTokens.math,
});
const nextTheme = [
  EditorView.theme({
    '&': { color: 'var(--foreground)', backgroundColor: 'var(--card)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)' },
    '.cm-gutters': {
      color: 'var(--muted-foreground)',
      backgroundColor: 'var(--background)',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--src-active-line)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
    '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
      { backgroundColor: 'var(--accent)' },
  }),
  ViewPlugin.fromClass(
    class {
      tokens: DecorationSet;
      constructor(view: EditorView) {
        this.tokens = nextDecorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.tokens = nextDecorator.updateDeco(u, this.tokens);
      }
    },
    { decorations: (v) => v.tokens },
  ),
];

/**
 * The source view's name, and an explicit tab stop, editable or not: a bare contenteditable reads
 * as tabIndex -1 to tools that check whether a scrolling region can be reached by keyboard.
 */
const sourceNamed = (path: string) =>
  EditorView.contentAttributes.of({ 'aria-label': `LaTeX source of ${path}`, tabindex: '0' });

/** A moment as the reader's clock shows it. */
const clock = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * One file, open for live editing. A .tex file has two views of the same text, visual and source;
 * anything else has the source view only.
 */
export default function FileEditor(props: {
  projectId: string;
  fileId: string;
  path: string;
  canWrite: boolean;
  /** Their role on the paper when the page was made. */
  role: string;
  user: string;
  syncUrl: string;
  /** Whether this file has a visual view at all. */
  visual: boolean;
  /** A file of definitions: its visual view shows it, but it is edited in source. */
  sourceOnly: boolean;
  /** The paper's own macros, so that formulas written with them are drawn as formulas. */
  macros: Record<string, string>;
  /** Environments the paper declares with \\newtheorem: prose in the visual view. */
  prose: string[];
  /** The paper's macros that only print words (\\newcommand{\\sys}{PaperWeave}), and what each prints. */
  words: Record<string, string>;
  /** Whether this person may comment, and the others on the paper, whom they can mention. */
  canComment: boolean;
  members: Member[];
  /** The paper's owner allows passages to be sent to a model for a review. */
  canReview: boolean;
}) {
  const { projectId, fileId, canWrite, user, syncUrl, sourceOnly } = props;
  // Read when the editors are made: the look does not change while a page is open.
  const nextLook = useLook() === 'next';
  const host = useRef<HTMLDivElement>(null);
  const visualHost = useRef<HTMLDivElement>(null);
  const live = useRef<{ view: EditorView; visual: Visual | null; undo: Y.UndoManager }>(null);
  const [mode, setMode] = useState<Mode>(props.visual && !sourceOnly ? 'visual' : 'source');
  const [note, setNote] = useState('');
  // The editors are made once; they read which view is showing from here.
  const modeNow = useRef(mode);
  modeNow.current = mode;
  /**
   * Put the caret on a place of this file: the clicked `word` on the line, or else how far along
   * the line (`share`), or else the line's start. Returns the line it went to. Set once the
   * editors exist.
   */
  const jump = useRef<(line: number, share?: number, word?: string) => number>((line) => line);
  /** The line the caret is on, and how far along it. */
  const placeNow = useRef<() => { line: number; share: number }>(() => ({ line: 1, share: 0 }));
  /** The selected stretch as two places that move with the text, and how to select one again. */
  const stretch = useRef<(orCaret?: boolean) => Stretch | null>(() => null);
  const showStretch = useRef<(from: string, to: string) => boolean>(() => false);
  /** Whether this connection has the file's text yet, and who is waiting for that (see `show`). */
  const synced = useRef({ yes: false, waiting: [] as (() => void)[] });
  /** Shows a stretch once the text is here: before then, where it stands cannot be told. */
  const show = (from: string, to: string) =>
    new Promise<boolean>((done) => {
      const go = () => done(showStretch.current(from, to));
      if (synced.current.yes) go();
      else synced.current.waiting.push(go);
    });
  /** Where a stretch stands in this copy of the text now, as fresh places and its words. */
  const standing = useRef<(from: string, to: string) => Stretch | null>(() => null);
  /** The file's threads as last read, and how to mark their stretches where they now stand. */
  const threadsNow = useRef<Thread[]>([]);
  const proposalsNow = useRef<Proposal[]>([]);
  const findingsNow = useRef<LanguageFinding[]>([]);
  /** Replace a stretch with other words through the server, if it still says what it said. */
  const changeText = useRef<
    (from: string, to: string, expected: string, replacement: string) => Promise<boolean>
  >(async () => false);
  const markThreads = useRef(() => {});
  const router = useRouter();
  /** Whether leaving this page now is fine, or the person agreed to lose what is unsaved. */
  const mayLeave = useRef<() => boolean>(() => true);
  // A double-click in the PDF asks for a line: of this file, or of another one of the paper.
  useEffect(
    () =>
      onShow('source', (place) => {
        if (place.fileId === fileId) return jump.current(place.line, place.share, place.word);
        // The place goes on with the person, in the browser; the address says only the line.
        if (mayLeave.current()) {
          carry(place);
          router.push(`/projects/${projectId}/files/${place.fileId}?line=${place.line}`);
        }
      }),
    [fileId, projectId, router],
  );
  // The paper's macros as they were when the page was made. Not a reason to rebuild the editors.
  const macros = useRef(props.macros);
  // The same for the paper's own theorem environments: a \\newtheorem added since shows raw until reload.
  const prose = useRef(props.prose);
  // And the macros that print words: one defined since shows as a command until reload.
  const words = useRef(props.words);
  /** A formula being edited or inserted, a reference being chosen, and the menu, when open. */
  const [formula, setFormula] = useState<FormulaRequest | null>(null);
  const [picker, setPicker] = useState<{ apply: FormulaRequest['apply'] } | null>(null);
  const [citing, setCiting] = useState<{ apply: FormulaRequest['apply'] } | null>(null);
  const [float, setFloat] = useState<FloatRequest | null>(null);
  const [heading, setHeading] = useState<HeadingRequest | null>(null);
  const [footnote, setFootnote] = useState<FootnoteRequest | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    top: number;
    edit?: { name: string; run(): void };
  } | null>(null);
  /** Start inserting something where the caret is. The place is fixed now, not when it is done. */
  const insertHere = (
    then: (apply: FormulaRequest['apply']) => void,
    block = false,
    formula = false,
  ) => {
    const apply = live.current?.visual?.insertion({ block, formula });
    if (apply) then(apply);
    else setNote('Put the caret in the text where it should go, then try again.');
  };
  const askEquation = () =>
    insertHere((apply) => setFormula({ src: '', place: 'inline', apply }), false, true);
  const askReference = () => insertHere((apply) => setPicker({ apply }));
  const askCitation = () => insertHere((apply) => setCiting({ apply }));
  const askFootnote = () => {
    const apply = live.current?.visual?.footnote();
    if (apply === 'heading')
      setNote('A footnote in a heading stops the build. Put the caret in the text below it.');
    else if (apply) setFootnote({ apply });
    else setNote('Put the caret in the text where it should go, then try again.');
  };
  const askFigure = () => insertHere((apply) => setFloat({ kind: 'figure', apply }), true);
  const askTable = () => insertHere((apply) => setFloat({ kind: 'table', apply }), true);
  const askHeading = () => {
    const apply = live.current?.visual?.heading();
    if (apply) setHeading({ apply });
    else setNote('Put the caret in a paragraph to add a heading.');
  };
  const askList = (ordered: boolean) => {
    const apply = live.current?.visual?.list(ordered);
    if (!apply) return setNote('Put the caret in a paragraph to add a list.');
    // Applied at once, with no window: the keyboard goes back to the text, in the new item.
    apply().then(
      (result) => {
        if (result === 'conflict') setNote('That text changed before the edit arrived. Try again.');
        live.current?.visual?.focus();
      },
      () => setNote('That edit could not be made. Check the connection and try again.'),
    );
  };
  // The editors are made once; what they call must be what this render means.
  const all = {
    equation: askEquation,
    reference: askReference,
    citation: askCitation,
    footnote: askFootnote,
    figure: askFigure,
    table: askTable,
    heading: askHeading,
    bulleted: () => askList(false),
    numbered: () => askList(true),
  };
  const asks = useRef(all);
  asks.current = all;
  // When a window closes, the keyboard goes back to the text. This runs after the window's own
  // effect has closed it, which is when the browser has handed focus back.
  const windowOpen = !!formula || !!picker || !!citing || !!float || !!heading || !!footnote;
  const hadWindow = useRef(false);
  useEffect(() => {
    if (hadWindow.current && !windowOpen && mode === 'visual') live.current?.visual?.focus();
    hadWindow.current = windowOpen;
  }, [windowOpen, mode]);
  // What the bibliography holds, so that citations can say what they cite. Read when the page
  // opens, and again after a citation window closes (an entry may have been added meanwhile).
  useEffect(() => {
    if (!props.visual || citing) return;
    let stop = false;
    void fetch(`/projects/${projectId}/citations`)
      .then((res) => (res.ok ? res.json() : null))
      .then((found: { entries: { key: string; description: string }[] } | null) => {
        if (stop || !found) return;
        const entries = Object.fromEntries(found.entries.map((e) => [e.key, e.description]));
        setBibliography({ entries, known: true });
      })
      .catch(() => {});
    return () => void (stop = true);
  }, [projectId, props.visual, citing]);
  useEffect(() => () => setBibliography({ entries: {}, known: false }), []);
  // Until the editors exist there is no selection to carry: a click just changes the view.
  const switchTo = useRef<(next: Mode) => void>(setMode);
  // Open in the view this person last chose. After the first draw, which the server made
  // without knowing it.
  useLayoutEffect(() => {
    if (props.visual && !sourceOnly && chosenView() === 'source') setMode('source');
  }, []); // once: later changes are the person's own
  const [sync, setSync] = useState<Sync>({
    connected: false,
    loaded: false,
    unsaved: false,
    refused: false,
    held: false,
    tooLarge: false,
    paused: false,
    crowded: false,
    signedOut: false,
    role: null,
  });
  const keepEdits = useRef(() => {});
  const discardEdits = useRef(() => {});
  const [others, setOthers] = useState<string[]>([]);
  // The paper was restored while this person had the file open: who did it, and to what. Kept
  // until they dismiss it; the status line goes on saying whether their own edits are saved.
  const [restore, setRestore] = useState<RestoreNote | null>(null);
  // The file is no longer served, and the paper's list of files says why: said in the same place.
  const [left, setLeft] = useState<Left | null>(null);
  // The file's name: the one the page was made with, until the list of files, asked for again
  // because someone renamed a file, has another for it. A page made later brings its own.
  const [renamed, setRenamed] = useState<{ made: string; path: string } | null>(null);
  const path = renamed?.made === props.path ? renamed.path : props.path;
  // The editors are made once; what they say on leaving reads the name from here.
  const pathNow = useRef(path);
  pathNow.current = path;
  const named = useRef(new Compartment());
  useEffect(
    () =>
      onFiles(projectId, (files) => {
        const now = files.find((f) => f.id === fileId)?.path;
        if (now) setRenamed({ made: props.path, path: now });
      }),
    [projectId, fileId, props.path],
  );
  useEffect(() => {
    // Both views are named after the file, for someone who cannot see the name above them.
    live.current?.view.dispatch({ effects: named.current.reconfigure(sourceNamed(path)) });
    live.current?.visual?.name(`${path}, visual editor`);
    // The tab's title begins with the name the page was made with.
    const title = `${props.path} · `;
    if (path !== props.path && document.title.startsWith(title))
      document.title = `${path} · ${document.title.slice(title.length)}`;
  }, [path, props.path]);

  useEffect(() => {
    const doc = new Y.Doc();
    const text = doc.getText(TEXT);
    const update = (change: Partial<Sync>) => setSync((s) => ({ ...s, ...change }));
    const provider = new HocuspocusProvider({
      url: syncUrl,
      name: fileId,
      document: doc,
      // After a failed attempt to connect the library waits longer before each next one, up
      // to half a minute. Five seconds at most here: when a service that was away comes back,
      // what was typed meanwhile should not wait half a minute more to be saved. (The library
      // hands everything here on to the connection it makes; its types for this do not say so.)
      ...({ maxDelay: 5000 } as object),
      // Asked for on every connection attempt: a ticket only lives for a minute.
      token: async () => {
        // Their unsaved edits hold one the server will not take: connecting would send it again.
        // Nothing is asked of the server until they are discarded.
        if (oversized) throw new Error('held until the person discards them');
        // A ticket that cannot be fetched is the network or the server having a bad moment, not
        // a refusal: the attempt ends here and another is made shortly.
        // Ten seconds at most: a request that never answers would otherwise hold the attempt for good.
        const res = await fetch(`/api/sync-ticket?file=${fileId}`, {
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        const answer = res?.ok ? await res.json().catch(() => null) : null;
        // Signed out is not a refusal either: their sign-in ran out, or they signed out in
        // another tab. What they have typed stays here, and the page goes on asking, so that it
        // carries on once they have signed in again.
        const signedOut = res?.status === 401;
        update({ signedOut });
        if (!answer) {
          stumbled = true;
          throw new Error(signedOut ? 'signed out' : 'no ticket this time');
        }
        // Someone else has signed in on this browser. This page, and whatever is unsaved in
        // it, is not theirs: an empty ticket is refused, and the editor stops.
        if (answer.user !== user) return '';
        const { ticket, restored } = answer;
        const note: RestoreNote | null = answer.restore ?? null;
        // Coming back online to a paper that was restored meanwhile: this person's unsent edits
        // were made to text that is no longer there. They are held until the person decides.
        // `null` is not a restore: the file is gone or this person has lost access. The ticket is
        // returned, and the sync server refuses it, which locks the editor (see refuse).
        if (
          restored != null &&
          restoreSeen !== null &&
          restored !== restoreSeen &&
          saving.unsaved
        ) {
          restoreHeld = restored;
          if (note) setRestore(note);
          update({ held: true });
          setLocked(true);
          // Thrown, not sent: the connection attempt ends here, without bothering the server.
          throw new Error('held until the person decides');
        }
        // Only offered: it counts as seen once this connection has synced. If the attempt dies
        // first, edits typed meanwhile are still held back from the restored text.
        if (restored != null) {
          restoreOffered = restored;
          offeredNote = note;
        }
        return ticket ?? '';
      },
      onSynced: () => {
        // Back from being away to a paper that was restored meanwhile, with nothing of their own
        // unsent: the text in front of them has changed all the same, and they are told.
        if (offeredNote && isNews(offeredNote.number, restoreSeen)) setRestore(offeredNote);
        restoreSeen = Math.max(restoreSeen ?? 0, restoreOffered ?? 0);
        // Synced with nothing unsent: a pause that was for the reconnect's own payload (what an
        // idle tab sends when it connects) is over. With edits unsent, the saved-check ends it.
        setSync((s) => ({ ...s, loaded: true, paused: s.unsaved ? s.paused : false }));
        synced.current.yes = true;
        // A moment later, once the editors have taken the text in: shown at once, the selection
        // is made over a view that has not caught up.
        for (const go of synced.current.waiting.splice(0)) setTimeout(go, 0);
        // Let in. The server may still close a connection that came too late, a moment after
        // it has synced, so "too many windows" is taken down only once this one has held.
        if (admitting) clearTimeout(admitting);
        const held = setTimeout(() => {
          admitting = null;
          pending.delete(held);
          setSync((s) => (s.crowded ? { ...s, crowded: false } : s));
        }, 2000);
        admitting = held;
        pending.add(held);
        // Arrived from a place in the PDF: go to the line it named, once, now that there is text.
        const line = Number(new URLSearchParams(location.search).get('line'));
        if (line && !arrived) {
          const came = taken(fileId);
          const same = came && came.line === line ? came : null;
          setTimeout(() => jump.current(line, same?.share, same?.word), 0);
        }
        // The file is here: it can be typed in. (Not again on a later reconnect: by then
        // something else may be holding the editor shut.)
        if (!arrived) setLocked(false);
        // Back from being away: files may have been added, removed or renamed meanwhile.
        else void refreshFiles(projectId, user);
        arrived = true;
        // Back in touch: find out whether what was typed meanwhile has arrived.
        saving.reconnected();
      },
      onAuthenticationFailed: ({ reason }) => {
        if (restoreHeld !== null || oversized) return;
        // Too many windows: not a refusal of the person, which is final. Tried again later.
        if (reason === TOO_MANY) return crowd();
        // "Try again" is the server saying it could not find out yet whether this person may
        // open the file, not that they may not: its database did not answer.
        if (!stumbled && reason !== TRY_AGAIN) return refuse();
        stumbled = false;
        // Closing the connection is what makes the next attempt: see onStatus.
        setTimeout(() => {
          if (wantOpen) provider.configuration.websocketProvider.disconnect();
        }, 1000);
      },
      onStateless: ({ payload }) => {
        const reply:
          | (Reply & { key: string })
          | Saved
          | Role
          | { files: true }
          | { restored: number; restore?: RestoreNote } = JSON.parse(payload);
        if ('role' in reply) return roleIs(reply);
        // A file was added, removed or renamed: the list beside the text, and this file's name.
        if ('files' in reply) return void refreshFiles(projectId, user);
        // A restore made while this tab is connected arrives as ordinary edits; this says it was one.
        if ('restored' in reply) {
          // Said to the person too, unless this is a restore the editor already knew of (the
          // button pressed twice; the server's listener catching up).
          if (reply.restore && isNews(reply.restored, restoreSeen)) setRestore(reply.restore);
          restoreSeen = Math.max(restoreSeen ?? 0, reply.restored);
          // A restore brings files back, takes files out and gives files the names they had.
          void refreshFiles(projectId, user);
          return;
        }
        if ('saved' in reply) return saving.answered(reply);
        waiting.get(reply.key)?.(reply);
      },
      // The server closes a file it will no longer serve: access was taken away, or it was deleted.
      // Or it will not take an edit for its size, which a message larger than it reads at all
      // (code 1009) is too. Sent again it would be refused again, so the editor stops.
      onClose: ({ event }) => {
        if (event.reason === NO_ACCESS) return refuse();
        // The sign-in this was opened under has ended, and the server has stopped serving it.
        // Closing the connection is what makes the next attempt (see onStatus), which asks for
        // a ticket and finds out whether this person is still signed in.
        if (event.reason === SIGNED_OUT) {
          if (wantOpen) provider.configuration.websocketProvider.disconnect();
          return;
        }
        // Too many edits lately: not final. What was typed is kept and sent again, but not at
        // once, which would be refused again. The library leaves the socket open after a close
        // message and does not connect again by itself: this closes it and connects later.
        // The same wait after presence that was too large: nothing here sends that, so it is
        // not retried at once, and edits are not said to be paused.
        if (event.reason === OVER_BUDGET || event.reason === PRESENCE_TOO_LARGE) {
          if (event.reason === OVER_BUDGET) update({ paused: true });
          connectLater();
          return;
        }
        // Closed after it was let in, because other windows of this person came first.
        if (event.reason === TOO_MANY) return crowd();
        if (event.reason !== TOO_LARGE && event.code !== 1009) return;
        oversized = true;
        update({ tooLarge: true });
        setLocked(true);
      },
    });
    // Listened for once the provider exists, not handed to it as it is made. The library says
    // "connecting" while it is still being made; this handler then reached for a provider that
    // was not there yet and failed, and the library took that for a failed attempt to connect.
    // A second later it dropped the connection, which was working, and made another. Whatever
    // the server answered in that moment went nowhere.
    let connectedNow = false;
    provider.on('authenticated', () => {
      connectedNow = true;
      update({ connected: true });
    });
    provider.on('status', ({ status }: { status: string }) => {
      // "Connected" is said when the socket opens, before the ticket has been fetched and the
      // server has accepted it: that is `authenticated`, below.
      if (status !== 'connected') {
        connectedNow = false;
        update({ connected: false });
      }
      // The library ignores a request to connect made while a disconnect is still closing,
      // and then stays down. So whenever the connection has closed and this tab should be
      // connected, and the library is not going to try by itself, ask again.
      const socket = provider.configuration.websocketProvider;
      if (status === 'disconnected' && wantOpen && !pausing && !socket.shouldConnect)
        void socket.connect();
    });
    let arrived = false;
    // Whether this person's changes are saved is asked of the server, not inferred: "do you hold
    // every insert and delete I have made?". The sync library's own count of confirmations
    // reaches zero too early after a reconnect.
    let lastChange = 0;
    const saving = watchSaved(doc, {
      send: (question) => provider.sendStateless(question),
      ready: () => provider.synced,
      say: (unsaved) => {
        if (unsaved) lastChange = Date.now();
        // Everything is held by the server again: the pause, if there was one, is over.
        update(unsaved ? { unsaved } : { unsaved, paused: false });
        // The build pane builds soon after this editor's edits are saved and it has gone quiet.
        setTyping(unsaved);
      },
    });
    /** The paper's newest restore when this tab last connected, and one found since, if held. */
    let restoreSeen: number | null = null;
    /** The newest restore the last ticket named: seen only once the connection has synced. */
    let restoreOffered: number | null = null;
    let offeredNote: RestoreNote | null = null;
    let restoreHeld: number | null = null;
    /** Whether this tab should be connected: false only while the browser says it is offline. */
    let wantOpen = true;
    /** The last attempt to connect ended because no ticket could be fetched. */
    let stumbled = false;
    /** The server refused an edit for its size. */
    let oversized = false;
    /** The wait, if any, before connecting again after "too many edits". */
    let pausing: ReturnType<typeof setTimeout> | null = null;
    /** Close the socket, which the library leaves open, and connect again after PAUSE_MS. */
    const connectLater = () => {
      provider.configuration.websocketProvider.disconnect();
      if (pausing) clearTimeout(pausing);
      const wait = setTimeout(() => {
        pausing = null;
        pending.delete(wait);
        if (wantOpen) void provider.configuration.websocketProvider.connect();
      }, PAUSE_MS);
      pausing = wait;
      pending.add(wait);
    };
    /** The wait before it is known whether this window can connect. Said once, not on each try. */
    let admitting: ReturnType<typeof setTimeout> | null = null;
    const crowd = () => {
      // A connection that was let in and synced before it was closed must not clear this.
      if (admitting) clearTimeout(admitting);
      update({ crowded: true });
      connectLater();
    };
    const awareness = provider.awareness!;
    awareness.setLocalStateField('user', {
      name: user.slice(0, NAME_MAX),
      color: colourFor(user),
      colorLight: colourFor(user) + '33',
    });
    const seen = () =>
      setOthers(
        [...awareness.getStates()]
          .filter(([id]) => id !== doc.clientID)
          .map(([, s]) => s.user?.name)
          .filter((n): n is string => typeof n === 'string')
          // From other people's browsers: cut, as in the visual view's carets.
          .map((n) => n.slice(0, NAME_MAX)),
      );
    awareness.on('change', () => {
      seen();
      live.current?.visual?.redrawCarets();
    });

    // One undo history per person, for both views: undo never takes back someone else's edit.
    const undo = new Y.UndoManager(text);
    const writable = new Compartment();
    // The text is always a tab stop (see its contentAttributes below), so locked it still
    // takes the keyboard: someone who cannot edit can scroll it, move through it and select
    // from it with keys alone.
    const lock = (on: boolean) => [EditorState.readOnly.of(on), EditorView.editable.of(!on)];
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        extensions: [
          EditorView.cspNonce.of(pageNonce()),
          EditorView.domEventHandlers({
            // LaTeX copied from the visual view goes in as it is: `<` as \textless{}, a formula
            // as its source. Anything else is pasted as the browser would.
            paste: (e, v) => {
              const latex = e.clipboardData?.getData(LATEX_TYPE) ?? '';
              if (!latex || v.state.readOnly || !pasteable(latex)) return false;
              e.preventDefault();
              v.dispatch(v.state.replaceSelection(latex), {
                scrollIntoView: true,
                userEvent: 'input.paste',
              });
              return true;
            },
            drop: (e) => {
              if (!e.dataTransfer?.files.length) return false; // dragged text goes in as before
              e.preventDefault();
              setNote(
                'A picture or file cannot be dropped into the text. Add it to the paper on its page.',
              );
              return true;
            },
          }),
          lineNumbers(),
          ...(nextLook ? nextTheme : []),
          // Spaces and zero-width characters that pdfLaTeX stops at are shown as a red dot, with
          // their code on hover. U+00A0, U+200C, U+200D and U+3000 build and are left alone.
          highlightSpecialChars({
            addSpecialChars: /[\u2000-\u200a\u202f\u205f\u202a-\u202c\u2060\u2068]/g,
            render: (code, _desc, placeholder) => {
              const span = document.createElement('span');
              const name = `Invisible character U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
              span.className = 'cm-specialChar';
              span.textContent = placeholder;
              span.title = name;
              span.setAttribute('aria-label', name);
              return span;
            },
          }),
          EditorView.lineWrapping,
          named.current.of(sourceNamed(pathNow.current)),
          // Shut until the file has arrived. Typed into an editor still empty, words would
          // land at the top of the file, wherever the caret was meant to be.
          writable.of(lock(true)),
          // Find and replace, drawn at the foot of the editor. Only these four keys, not the whole
          // searchKeymap, which also takes Ctrl+D, Ctrl+Alt+G and Ctrl+Shift+L.
          search(),
          EditorState.phrases.of({
            Find: 'Find',
            Replace: 'Replace',
            next: 'Next',
            previous: 'Previous',
            all: 'All',
            'match case': 'Match case',
            regexp: 'Regular expression',
            'by word': 'Whole word',
            replace: 'Replace',
            'replace all': 'Replace all',
            close: 'Close',
          }),
          keymap.of([
            {
              key: 'Mod-f',
              run: openSearchPanel,
              scope: 'editor search-panel',
              preventDefault: true,
            },
            {
              key: 'F3',
              run: findNext,
              shift: findPrevious,
              scope: 'editor search-panel',
              preventDefault: true,
            },
            {
              key: 'Mod-g',
              run: findNext,
              shift: findPrevious,
              scope: 'editor search-panel',
              preventDefault: true,
            },
            { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
          ]),
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          yCollab(text, awareness, { undoManager: undo }),
          marks,
        ],
      }),
    });

    // A structural edit is checked and made by the server, against the text everyone shares.
    // It is asked for over the live connection, and the answer carries the edit.
    const waiting = new Map<string, (reply: Reply) => void>();
    // Every interval and timer still pending, so that none outlives the provider.
    const pending = new Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();
    const send = (message: string) => {
      try {
        provider.sendStateless(message);
      } catch {
        // Not connected just now: asked again in a few seconds.
      }
    };
    const run = (c: Command) =>
      new Promise<CommandResult>((resolve, reject) => {
        const place = (p: Y.RelativePosition) => toBase64(Y.encodeRelativePosition(p));
        const asked = JSON.stringify({ ...c, from: place(c.from), to: place(c.to) });
        // An answer can be lost with a connection. Asked again, under the same key, the server
        // makes the edit if it has not, and says so if it has: never twice. So this keeps
        // asking, and never says the edit failed while it may still be made.
        const again = setInterval(() => send(asked), 3000);
        let late = false;
        const slow = setTimeout(() => {
          late = true;
          setNote(
            'No answer yet to that change. Still trying: it will be made once, so do not make it again.',
          );
        }, 8000);
        pending.add(again);
        pending.add(slow);
        waiting.set(c.key, (reply) => {
          clearInterval(again);
          clearTimeout(slow);
          pending.delete(again);
          pending.delete(slow);
          waiting.delete(c.key);
          // A late answer says so; one that is not "made" leaves the saying to whoever asked.
          if (late)
            setNote(
              reply.result === 'applied' || reply.result === 'duplicate'
                ? 'That change has now been made.'
                : '',
            );
          if (!reply.result) return reject(new Error(reply.error));
          if (reply.update) {
            // Applied here as this person's own edit, and as an undo step of its own. The same
            // edit then arrives like anyone else's, and changes nothing more.
            undo.stopCapturing();
            Y.applyUpdate(doc, fromBase64(reply.update), visual!.bridge);
            undo.stopCapturing();
          }
          resolve(reply.result);
        });
        send(asked);
      });
    const visual: Visual | null = props.visual
      ? createVisual({
          element: visualHost.current!,
          ytext: text,
          undo,
          label: `${pathNow.current}, visual editor`,
          sourceOnly,
          editable: canWrite,
          say: setNote,
          showInSource: (from, to) => show('source', from, to),
          run,
          macros: macros.current,
          prose: prose.current,
          words: words.current,
          picture: (target) =>
            `/projects/${projectId}/picture?target=${encodeURIComponent(target)}`,
          editMath: (src, apply) => setFormula({ src, place: null, apply }),
          editAtom: (what, src, apply) => setFormula({ src, place: null, what, apply }),
          ask: (what) => asks.current[what](),
          menu: setMenu,
          // The source editor publishes the caret only while it has focus; this is the same
          // field, from the visual view.
          moved: (a, h) => {
            const cursor = awareness.getLocalState()?.cursor;
            const anchor = Y.createRelativePositionFromTypeIndex(text, a);
            const head = Y.createRelativePositionFromTypeIndex(text, h);
            if (
              cursor?.anchor &&
              cursor.head &&
              Y.compareRelativePositions(Y.createRelativePositionFromJSON(cursor.anchor), anchor) &&
              Y.compareRelativePositions(Y.createRelativePositionFromJSON(cursor.head), head)
            )
              return;
            awareness.setLocalStateField('cursor', {
              anchor: Y.relativePositionToJSON(anchor),
              head: Y.relativePositionToJSON(head),
            });
          },
          carets: () =>
            [...awareness.getStates()].flatMap(([id, s]) => {
              if (id === doc.clientID || !s.cursor?.anchor || !s.cursor.head) return [];
              try {
                const at = (r: unknown) => {
                  const p = Y.createAbsolutePositionFromRelativePosition(
                    Y.createRelativePositionFromJSON(r),
                    doc,
                  );
                  return p && p.type === text ? p.index : null;
                };
                const [a, h] = [at(s.cursor.anchor), at(s.cursor.head)];
                if (a == null || h == null) return [];
                // Names and colours come from the other person's browser: unverified.
                const name = typeof s.user?.name === 'string' ? s.user.name.slice(0, NAME_MAX) : '';
                const color =
                  typeof s.user?.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.user.color)
                    ? s.user.color
                    : COLOURS[0];
                return [{ from: Math.min(a, h), to: Math.max(a, h), head: h, name, color }];
              } catch {
                return [];
              }
            }),
        })
      : null;
    // Like the source view, shut until the file has arrived.
    visual?.editor.setEditable(false);
    live.current = { view, visual, undo };

    /** Switch views, carrying the selection across. */
    const show = (next: Mode, from?: number, to?: number) => {
      if (!visual) return;
      if (next === 'source') {
        const sel = visual.editor.state.selection;
        const [a, b] = [from ?? sel.from, to ?? sel.to];
        const anchor = visual.toSource(a, a === b ? -1 : 1);
        const head = visual.toSource(b, -1);
        // The source view must be on screen before it can scroll to the selection.
        flushSync(() => setMode('source'));
        view.requestMeasure();
        view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
        view.focus();
      } else {
        const sel = view.state.selection.main;
        flushSync(() => setMode('visual'));
        visual.select(sel.from, sel.to);
      }
    };
    switchTo.current = show;
    jump.current = (line, share, word) => {
      const lines = view.state.doc;
      const asked = Math.max(1, Math.min(Math.floor(line), lines.lines));
      // The word as typed on a line, if it is there whole (a place, not a word, is no hit).
      const found = (n: number, along?: number) => {
        const at = lines.line(n);
        const hit = word ? wordAt(at.text, word, along) : null;
        return hit && hit.to > hit.from ? { from: at.from + hit.from, to: at.from + hit.to } : null;
      };
      let used = asked;
      let range = found(asked, share);
      // A word at the start or end of a line of the PDF may have been typed on a neighbouring
      // line of a hard-wrapped paragraph: the one below first, then the one above.
      if (!range && word)
        for (const [n, along] of [
          [asked + 1, undefined],
          [asked - 1, 1],
        ] as const)
          if (n >= 1 && n <= lines.lines && (range = found(n, along))) {
            used = n;
            break;
          }
      const at = lines.line(used);
      if (!range && share !== undefined) {
        // Not a word: the start of the word nearest to how far along the line it was.
        const near = wordAt(at.text, undefined, share);
        if (near) range = { from: at.from + near.from, to: at.from + near.to };
      }
      // Otherwise the first thing written on the line, past its indentation.
      const start = at.from + (at.text.length - at.text.trimStart().length);
      const { from, to } = range ?? { from: start, to: start };
      if (visual && modeNow.current === 'visual') visual.select(from, to);
      else {
        view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
        view.focus();
      }
      return used;
    };
    stretch.current = (orCaret = false) => {
      const inVisual = visual && modeNow.current === 'visual';
      if (inVisual) visual.catchUp();
      const sel = inVisual ? visual.editor.state.selection : view.state.selection.main;
      const [from, to] = inVisual
        ? [visual.toSource(sel.from, 1), visual.toSource(sel.to, -1)]
        : [sel.from, sel.to];
      // With nothing selected there is only a place: enough for proposing to add text there.
      if (to < from || (to === from && !orCaret)) return null;
      // The start holds on to the character after it and the end to the one before it, so text
      // typed against either end stays outside.
      const place = (index: number, side: number) =>
        toBase64(
          Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, side)),
        );
      return { from: place(from, 0), to: place(to, -1), words: text.toString().slice(from, to) };
    };
    const whereIs = (encoded: string) =>
      Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(fromBase64(encoded)),
        doc,
      )?.index ?? -1;
    markThreads.current = () => {
      const open = [
        ...threadsNow.current.map((t) => ({ ...t, kind: 'thread' as const })),
        ...proposalsNow.current.map((p) => ({ ...p, kind: 'proposal' as const })),
        ...findingsNow.current.map((f) => ({ ...f, kind: 'finding' as const, status: 'open' })),
      ];
      const ranges = open.flatMap((x) => {
        const [from, to] = [whereIs(x.from), whereIs(x.to)];
        return x.status === 'open' && from >= 0 && to > from ? [{ from, to, kind: x.kind }] : [];
      });
      view.dispatch({ effects: setMarks.of(ranges) });
      visual?.setMarks(ranges);
    };
    changeText.current = async (a, b, expected, replacement) => {
      const place = (encoded: string) => Y.decodeRelativePosition(fromBase64(encoded));
      const done = await run({
        key: crypto.randomUUID(),
        from: place(a),
        to: place(b),
        expected,
        replacement,
      }).catch(() => 'conflict' as const);
      return done !== 'conflict';
    };
    // The stretches move as the text does. Marked again once every view has caught up with it.
    const remark = () => queueMicrotask(() => markThreads.current());
    text.observe(remark);
    showStretch.current = (a, b) => {
      const [from, to] = [whereIs(a), whereIs(b)];
      if (from < 0 || to < from) return false;
      if (visual && modeNow.current === 'visual') visual.select(from, to);
      else {
        view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
        view.focus();
      }
      return true;
    };
    // Yjs undo writes deleted characters again as new ones, and follows the old ones to them in
    // memory: this copy is the only one that knows where the words stand.
    standing.current = (a, b) => {
      const [from, to] = [whereIs(a), whereIs(b)];
      if (from < 0 || to <= from) return null;
      const place = (index: number, side: number) =>
        toBase64(
          Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, side)),
        );
      return { from: place(from, 0), to: place(to, -1), words: text.toString().slice(from, to) };
    };
    placeNow.current = () => {
      if (visual && modeNow.current === 'visual') visual.catchUp();
      const head =
        visual && modeNow.current === 'visual'
          ? visual.toSource(visual.editor.state.selection.head, -1)
          : view.state.selection.main.head;
      const at = view.state.doc.lineAt(head);
      return { line: at.number, share: at.length ? (head - at.from) / at.length : 0 };
    };

    const setLocked = (on: boolean) => {
      view.dispatch({ effects: writable.reconfigure(lock(on || !canWrite)) });
      // Someone who cannot edit still gets a caret to select with (to comment or propose); the
      // visual view itself refuses their changes. A writer who is locked stays shut.
      visual?.editor.setEditable(!on);
    };
    // Typing into a file that is no longer served would go nowhere, so it stops.
    let gone = false;
    const refuse = () => {
      gone = true;
      update({ refused: true });
      setLocked(true);
      // Why, if the paper's list of files says: the file is not in it any more (deleted, or
      // taken out by a restore), or the list is no longer this person's to see.
      void refreshFiles(projectId, user, fileId).then((listing) => {
        if (listing !== undefined) setLeft(whyGone(listing, fileId));
      });
    };
    // The server says what this person's role is when the editor connects and whenever it
    // changes. This page shows what they could do when it loaded. If they can no longer edit,
    // typing would go nowhere, so it stops. Anything else that has changed needs the page
    // loaded again, and the status says so.
    let lowered = false;
    const roleIs = ({ role, canWrite: may }: Role) => {
      const lost = canWrite && !may;
      update({ role: role === props.role ? null : { now: role, lost } });
      if (lost) setLocked(true);
      // Given back what they had: open again, unless something else is holding it shut.
      else if (lowered && arrived && !gone && !oversized && restoreHeld === null) setLocked(false);
      lowered = lost;
    };
    // "Apply my edits": connect again, and the held edits merge into the restored text.
    // "Discard my edits": a fresh page starts from the server's text, without the held edits.
    discardEdits.current = () => {
      discarding = true;
      location.reload();
    };
    keepEdits.current = () => {
      restoreSeen = restoreHeld;
      restoreHeld = null;
      update({ held: false });
      setLocked(false);
      // A fresh connection, made once this one has closed.
      socket.disconnect();
    };

    // Closing the tab with edits the server has not confirmed would lose them.
    let discarding = false;
    // A link or a jump to another file does not reach beforeunload: the page is swapped in the
    // browser and this editor, with the only copy of what the server lacks, is thrown away.
    let agreed = 0;
    const risky = () =>
      !discarding &&
      atRisk({
        unsaved: saving.unsaved,
        connected: connectedNow,
        sinceChange: Date.now() - lastChange,
      });
    mayLeave.current = () => {
      if (!risky()) return true;
      if (!window.confirm(LEAVE(pathNow.current))) return false;
      agreed = Date.now();
      return true;
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || e.defaultPrevented) return;
      const link = { href: a.href, target: a.target, download: a.hasAttribute('download') };
      if (leavesPage(e, link, location.href) && !mayLeave.current()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('click', onClick, true);
    // Back and Forward to another page of the app swap the page in the browser too. By the time
    // the browser says so it has moved and cannot be refused, but the router has not yet acted,
    // and this is asked before it (see WENT in app/layout.tsx). The person is asked as for a
    // link. Leaving lets the router have the event. Staying keeps it from the router, which
    // never knows, and steps the history back to this page.
    let here = place();
    let returning = false;
    const went = (e: PopStateEvent) => {
      const back = returning && samePage(location.href, here.href);
      returning = false;
      if (back) {
        // The step back that staying made.
        e.stopImmediatePropagation();
      } else if (samePage(location.href, here.href)) {
        here = place();
      } else if (risky()) {
        if (window.confirm(LEAVE(pathNow.current))) {
          agreed = Date.now();
          return;
        }
        e.stopImmediatePropagation();
        const steps = stepsBack(here.index, place().index);
        if (steps) {
          returning = true;
          history.go(steps);
        } else {
          // A browser that does not say where in its history it is: this page is put after the
          // one arrived at, which after Back is where it was.
          history.pushState(here.state, '', here.href);
        }
      }
    };
    wentTo(went);
    const warn = (e: BeforeUnloadEvent) => {
      // Not again straight after the person has said to leave.
      if (saving.unsaved && !discarding && Date.now() - agreed > 10_000) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    // An open socket can sit silent for a long time after the network goes. When the browser
    // says it is offline, say so at once, and reconnect the moment it is back.
    const socket = provider.configuration.websocketProvider;
    const offline = () => {
      wantOpen = false;
      connectedNow = false;
      // Said at once. With the network gone the socket can take many seconds to report that it
      // has closed, and until then the status would go on saying everything is saved.
      update({ connected: false });
      socket.disconnect();
    };
    const online = () => {
      wantOpen = true;
      void socket.connect();
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('click', onClick, true);
      wentTo(went, false);
      mayLeave.current = () => true;
      // A stretch still waiting to be marked has no view to be marked in.
      markThreads.current = () => {};
      for (const t of pending) {
        clearTimeout(t);
        clearInterval(t);
      }
      pending.clear();
      waiting.clear();
      // The awareness listener reaches the editor through this; provider.destroy() below fires it.
      live.current = null;
      saving.destroy();
      visual?.destroy();
      view.destroy();
      undo.destroy();
      provider.destroy();
      doc.destroy();
    };
    // The editor is rebuilt only when a different file is opened.
  }, [projectId, fileId, canWrite, user, syncUrl, props.visual, sourceOnly]);

  const status = sync.refused
    ? `You no longer have access to this file, or it has been deleted.${sync.unsaved ? ' What you typed here was not saved. Copy what you need from it.' : ''}`
    : sync.tooLarge
      ? 'An edit of yours is too large to save, so your unsaved edits cannot be kept. Copy what you need from them, then discard them. To add a large file to the paper, upload it.'
      : sync.held
        ? 'This paper was restored to an earlier revision while you were offline. Your edits from before that are not saved.'
        : sync.signedOut
          ? `You are signed out. Sign in again in another tab and this page will carry on. ${sync.unsaved ? 'Your edits are kept here until then.' : ''}`.trim()
          : sync.role
            ? `You are now ${/^[aeiou]/.test(sync.role.now) ? 'an' : 'a'} ${sync.role.now} on this paper${sync.role.lost ? ` and can no longer edit. ${sync.unsaved ? 'What you typed last was not saved. ' : ''}` : '. '}Reload the page to carry on.`
            : sync.crowded
              ? 'This file is open in too many of your windows. Close one and this one will connect by itself.'
              : sync.paused
                ? 'Saving is paused for a moment: too many edits at once. Your edits are kept and will be saved.'
                : !sync.loaded
                  ? 'Opening…'
                  : !sync.connected
                    ? `Offline. ${sync.unsaved ? 'Your edits are waiting to be saved.' : 'Nothing is waiting to be saved.'}`
                    : !canWrite
                      ? 'Read only. You can read along but not edit.'
                      : sync.unsaved
                        ? 'Saving your edits…'
                        : 'All edits saved.';
  // The restore a note is about: the one that took this file out, or the one made under it.
  const about = left ? (left.why === 'restore' ? left.restore : null) : restore;
  const changes = about && restoreChanges(projectId, about);
  return (
    <section aria-label={`Editor for ${path}`}>
      <div className="editor-bar">
        <code>{path}</code>
        <span role="status" aria-live="polite" data-state={sync.connected ? 'online' : 'offline'}>
          {status}
        </span>
        {sync.role && !sync.refused && !sync.tooLarge && !sync.held && (
          <button type="button" onClick={() => location.reload()}>
            Reload the page
          </button>
        )}
        {sync.signedOut && !sync.refused && (
          <a href="/sign-in" target="_blank" rel="noreferrer">
            Sign in (opens a new tab)
          </a>
        )}
        {(sync.held || sync.tooLarge) && (
          <span role="group" aria-label="Your unsaved edits">
            {sync.held && !sync.tooLarge && (
              <button type="button" onClick={() => keepEdits.current()}>
                Apply my edits to the restored paper
              </button>
            )}
            <button type="button" onClick={() => discardEdits.current()}>
              Discard my edits
            </button>
          </span>
        )}
        <span>
          {others.length ? `Also here: ${[...new Set(others)].join(', ')}` : 'Nobody else is here.'}
        </span>
      </div>
      {props.visual && (
        <Toolbar label="Editor tools">
          <span role="group" aria-label="View">
            {(['visual', 'source'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => {
                  rememberView(m);
                  if (mode !== m) switchTo.current(m);
                }}
              >
                {m === 'visual' ? 'Visual' : 'Source'}
              </button>
            ))}
          </span>
          {mode === 'visual' && canWrite && !sync.refused && (
            <span role="group" aria-label="Edit">
              <Tool name="Emphasise" icon={Italic} onClick={() => live.current?.visual?.emph()} />
              <Tool
                name="Bold"
                icon={Bold}
                onClick={() => live.current?.visual?.bold()}
                keys="Control+B Meta+B"
                shortcut="Ctrl+B"
              />
              <Tool name="Undo" icon={Undo2} onClick={() => live.current?.undo.undo()} />
              <Tool name="Redo" icon={Redo2} onClick={() => live.current?.undo.redo()} />
              <Tool
                name="Reference"
                icon={Link2}
                onClick={askReference}
                keys="Alt+R"
                shortcut="Alt+R"
              />
              <Tool
                name="Citation"
                icon={Quote}
                onClick={askCitation}
                keys="Alt+C"
                shortcut="Alt+C"
              />
              <Tool
                name="Equation"
                icon={Sigma}
                onClick={askEquation}
                keys="Alt+="
                shortcut="Alt+="
              />
              <Tool
                name="Footnote"
                icon={MessageSquareText}
                onClick={askFootnote}
                keys="Alt+O"
                shortcut="Alt+O"
              />
              <Tool
                name="Figure"
                icon={ImageIcon}
                onClick={askFigure}
                keys="Alt+G"
                shortcut="Alt+G"
              />
              <Tool name="Table" icon={Table2} onClick={askTable} keys="Alt+T" shortcut="Alt+T" />
              <Tool
                name="Heading"
                icon={Heading}
                onClick={askHeading}
                keys="Alt+H"
                shortcut="Alt+H"
              />
              <Tool
                name="Bulleted list"
                icon={List}
                onClick={() => askList(false)}
                keys="Alt+L"
                shortcut="Alt+L"
              />
              <Tool
                name="Numbered list"
                icon={ListOrdered}
                onClick={() => askList(true)}
                keys="Alt+N"
                shortcut="Alt+N"
              />
            </span>
          )}
          <span role="group" aria-label="Go to">
            {mode === 'source' && (
              <Tool
                name="Find and replace"
                icon={Search}
                onClick={() => live.current && openSearchPanel(live.current.view)}
                keys="Control+F Meta+F"
                shortcut="Ctrl+F"
              />
            )}
            <Tool
              name="Show in PDF"
              icon={FileSearch}
              onClick={() =>
                setNote(
                  showInPdf({ fileId, ...placeNow.current() })
                    ? ''
                    : 'There is no PDF to show it in yet.',
                )
              }
            />
          </span>
          <span className="note" aria-live="polite">
            {note}
          </span>
        </Toolbar>
      )}
      {/* Directly above the text, where the person is looking: the bar above may be scrolled away.
          Always there, so that a screen reader hears the words when they arrive. Not a second
          "status": the one in the bar stays the only one, and says whether edits are saved. */}
      <div className={restore || left ? 'editor-notice' : undefined}>
        <span aria-live="polite">
          {left
            ? goneWords(left, user, left.why === 'restore' ? clock(left.restore.at) : '')
            : restore && restoredWords(restore, user, clock(restore.at), sync.held)}
        </span>
        {(restore || left) && (
          <span role="group" aria-label={left ? 'About this file' : 'About the restore'}>
            {changes && (
              <a href={changes} target="_blank" rel="noreferrer">
                Show what the restore changed (opens a new tab)
              </a>
            )}
            {about && (
              <a href={restoreHistory(projectId, about)} target="_blank" rel="noreferrer">
                History of this paper (opens a new tab)
              </a>
            )}
            <button
              type="button"
              onClick={() => {
                setRestore(null);
                setLeft(null);
                // The button is gone: the keyboard goes back to the text.
                if (mode === 'visual') live.current?.visual?.focus();
                else live.current?.view.focus();
              }}
            >
              Dismiss
            </button>
          </span>
        )}
      </div>
      <div id="text" tabIndex={-1}>
        <div className="visual" ref={visualHost} hidden={mode !== 'visual'} />
        <FormulaBox request={formula} macros={macros.current} onDone={() => setFormula(null)} />
        <ReferencePicker request={picker} projectId={projectId} onDone={() => setPicker(null)} />
        <CitationPicker request={citing} projectId={projectId} onDone={() => setCiting(null)} />
        <FloatBox request={float} projectId={projectId} onDone={() => setFloat(null)} />
        <HeadingBox
          request={heading}
          onDone={(was) => setHeading((now) => (now === was ? null : now))}
        />
        <FootnoteBox
          request={footnote}
          onDone={(was) => setFootnote((now) => (now === was ? null : now))}
        />
        <EditorMenu
          at={menu}
          onClose={() => {
            setMenu(null);
            live.current?.visual?.focus();
          }}
          onReference={askReference}
          onCitation={askCitation}
          onFootnote={askFootnote}
          onEquation={askEquation}
          onFigure={askFigure}
          onTable={askTable}
          onHeading={askHeading}
          onBulleted={() => askList(false)}
          onNumbered={() => askList(true)}
        />
        <div className="source" ref={host} hidden={mode !== 'source'} />
      </div>
      <ReviewPanel>
        <Proposals
          projectId={projectId}
          fileId={fileId}
          canPropose={props.canComment}
          canDecide={canWrite}
          canReview={props.canReview}
          selection={() => stretch.current(true)}
          show={show}
          standing={(from, to) => standing.current(from, to)}
          onProposals={(list) => {
            proposalsNow.current = list;
            markThreads.current();
          }}
        />
        <Threads
          projectId={projectId}
          fileId={fileId}
          canComment={props.canComment}
          members={props.members}
          selection={() => stretch.current()}
          standing={(from, to) => standing.current(from, to)}
          onThreads={(list) => {
            threadsNow.current = list;
            markThreads.current();
          }}
          show={show}
        />
        {/* Last, and on purpose: the findings of a real file run to several screens, and what people
          say to each other must not lie under them. */}
        {props.visual && (
          <Language
            projectId={projectId}
            fileId={fileId}
            canWrite={canWrite && !sync.refused}
            canPropose={props.canComment}
            unsaved={!sync.loaded || sync.unsaved}
            change={(from, to, expected, replacement) =>
              changeText.current(from, to, expected, replacement)
            }
            show={show}
            onFindings={(list) => {
              findingsNow.current = list;
              markThreads.current();
            }}
          />
        )}
      </ReviewPanel>
    </section>
  );
}
