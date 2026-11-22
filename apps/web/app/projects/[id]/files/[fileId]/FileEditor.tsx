'use client';

import { defaultKeymap } from '@codemirror/commands';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from '@codemirror/view';
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
import { setBibliography } from '../../../../../lib/bibliography';
import { pageNonce } from '../../../../../lib/nonce';
import { onShow, showInPdf } from '../../../../../lib/pdfsync';
import { createVisual, type Visual } from '../../../../../lib/visual';
import type { LanguageFinding, Proposal, Thread } from '@paperweave/server';
import Language from './Language';
import Proposals from './Proposals';
import Toolbar from './Toolbar';
import Threads, { type Member, type Stretch } from './Threads';
import {
  CitationPicker,
  EditorMenu,
  FloatBox,
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
  /** Whether this person may comment, and the others on the paper, whom they can mention. */
  canComment: boolean;
  members: Member[];
  /** The paper's owner allows passages to be sent to a model for a review. */
  canReview: boolean;
}) {
  const { projectId, fileId, canWrite, user, syncUrl, sourceOnly } = props;
  const host = useRef<HTMLDivElement>(null);
  const visualHost = useRef<HTMLDivElement>(null);
  const live = useRef<{ view: EditorView; visual: Visual | null; undo: Y.UndoManager }>(null);
  const [mode, setMode] = useState<Mode>(props.visual && !sourceOnly ? 'visual' : 'source');
  const [note, setNote] = useState('');
  // The editors are made once; they read which view is showing from here.
  const modeNow = useRef(mode);
  modeNow.current = mode;
  /** Put the caret on a line of this file, and the line it is on now. Set once the editors exist. */
  const jump = useRef<(line: number) => void>(() => {});
  const lineNow = useRef<() => number>(() => 1);
  /** The selected stretch as two places that move with the text, and how to select one again. */
  const stretch = useRef<(orCaret?: boolean) => Stretch | null>(() => null);
  const showStretch = useRef<(from: string, to: string) => boolean>(() => false);
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
  // A double-click in the PDF asks for a line: of this file, or of another one of the paper.
  useEffect(
    () =>
      onShow('source', (place) =>
        place.fileId === fileId
          ? jump.current(place.line)
          : router.push(`/projects/${projectId}/files/${place.fileId}?line=${place.line}`),
      ),
    [fileId, projectId, router],
  );
  // The paper's macros as they were when the page was made. Not a reason to rebuild the editors.
  const macros = useRef(props.macros);
  // The same for the paper's own theorem environments: a \\newtheorem added since shows raw until reload.
  const prose = useRef(props.prose);
  /** A formula being edited or inserted, a reference being chosen, and the menu, when open. */
  const [formula, setFormula] = useState<FormulaRequest | null>(null);
  const [picker, setPicker] = useState<{ apply: FormulaRequest['apply'] } | null>(null);
  const [citing, setCiting] = useState<{ apply: FormulaRequest['apply'] } | null>(null);
  const [float, setFloat] = useState<FloatRequest | null>(null);
  const [heading, setHeading] = useState<HeadingRequest | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    top: number;
    edit?: { name: string; run(): void };
  } | null>(null);
  /** Start inserting something where the caret is. The place is fixed now, not when it is done. */
  const insertHere = (then: (apply: FormulaRequest['apply']) => void) => {
    const apply = live.current?.visual?.insertion();
    if (apply) then(apply);
    else setNote('Put the caret in the text where it should go, then try again.');
  };
  const askEquation = () => insertHere((apply) => setFormula({ src: '', place: 'inline', apply }));
  const askReference = () => insertHere((apply) => setPicker({ apply }));
  const askCitation = () => insertHere((apply) => setCiting({ apply }));
  const askFigure = () => insertHere((apply) => setFloat({ kind: 'figure', apply }));
  const askTable = () => insertHere((apply) => setFloat({ kind: 'table', apply }));
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
  const windowOpen = !!formula || !!picker || !!citing || !!float || !!heading;
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
    signedOut: false,
    role: null,
  });
  const keepEdits = useRef(() => {});
  const discardEdits = useRef(() => {});
  const [others, setOthers] = useState<string[]>([]);

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
          update({ held: true });
          setLocked(true);
          // Thrown, not sent: the connection attempt ends here, without bothering the server.
          throw new Error('held until the person decides');
        }
        // Only offered: it counts as seen once this connection has synced. If the attempt dies
        // first, edits typed meanwhile are still held back from the restored text.
        if (restored != null) restoreOffered = restored;
        return ticket ?? '';
      },
      onSynced: () => {
        restoreSeen = Math.max(restoreSeen ?? 0, restoreOffered ?? 0);
        update({ loaded: true });
        // Arrived from a place in the PDF: go to the line it named, once, now that there is text.
        const line = Number(new URLSearchParams(location.search).get('line'));
        if (line && !arrived) setTimeout(() => jump.current(line), 0);
        // The file is here: it can be typed in. (Not again on a later reconnect: by then
        // something else may be holding the editor shut.)
        if (!arrived) setLocked(false);
        arrived = true;
        // Back in touch: find out whether what was typed meanwhile has arrived.
        saving.reconnected();
      },
      onAuthenticationFailed: ({ reason }) => {
        if (restoreHeld !== null || oversized) return;
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
        const reply: (Reply & { key: string }) | Saved | Role | { restored: number } =
          JSON.parse(payload);
        if ('role' in reply) return roleIs(reply);
        // A restore made while this tab is connected arrives as ordinary edits; this says it was one.
        if ('restored' in reply) {
          restoreSeen = Math.max(restoreSeen ?? 0, reply.restored);
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
    provider.on('authenticated', () => update({ connected: true }));
    provider.on('status', ({ status }: { status: string }) => {
      // "Connected" is said when the socket opens, before the ticket has been fetched and the
      // server has accepted it: that is `authenticated`, below.
      if (status !== 'connected') update({ connected: false });
      // The library ignores a request to connect made while a disconnect is still closing,
      // and then stays down. So whenever the connection has closed and this tab should be
      // connected, and the library is not going to try by itself, ask again.
      const socket = provider.configuration.websocketProvider;
      if (status === 'disconnected' && wantOpen && !socket.shouldConnect) void socket.connect();
    });
    let arrived = false;
    // Whether this person's changes are saved is asked of the server, not inferred: "do you hold
    // every insert and delete I have made?". The sync library's own count of confirmations
    // reaches zero too early after a reconnect.
    const saving = watchSaved(doc, {
      send: (question) => provider.sendStateless(question),
      ready: () => provider.synced,
      say: (unsaved) => update({ unsaved }),
    });
    /** The paper's newest restore when this tab last connected, and one found since, if held. */
    let restoreSeen: number | null = null;
    /** The newest restore the last ticket named: seen only once the connection has synced. */
    let restoreOffered: number | null = null;
    let restoreHeld: number | null = null;
    /** Whether this tab should be connected: false only while the browser says it is offline. */
    let wantOpen = true;
    /** The last attempt to connect ended because no ticket could be fetched. */
    let stumbled = false;
    /** The server refused an edit for its size. */
    let oversized = false;
    const awareness = provider.awareness!;
    awareness.setLocalStateField('user', {
      name: user,
      color: colourFor(user),
      colorLight: colourFor(user) + '33',
    });
    const seen = () =>
      setOthers(
        [...awareness.getStates()]
          .filter(([id]) => id !== doc.clientID)
          .map(([, s]) => s.user?.name)
          .filter((n): n is string => typeof n === 'string'),
      );
    awareness.on('change', () => {
      seen();
      live.current?.visual?.redrawCarets();
    });

    // One undo history per person, for both views: undo never takes back someone else's edit.
    const undo = new Y.UndoManager(text);
    const writable = new Compartment();
    // Locked, the text still takes the keyboard: someone who cannot edit can scroll it, move
    // through it and select from it with keys alone. Without the tab stop a locked editor
    // could only be scrolled with a mouse.
    const lock = (on: boolean) => [
      EditorState.readOnly.of(on),
      EditorView.editable.of(!on),
      EditorView.contentAttributes.of(on ? { tabindex: '0' } : {}),
    ];
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
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': `LaTeX source of ${props.path}` }),
          // Shut until the file has arrived. Typed into an editor still empty, words would
          // land at the top of the file, wherever the caret was meant to be.
          writable.of(lock(true)),
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
          label: `${props.path}, visual editor`,
          sourceOnly,
          editable: canWrite,
          say: setNote,
          showInSource: (from, to) => show('source', from, to),
          run,
          macros: macros.current,
          prose: prose.current,
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
                const name = typeof s.user?.name === 'string' ? s.user.name.slice(0, 80) : '';
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
    jump.current = (line) => {
      const at = view.state.doc.line(Math.max(1, Math.min(Math.floor(line), view.state.doc.lines)));
      // The first thing written on the line, past its indentation.
      const from = at.from + (at.text.length - at.text.trimStart().length);
      if (visual && modeNow.current === 'visual') return visual.select(from, from);
      view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
      view.focus();
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
    lineNow.current = () => {
      if (visual && modeNow.current === 'visual') visual.catchUp();
      return view.state.doc.lineAt(
        visual && modeNow.current === 'visual'
          ? visual.toSource(visual.editor.state.selection.head, -1)
          : view.state.selection.main.head,
      ).number;
    };

    const setLocked = (on: boolean) => {
      view.dispatch({ effects: writable.reconfigure(lock(on || !canWrite)) });
      visual?.editor.setEditable(!on && canWrite);
    };
    // Typing into a file that is no longer served would go nowhere, so it stops.
    let gone = false;
    const refuse = () => {
      gone = true;
      update({ refused: true });
      setLocked(true);
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
    const warn = (e: BeforeUnloadEvent) => {
      if (saving.unsaved && !discarding) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    // An open socket can sit silent for a long time after the network goes. When the browser
    // says it is offline, say so at once, and reconnect the moment it is back.
    const socket = provider.configuration.websocketProvider;
    const offline = () => {
      wantOpen = false;
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
  }, [projectId, fileId, canWrite, user, syncUrl, props.path, props.visual, sourceOnly]);

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
            : !sync.loaded
              ? 'Opening…'
              : !sync.connected
                ? `Offline. ${sync.unsaved ? 'Your edits are waiting to be saved.' : 'Nothing is waiting to be saved.'}`
                : !canWrite
                  ? 'Read only. You can read along but not edit.'
                  : sync.unsaved
                    ? 'Saving your edits…'
                    : 'All edits saved.';
  return (
    <section aria-label={`Editor for ${props.path}`}>
      <div className="editor-bar">
        <code>{props.path}</code>
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
              <button type="button" onClick={() => live.current?.visual?.emph()}>
                Emphasise
              </button>
              <button
                type="button"
                onClick={() => live.current?.visual?.bold()}
                aria-keyshortcuts="Control+B Meta+B"
                title="Ctrl+B"
              >
                Bold
              </button>
              <button type="button" onClick={() => live.current?.undo.undo()}>
                Undo
              </button>
              <button type="button" onClick={() => live.current?.undo.redo()}>
                Redo
              </button>
              <button type="button" onClick={askReference} aria-keyshortcuts="Alt+R" title="Alt+R">
                Reference
              </button>
              <button type="button" onClick={askCitation} aria-keyshortcuts="Alt+C" title="Alt+C">
                Citation
              </button>
              <button type="button" onClick={askEquation} aria-keyshortcuts="Alt+=" title="Alt+=">
                Equation
              </button>
              <button type="button" onClick={askFigure} aria-keyshortcuts="Alt+G" title="Alt+G">
                Figure
              </button>
              <button type="button" onClick={askTable} aria-keyshortcuts="Alt+T" title="Alt+T">
                Table
              </button>
              <button type="button" onClick={askHeading} aria-keyshortcuts="Alt+H" title="Alt+H">
                Heading
              </button>
              <button
                type="button"
                onClick={() => askList(false)}
                aria-keyshortcuts="Alt+L"
                title="Alt+L"
              >
                Bulleted list
              </button>
              <button
                type="button"
                onClick={() => askList(true)}
                aria-keyshortcuts="Alt+N"
                title="Alt+N"
              >
                Numbered list
              </button>
            </span>
          )}
          <span role="group" aria-label="Go to">
            <button
              type="button"
              onClick={() =>
                setNote(
                  showInPdf({ fileId, line: lineNow.current() })
                    ? ''
                    : 'There is no PDF to show it in yet.',
                )
              }
            >
              Show in PDF
            </button>
          </span>
          <span className="note" aria-live="polite">
            {note}
          </span>
        </Toolbar>
      )}
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
        <EditorMenu
          at={menu}
          onClose={() => {
            setMenu(null);
            live.current?.visual?.focus();
          }}
          onReference={askReference}
          onCitation={askCitation}
          onEquation={askEquation}
          onFigure={askFigure}
          onTable={askTable}
          onHeading={askHeading}
          onBulleted={() => askList(false)}
          onNumbered={() => askList(true)}
        />
        <div className="source" ref={host} hidden={mode !== 'source'} />
      </div>
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
          show={(from, to) => showStretch.current(from, to)}
          onFindings={(list) => {
            findingsNow.current = list;
            markThreads.current();
          }}
        />
      )}
      <Proposals
        projectId={projectId}
        fileId={fileId}
        canPropose={props.canComment}
        canDecide={canWrite}
        canReview={props.canReview}
        selection={() => stretch.current(true)}
        show={(from, to) => showStretch.current(from, to)}
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
        show={(from, to) => showStretch.current(from, to)}
      />
    </section>
  );
}
