import { floatParts } from '../../latex/src/floats.ts';
import { fragment, rng, soup } from '../../latex/src/testutil.ts';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { expect, test } from 'vitest';
import * as Y from 'yjs';
import { fixtures, replica, shown, textblocks, visualOp } from './harness.ts';
import { contained, parse } from '@paperweave/latex';
import type { Command } from './bridge.ts';
import { fromSrc, toSrc } from './project.ts';

const N = Number(process.env.FUZZ ?? 10000);
const DOC = 'First para with \\emph{styled} text.\n\nSecond para, see \\cite{k} and $x$.\n';

/** Type `text` at the display offset of the first paragraph and return the new source. */
function typed(src: string, off: number, text: string, del = 0) {
  const r = replica(src);
  const start = textblocks(r)[0].start;
  expect(r.dispatch(r.state.tr.insertText(text, start + off, start + off + del)), src).toBe(true);
  r.check();
  return r.src;
}

test('typing becomes the smallest splice', () => {
  expect(typed('Hello world.\n', 5, ',')).toBe('Hello, world.\n');
  expect(typed('Hello world.\n', 6, 'big ', 0)).toBe('Hello big world.\n');
  expect(typed('Hello world.\n', 0, 'X', 5)).toBe('X world.\n');
  // Inside a style group the text stays inside it; just outside it stays outside.
  expect(typed('a \\emph{bc} d\n', 3, 'X')).toBe('a \\emph{bXc} d\n');
  expect(typed('a \\emph{bc} d\n', 5, 'X')).toBe('a \\emph{bc} Xd\n');
  // Characters LaTeX treats specially are escaped.
  expect(typed('Cost.\n', 4, ' 50% of $3 & more_or #1 {x} a\\b ~ ^')).toBe(
    'Cost 50\\% of \\$3 \\& more\\_or \\#1 \\{x\\} a\\textbackslash{}b \\textasciitilde{} \\textasciicircum{}.\n',
  );
  // A letter typed straight after a command must not become part of its name.
  expect(typed('\\LaTeX is\n', 1, 'x')).toBe('\\LaTeX{}x is\n');
  expect(typed('a\\\\ b\n', 2, '[', 1)).toBe('a\\\\{}[b\n');
  // Deleting the last text in a style group removes the empty group.
  expect(typed('a \\emph{bc} d\n', 2, '', 2)).toBe('a  d\n');
  expect(typed('a\\emph{bc}d\n', 1, 'X', 2)).toBe('a\\emph{X}d\n');
  // Two characters at once (a paste, an IME commit) are still just typing.
  expect(typed('Hello world.\n', 5, 'ab')).toBe('Helloab world.\n');
  expect(typed('Hello world.\n', 3, '', 2)).toBe('Hel world.\n');
  // Deleting everything on a line removes the line, never leaving a blank one.
  expect(typed('one\ntwo\nthree\n', 4, '', 3)).toBe('one\nthree\n');
  // A space typed before a space, or at the end of a line, is kept so the next word lands
  // where the author expects it.
  expect(typed('one two\n', 3, ' ')).toBe('one  two\n');
  expect(typed('one two\n', 3, ' and')).toBe('one and two\n');
  expect(typed('one two\n', 7, ' ')).toBe('one two \n');
  expect(typed(typed('one\ntwo\n', 3, ' '), 4, 'x')).toBe('one x\ntwo\n');
  expect(typed('one\ntwo\n', 4, ' ')).toBe('one \ntwo\n');
});

test('a % inside code or an address is not a comment, so typing after it adds no line break', () => {
  // Typed just after the atom; the text that follows must stay on the same line.
  expect(typed('Call \\lstinline|push(q, x % 8)| keeps on.\n', 6, ' z')).toBe(
    'Call \\lstinline|push(q, x % 8)| z keeps on.\n',
  );
  expect(typed('Call \\verb|50%| keeps on.\n', 6, ' z')).toBe('Call \\verb|50%| z keeps on.\n');
  expect(typed('See \\url{https://ex.org/a%20b} for data.\n', 5, ' z')).toBe(
    'See \\url{https://ex.org/a%20b} z for data.\n',
  );
  expect(typed('See \\href{https://ex.org/a%20b}{the page} for data.\n', 5, ' z')).toBe(
    'See \\href{https://ex.org/a%20b}{the page} z for data.\n',
  );
  // A real comment earlier on the line still keeps the typed text off it.
  expect(typed('Done \\lstinline|a| % note\n', 6, 'x')).toBe('Done \\lstinline|a|x % note\n');
});

test('macro definitions are shown whole and cannot be deleted or wrapped from the visual editor', () => {
  const src =
    'Text \\newcommand{\\todo}[1]{\\textbf{#1}} and \\def\\eg#1{e.g.} and \\let\\a=\\b end.\n';
  const r = replica(src);
  const atoms: string[] = [];
  r.state.doc.descendants((n) => void (n.type.name === 'raw_inline' && atoms.push(n.attrs.src)));
  expect(atoms).toEqual([
    '\\newcommand{\\todo}[1]{\\textbf{#1}}',
    '\\def\\eg#1{e.g.}',
    '\\let\\a=\\b',
  ]);
  const tb = textblocks(r)[0];
  expect(r.dispatch(r.state.tr.delete(tb.start + 3, tb.start + 7))).toBe(false);
  r.select(tb.start, tb.start + 8);
  expect(r.bridge.emphCommand(r.state)).toBeNull();
  expect(r.dispatch(r.state.tr.insertText('More ', tb.start))).toBe(true);
  expect(r.src).toBe('More ' + src);
});

test('an edit the visual editor cannot express is refused and changes nothing', () => {
  const r = replica(DOC);
  const [a, b] = textblocks(r);
  let refused = 0;
  r.bridge.onReject = () => refused++;
  // Deleting from inside a styled run to the next paragraph, selected as it would be.
  r.select(a.start + 20, b.start + 2);
  expect(r.dispatch(r.state.tr.delete(a.start + 20, b.start + 2))).toBe(false);
  expect(refused).toBe(1);
  expect(r.src).toBe(DOC);
  r.check();
});

test('typing a character and deleting it restores every byte', () => {
  let guarded = 0;
  let positions = 0;
  for (const [path, text] of Object.entries(fixtures)) {
    const r = replica(text);
    for (let i = 0; i < textblocks(r).length; i++) {
      for (let off = 0; off <= textblocks(r)[i].size; off++) {
        const pos = textblocks(r)[i].start + off;
        const before = r.src;
        if (!r.dispatch(r.state.tr.insertText('Q', pos))) continue;
        // A separator may have been typed ahead of the letter, moving it one place along.
        const q = r.state.doc.textBetween(pos, pos + 1) === 'Q' ? pos : pos + 1;
        expect(r.dispatch(r.state.tr.delete(q, q + 1)), `${path} @${pos}`).toBe(true);
        positions++;
        const after = r.src;
        if (after === before) continue;
        // The one allowed difference: the separator that kept the letter out of a command name
        // or out of a comment.
        const x = [...before].findIndex((c, k) => c !== after[k]);
        const sep = after.startsWith('{}', x) ? '{}' : '\n';
        expect(after, `${path} @${pos}`).toBe(before.slice(0, x) + sep + before.slice(x));
        guarded++;
        r.ytext.delete(x, sep.length);
      }
    }
    r.check();
  }
  expect(positions).toBeGreaterThan(3000);
  expect(guarded).toBeLessThan(positions / 100);
});

test(`${N} generated visual edits stay inside their intended range`, () => {
  const paths = Object.keys(fixtures);
  const counts: Record<string, number> = {};
  let done = 0;
  for (let seed = 0; done < N; seed++) {
    const r = rng(seed);
    const rep = replica(fixtures[paths[seed % paths.length]]);
    for (let step = 0; step < 40 && done < N; step++) {
      const before = rep.src;
      const wasShown = shown(rep);
      const paras = textblocks(rep).filter((t) => t.para).length;
      let op;
      try {
        op = visualOp(r, rep);
        if (!op) continue;
        rep.check();
      } catch (err) {
        throw new Error(`seed ${seed} step ${step}: ${(err as Error).message}`, { cause: err });
      }
      const after = rep.src;
      const where = `seed ${seed} step ${step} ${op.what}`;
      if (!op.accepted) {
        expect(after, where).toBe(before);
        continue;
      }
      done++;
      counts[op.what] = (counts[op.what] ?? 0) + 1;
      if (after === before) continue;
      // Every byte before the range and every byte after it is exactly as it was.
      if (before.slice(0, op.lo) !== after.slice(0, op.lo) || !after.endsWith(before.slice(op.hi)))
        throw new Error(
          `${where}: changed outside [${op.lo}, ${op.hi})\n` +
            `${JSON.stringify(before.slice(op.lo - 30, op.hi + 30))}\n${JSON.stringify(after.slice(op.lo - 30, op.hi + 30 + after.length - before.length))}`,
        );
      // What was typed is what is shown: the projection of the new source needs no correction.
      // (One extra space appears when the text had to start a new line after a comment.)
      const grew = shown(rep).length - wasShown.length - (op.token?.length ?? 0);
      if (op.what === 'ins') expect([0, 1], where).toContain(grew);
      if (op.token) expect(shown(rep), where).toContain(op.token);
      // Deleting part of a paragraph never splits it in two.
      if (op.what === 'del' && !op.whole)
        expect(textblocks(rep).filter((t) => t.para).length, where).toBeLessThanOrEqual(paras);
    }
  }
  for (const k of ['ins', 'del', 'rep', 'enter', 'join', 'emph', 'xdel', 'xrep', 'xenter'])
    expect(counts[k], k).toBeGreaterThan(N / 100);
});

test(`${N} interleavings of visual and source edits converge with nothing lost`, () => {
  const base = fixtures['article-basic/main.tex'];
  const para = base.indexOf('Collaborative editors');
  const paraEnd = base.indexOf('Our contributions');
  for (let seed = 0; seed < N; seed++) {
    const r = rng(seed);
    const a = replica(base);
    const b = replica('', a.ydoc);
    const reps = [a, b];
    // Odd seeds only insert unique tokens, so every one of them must survive the merge.
    const lossless = seed % 2 === 1;
    const tokens: string[] = [];
    const queues: Uint8Array[][] = [[], []];
    reps.forEach((rep, i) =>
      rep.ydoc.on(
        'update',
        (u: Uint8Array, origin: unknown) => origin !== 'net' && queues[1 - i].push(u),
      ),
    );
    const deliver = (i: number) => {
      const q = queues[i];
      if (!q.length) return;
      // Any order, and sometimes twice: the network promises neither.
      const k = r.int(q.length);
      Y.applyUpdate(reps[i].ydoc, q[k], 'net');
      if (r.int(8)) q.splice(k, 1);
    };
    try {
      for (let step = 0; step < 14; step++) {
        const i = r.int(2);
        const rep = reps[i];
        const roll = r.int(10);
        if (roll < 3) deliver(i);
        else if (roll < 7) {
          // A visual edit in the shared paragraph.
          const tb = textblocks(rep).find(
            (t) => toSrc(rep.bridge.model, rep.state.doc, t.start) >= para,
          );
          if (!tb) continue;
          if (lossless) {
            // Tokens go in before a space so no later token can land inside an earlier one.
            const text = rep.state.doc.textBetween(tb.start, tb.start + tb.size, '', '\ufffc');
            const spaces = [...text].flatMap((c, k) => (c === ' ' ? [k] : []));
            const token = `v${seed}x${step}q`;
            if (rep.dispatch(rep.state.tr.insertText(token, tb.start + r.pick(spaces))))
              tokens.push(token);
          } else visualOp(r, rep);
        } else {
          // A source edit in the same paragraph, as the source editor would make it.
          let at = Math.min(rep.src.length - 1, para + r.int(paraEnd - para));
          while (lossless && !/\s/.test(rep.src[at])) at++;
          const token = `s${seed}x${step}q`;
          rep.ydoc.transact(() => {
            if (!lossless && r.int(3) === 0)
              rep.ytext.delete(at, Math.min(r.int(6), rep.src.length - at));
            rep.ytext.insert(at, lossless ? token : r.int(2) ? fragment(r) : token);
          });
          if (lossless) tokens.push(token);
        }
        rep.check();
      }
      for (let i = 0; i < 2; i++) while (queues[i].length) deliver(i);
      for (let i = 0; i < 2; i++) while (queues[i].length) deliver(i);
      a.check();
      b.check();
      expect(a.src).toBe(b.src);
      // A just-opened empty paragraph is local to one replica; apart from that they show the same.
      if (!a.bridge.model.phantom && !b.bridge.model.phantom)
        expect(a.state.doc.eq(b.state.doc)).toBe(true);
      for (const t of tokens) expect(a.src.split(t).length - 1, t).toBe(1);
    } catch (err) {
      throw new Error(`seed ${seed}: ${(err as Error).message}`, { cause: err });
    }
  }
});

test('broken LaTeX freezes only its region and recovers when repaired', () => {
  const r = replica('One.\n\nTwo.\n\nThree.\n\n\\section{Next}\n\nFour.\n');
  const names = () => {
    const out: string[] = [];
    r.state.doc.forEach((n) => void out.push(n.type.name));
    return out;
  };
  r.ytext.insert(r.src.indexOf('Two'), '\\emph{');
  r.check();
  expect(names()).toEqual(['paragraph', 'frozen', 'heading', 'paragraph']);
  expect(r.state.doc.child(1).attrs.message).toBe('unclosed \\emph{');
  expect(r.bridge.lastGood.get(0)).toContain('Two.');
  // The rest stays editable, and source edits keep flowing.
  const last = textblocks(r).at(-1)!;
  expect(r.dispatch(r.state.tr.insertText('!', last.start + last.size))).toBe(true);
  expect(r.src.endsWith('Four.!\n')).toBe(true);
  r.ytext.insert(r.src.indexOf('Two') + 3, '}');
  r.check();
  expect(names()).toEqual(['paragraph', 'paragraph', 'paragraph', 'heading', 'paragraph']);
  expect(r.bridge.lastGood.size).toBe(0);
  expect(r.src).toContain('\\emph{Two}.');
});

test('Enter opens a paragraph that reaches the source only once something is typed', () => {
  const r = replica(DOC);
  const first = textblocks(r)[0];
  // What Enter does: split, with the caret landing in the new paragraph.
  const enter = (at: number) => {
    const tr = r.state.tr.split(at);
    return r.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2))));
  };
  expect(enter(first.start + first.size)).toBe(true);
  expect(r.src).toBe(DOC);
  expect(r.state.doc.childCount).toBe(3);
  const empty = textblocks(r)[1];
  expect(r.dispatch(r.state.tr.insertText('New.', empty.start))).toBe(true);
  expect(r.src).toBe(DOC.replace('text.\n\n', 'text.\n\nNew.\n\n'));
  r.check();
  // Opened and then abandoned: it goes away without a trace.
  expect(enter(first.start + first.size)).toBe(true);
  expect(r.state.doc.childCount).toBe(4);
  r.select(first.start);
  expect(r.state.doc.childCount).toBe(3);
  expect(r.src).toBe(DOC.replace('text.\n\n', 'text.\n\nNew.\n\n'));
  // Enter in the middle of a paragraph and Backspace at the start of the next undo each other.
  const before = r.src;
  expect(enter(first.start + 5)).toBe(true);
  expect(r.src).toBe(before.replace('First para', 'First\n\n para'));
  expect(r.dispatch(r.state.tr.join(first.start + 5 + 1))).toBe(true);
  expect(r.src).toBe(before.replace('First para', 'Firstpara'));
  r.check();
});

test('a command applies once, and only if its text has not moved', () => {
  const r = replica(DOC);
  const tb = textblocks(r)[0];
  r.select(tb.start, tb.start + 5);
  const c = r.bridge.emphCommand(r.state)!;
  // An edit elsewhere does not invalidate it; an edit inside its range does.
  r.ytext.insert(r.src.length, 'Tail.\n');
  expect(r.bridge.applyCommand(c)).toBe('applied');
  expect(r.src.startsWith('\\emph{First} para')).toBe(true);
  expect(r.bridge.applyCommand(c)).toBe('duplicate');
  r.check();

  r.select(tb.start, tb.start + 5);
  const undo = r.bridge.emphCommand(r.state)!;
  expect(undo.replacement).toBe('First');
  r.ytext.insert(8, 'X');
  expect(r.bridge.applyCommand(undo)).toBe('conflict');
  expect(r.src.startsWith('\\emph{FiXrst} para')).toBe(true);
  r.check();
});

test('carets map between the two views', () => {
  for (const text of Object.values(fixtures)) {
    const r = replica(text);
    const { model } = r.bridge;
    for (const tb of textblocks(r))
      for (let off = 0; off <= tb.size; off++) {
        const src = toSrc(model, r.state.doc, tb.start + off);
        const back = fromSrc(model, r.state.doc, src);
        expect(toSrc(model, r.state.doc, back)).toBe(src);
      }
  }
  const r = replica(DOC);
  const at = DOC.indexOf('para,');
  expect(toSrc(r.bridge.model, r.state.doc, fromSrc(r.bridge.model, r.state.doc, at))).toBe(at);
});

test("when a file's text first arrives, the caret is at its start and not on the whole document", () => {
  // The app opens an empty editor and the text comes from the server a moment later.
  const r = replica('');
  r.ytext.insert(0, fixtures['ieee-multifile/sections/intro.tex']);
  r.check();
  // A selection of everything would make the first key pressed replace the whole file.
  expect(r.state.selection.toJSON()).toMatchObject({ type: 'text' });
  expect(r.state.selection.empty).toBe(true);
});

test('every atom can be replaced by a command that touches only its own source', () => {
  let atoms = 0;
  for (const [path, text] of Object.entries(fixtures)) {
    const r = replica(text);
    const found: { pos: number; src: string; type: string }[] = [];
    r.state.doc.descendants((node, pos) => {
      if (node.isAtom && typeof node.attrs.src === 'string' && node.attrs.src)
        found.push({ pos, src: node.attrs.src, type: node.type.name });
    });
    for (const a of found) {
      const c = r.bridge.atomCommand(r.state, a.pos, a.src);
      expect(c, `${path}: ${a.type} ${a.src.slice(0, 30)}`).not.toBeNull();
      const from = Y.createAbsolutePositionFromRelativePosition(c!.from, r.ydoc)!.index;
      const to = Y.createAbsolutePositionFromRelativePosition(c!.to, r.ydoc)!.index;
      expect(r.src.slice(from, to), `${path}: ${a.type}`).toBe(a.src);
      atoms++;
    }
  }
  expect(atoms).toBeGreaterThan(40);

  // Replacing a formula changes those bytes and no others, and the two views still agree.
  const r = replica(fixtures['ieee-multifile/sections/method.tex']);
  let inline = -1;
  let display = -1;
  r.state.doc.descendants((node, pos) => {
    if (node.type.name === 'math_inline' && inline < 0) inline = pos;
    if (node.type.name === 'math_block' && display < 0) display = pos;
  });
  const before = r.src;
  expect(r.bridge.applyCommand(r.bridge.atomCommand(r.state, inline, '$T_0$')!)).toBe('applied');
  expect(r.src).toBe(before.replace('$T$', '$T_0$'));
  r.check();
  const block = r.state.doc.nodeAt(display)!.attrs.src as string;
  const edited = block.replace('+ c .', '+ c + 1 .');
  expect(r.bridge.applyCommand(r.bridge.atomCommand(r.state, display, edited)!)).toBe('applied');
  expect(r.src).toBe(before.replace('$T$', '$T_0$').replace('+ c .', '+ c + 1 .'));
  r.check();
  // A formula someone else changed meanwhile is not overwritten.
  const stale = r.bridge.atomCommand(r.state, display, 'x');
  r.ytext.insert(r.src.indexOf('+ c + 1'), '2');
  expect(r.bridge.applyCommand(stale!)).toBe('conflict');
  // Not an atom: no command.
  expect(r.bridge.atomCommand(r.state, 1, 'x')).toBeNull();
});

test('LaTeX is inserted at the caret, wherever the text has moved to meanwhile', () => {
  const r = replica(fixtures['ieee-multifile/sections/intro.tex']);
  const before = r.src;
  // The place just after "follows. Section", in the last paragraph.
  const afterSection = () => {
    let at = -1;
    r.state.doc.descendants((node, pos) => {
      const i = node.isText ? node.text!.indexOf('follows. Section') : -1;
      if (i >= 0) at = pos + i + 'follows. Section'.length;
    });
    return at;
  };
  let caret = afterSection();
  r.select(caret);
  const c = r.bridge.insertCommand(r.state, '~\\ref{sec:intro} and Section')!;
  // Someone types at the top of the file before the insertion is made.
  r.ytext.insert(0, '% a new first line\n');
  expect(r.bridge.applyCommand(c)).toBe('applied');
  expect(r.src).toBe(
    '% a new first line\n' +
      before.replace('follows. Section~', 'follows. Section~\\ref{sec:intro} and Section~'),
  );
  r.check();

  // With a selection, the insertion goes after it and replaces nothing.
  caret = afterSection();
  r.select(caret - 7, caret);
  const after = r.bridge.insertCommand(r.state, '!')!;
  expect(r.bridge.applyCommand(after)).toBe('applied');
  expect(r.src).toContain('follows. Section!~\\ref{sec:intro}');
  r.check();

  // Not in running text: nothing to build.
  let atom = -1;
  r.state.doc.forEach((node, pos) => {
    if (atom < 0 && node.isAtom) atom = pos;
  });
  const tr = r.state.tr.setSelection(NodeSelection.create(r.state.doc, atom));
  expect(r.bridge.insertCommand(r.state.apply(tr), 'x')).toBeNull();
});

/** A second replica of r's text, and a way to bring what it did back into r. */
function peer(r: ReturnType<typeof replica>) {
  const b = replica('', r.ydoc);
  return {
    b,
    merge: () => Y.applyUpdate(r.ydoc, Y.encodeStateAsUpdate(b.ydoc)),
  };
}
const FLOW = 'One.\n\nTwo here.\n\nThree.\n';

test('an insertion whose caret paragraph is deleted by someone else is refused, not moved', () => {
  const r = replica(FLOW);
  r.select(textblocks(r).filter((t) => t.para)[1].start + 3);
  const c = r.bridge.insertCommand(r.state, '~\\cite{knuth}')!;
  const { b, merge } = peer(r);
  const at = b.src.indexOf('Two here.');
  b.ytext.delete(at, 'Two here.\n\n'.length);
  merge();
  expect(r.src).toBe('One.\n\nThree.\n');
  expect(r.bridge.applyCommand(c)).toBe('conflict');
  expect(r.src).toBe('One.\n\nThree.\n');
  r.check();
});

test('an insertion whose deleted text ran into a heading is refused', () => {
  const src = 'Intro text here.\n\n\\section{Methods}\nBody.\n';
  const r = replica(src);
  r.select(textblocks(r).filter((t) => t.para)[0].start + 10);
  const c = r.bridge.insertCommand(r.state, '~\\cite{knuth}')!;
  const { b, merge } = peer(r);
  b.ytext.delete(9, b.src.indexOf('Methods') - 9);
  merge();
  expect(r.src).toBe('Intro tex' + 'Methods}\nBody.\n');
  expect(r.bridge.applyCommand(c)).toBe('conflict');
  expect(r.src).toBe('Intro texMethods}\nBody.\n');
});

test('an empty part of an atom is refused if the atom is deleted by someone else', () => {
  const r = replica(fixtures['ieee-multifile/tables/ablation.tex']);
  let at = -1;
  let src = '';
  r.state.doc.forEach((node, pos) => {
    if (node.type.name === 'raw_block' && floatParts(node.attrs.src))
      [at, src] = [pos, node.attrs.src];
  });
  const cap = floatParts(src)!.caption!;
  const c = r.bridge.atomCommand(r.state, at, '\\label{x}', { at: cap.at, end: cap.at })!;
  expect(c.expected).toBe('');
  const { b, merge } = peer(r);
  b.ytext.delete(b.src.indexOf(src), src.length);
  merge();
  const was = r.src;
  expect(r.bridge.applyCommand(c)).toBe('conflict');
  expect(r.src).toBe(was);
});

test('an insertion names the character before the caret and the one after', () => {
  const r = replica(FLOW);
  r.select(textblocks(r).filter((t) => t.para)[1].start + 3);
  const c = r.bridge.insertCommand(r.state, 'x')!;
  const from = Y.decodeRelativePosition(Y.encodeRelativePosition(c.from));
  const to = Y.decodeRelativePosition(Y.encodeRelativePosition(c.to));
  expect(from.assoc).toBeLessThan(0);
  expect(to.assoc).toBe(0);
  // Stands on 'o' before the caret in "Two", and ' ' after it.
  const idx = (p: Y.RelativePosition) =>
    Y.createAbsolutePositionFromRelativePosition(p, r.ydoc)!.index;
  expect(idx(c.from)).toBe(idx(c.to));
});

test('an insertion at either end of the file, or after typing elsewhere, still applies', () => {
  for (const end of [0, 1]) {
    const r = replica('Only text.\n');
    const tb = textblocks(r).filter((t) => t.para)[0];
    r.select(end ? tb.start + 'Only text.'.length : tb.start);
    const c = r.bridge.insertCommand(r.state, '!')!;
    expect(r.bridge.applyCommand(c)).toBe('applied');
    expect(r.src).toBe(end ? 'Only text.!\n' : '!Only text.\n');
  }
  const r = replica(FLOW);
  r.select(textblocks(r).filter((t) => t.para)[1].start + 3);
  const c = r.bridge.insertCommand(r.state, '!')!;
  const { b, merge } = peer(r);
  b.ytext.insert(0, '% note\n');
  merge();
  expect(r.bridge.applyCommand(c)).toBe('applied');
  expect(r.src).toBe('% note\nOne.\n\nTwo! here.\n\nThree.\n');
});

test('editing one cell of a table changes only that cell, and two people can edit two cells', () => {
  const r = replica(fixtures['ieee-multifile/tables/ablation.tex']);
  const table = () => {
    let at = -1;
    let src = '';
    r.state.doc.forEach((node, pos) => {
      if (node.type.name === 'raw_block' && floatParts(node.attrs.src))
        [at, src] = [pos, node.attrs.src];
    });
    return { at, parts: floatParts(src)!, src };
  };
  const before = r.src;
  // Every cell in turn: the file differs from the original in that cell and nowhere else.
  const first = table();
  first.parts.table!.rows.forEach((row, i) =>
    row.forEach((_, j) => {
      const now = table();
      const cell = now.parts.table!.rows[i][j];
      const c = r.bridge.atomCommand(r.state, now.at, `<${i},${j}>`, cell)!;
      expect(c.expected).toBe(cell.text);
      expect(r.bridge.applyCommand(c)).toBe('applied');
      r.check();
    }),
  );
  let want = before;
  let shift = 0;
  const start = before.indexOf(first.src);
  first.parts.table!.rows.forEach((row, i) =>
    row.forEach((cell, j) => {
      const at = start + cell.at + shift;
      want = want.slice(0, at) + `<${i},${j}>` + want.slice(at + cell.text.length);
      shift += `<${i},${j}>`.length - cell.text.length;
    }),
  );
  expect(r.src).toBe(want);

  // Two commands built from the same view, for two different cells: both go through.
  const now = table();
  const a = r.bridge.atomCommand(r.state, now.at, 'A', now.parts.table!.rows[1][0])!;
  const b = r.bridge.atomCommand(r.state, now.at, 'B', now.parts.table!.rows[2][2])!;
  // For the same cell: the second finds it changed.
  const again = r.bridge.atomCommand(r.state, now.at, 'C', now.parts.table!.rows[1][0])!;
  expect(r.bridge.applyCommand(a)).toBe('applied');
  expect(r.bridge.applyCommand(b)).toBe('applied');
  expect(r.bridge.applyCommand(again)).toBe('conflict');
  const after = table().parts.table!.rows.map((row) => row.map((c) => c.text));
  expect(after[1][0]).toBe('A');
  expect(after[2][2]).toBe('B');
  r.check();

  // The caption is a part like any other; a stretch outside the atom is not one.
  const cap = table();
  const c = r.bridge.atomCommand(r.state, cap.at, 'A new caption', cap.parts.caption!)!;
  expect(r.bridge.applyCommand(c)).toBe('applied');
  expect(r.src).toContain('\\caption{A new caption}');
  expect(r.bridge.atomCommand(r.state, cap.at, 'x', { at: 0, end: 99_999 })).toBeNull();
});

test('a caret whose paragraph is removed by another origin stays where text can go', () => {
  const src =
    'One.\n\nTwo here.\n\n\\begin{table}\n\\begin{tabular}{l}\na\\\\\n\\end{tabular}\n\\end{table}\n';
  const r = replica(src);
  const tbs = textblocks(r).filter((t) => t.para);
  const two = tbs[1];
  r.select(two.start + 3);
  const at = r.src.indexOf('Two here.');
  r.ytext.delete(at, 'Two here.\n\n'.length);
  r.check();
  const sel = r.state.selection;
  expect(sel).toBeInstanceOf(TextSelection);
  expect(sel.$head.parent.inlineContent).toBe(true);
  // In the paragraph before, not on the table.
  expect(sel.$head.parent.textContent).toBe('One.');
});

/** A fresh replica of src and the visual positions of display offsets in two of its text blocks. */
function span(src: string, i: number, off: number, k: number, offEnd: number) {
  const r = replica(src);
  const tbs = textblocks(r);
  const from = tbs[i].start + off;
  const to = tbs[k].start + offEnd;
  // As in the editor, the text is selected when a key deletes it.
  r.select(from, to);
  return { r, from, to };
}
const THREE = 'Alpha beta gamma.\n\nDelta epsilon zeta.\n\nEta theta iota.\n';

test('deleting or typing across paragraphs joins them in one splice', () => {
  // From the middle of one paragraph to the middle of the next.
  let { r, from, to } = span(THREE, 0, 6, 1, 6);
  expect(r.dispatch(r.state.tr.delete(from, to))).toBe(true);
  expect(r.src).toBe('Alpha epsilon zeta.\n\nEta theta iota.\n');
  r.check();
  // Across three paragraphs.
  ({ r, from, to } = span(THREE, 0, 6, 2, 4));
  expect(r.dispatch(r.state.tr.delete(from, to))).toBe(true);
  expect(r.src).toBe('Alpha theta iota.\n');
  r.check();
  // With a word typed over the selection.
  ({ r, from, to } = span(THREE, 0, 6, 1, 6));
  expect(r.dispatch(r.state.tr.insertText('new ', from, to))).toBe(true);
  expect(r.src).toBe('Alpha new epsilon zeta.\n\nEta theta iota.\n');
  r.check();
});

test('an edit across paragraphs that ends inside a style, or reaches a heading, is refused', () => {
  let { r, from, to } = span('Alpha \\emph{beta} gamma.\n\nDelta epsilon.\n', 0, 8, 1, 2);
  let refused = 0;
  r.bridge.onReject = () => refused++;
  expect(r.dispatch(r.state.tr.delete(from, to))).toBe(false);
  expect(refused).toBe(1);
  expect(r.src).toBe('Alpha \\emph{beta} gamma.\n\nDelta epsilon.\n');
  const head = '\\section{Head}\n\nBody text.\n\nMore text.\n';
  ({ r, from, to } = span(head, 0, 2, 1, 2));
  r.bridge.onReject = () => refused++;
  expect(r.dispatch(r.state.tr.delete(from, to))).toBe(false);
  expect(refused).toBe(2);
  expect(r.src).toBe(head);
  // The same keys between two paragraphs, outside any style, are fine.
  ({ r, from, to } = span(head, 1, 2, 2, 2));
  expect(r.dispatch(r.state.tr.delete(from, to))).toBe(true);
  expect(r.src).toBe('\\section{Head}\n\nBore text.\n');
  ({ r, from, to } = span('Alpha \\emph{beta} gamma.\n\nDelta epsilon.\n', 0, 0, 1, 2));
  expect(r.dispatch(r.state.tr.delete(from, to))).toBe(true);
  expect(r.src).toBe('lta epsilon.\n');
});

test('Enter over a selected word replaces it with a paragraph break', () => {
  const { r, from, to } = span('Alpha beta gamma.\n', 0, 6, 0, 10);
  const tr = r.state.tr.delete(from, to).split(from);
  expect(r.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(from + 2))))).toBe(true);
  expect(r.src).toBe('Alpha \n\n gamma.\n');
  r.check();
});

test('Backspace at the start of a paragraph after a heading does nothing and says nothing', () => {
  const r = replica('\\section{Head}\n\nBody text.\n');
  let refused = 0;
  r.bridge.onReject = () => refused++;
  const body = textblocks(r)[1];
  r.select(body.start);
  // What Backspace tries: delete the two positions between the heading and the paragraph.
  expect(r.dispatch(r.state.tr.delete(body.start - 2, body.start))).toBe(false);
  expect(refused).toBe(0);
  // The same deletion over a selection still says why.
  r.select(body.start - 3, body.start);
  expect(r.dispatch(r.state.tr.delete(body.start - 3, body.start))).toBe(false);
  expect(refused).toBe(1);
});

/** The inline atoms of a replica, with where each is. */
function inlineAtoms(r: ReturnType<typeof replica>) {
  const found: { pos: number; src: string; type: string }[] = [];
  r.state.doc.descendants((node, pos) => {
    if (node.isAtom && node.isInline && typeof node.attrs.src === 'string' && node.attrs.src)
      found.push({ pos, src: node.attrs.src, type: node.type.name });
  });
  return found;
}
/** The display formulas of a replica, listed like the inline atoms. */
function mathBlocks(r: ReturnType<typeof replica>) {
  const found: { pos: number; src: string; type: string }[] = [];
  r.state.doc.descendants((node, pos) => {
    if (node.type.name === 'math_block' && typeof node.attrs.src === 'string' && node.attrs.src)
      found.push({ pos, src: node.attrs.src, type: node.type.name });
  });
  return found;
}
/** Everything the formula box and the atom window can edit. */
const editable = (r: ReturnType<typeof replica>) => [...inlineAtoms(r), ...mathBlocks(r)];
function rewrite(r: ReturnType<typeof replica>, old: string, now: string) {
  const a = inlineAtoms(r).find((x) => x.src === old)!;
  expect(a, old).toBeDefined();
  const c = r.bridge.atomCommand(r.state, a.pos, old)!;
  const out = r.bridge.rewriteCommand(c, now);
  return { c, out };
}

const SYS = '\\newcommand{\\sys}{S}\n\nUse \\sys{} now and later.\n';

test('a rewrite that was safe for its author is refused once another replica deleted the space after the atom', () => {
  const r = replica(SYS);
  const { c, out } = rewrite(r, '\\sys{}', '\\sys');
  expect(typeof out).toBe('object');
  const cmd = out as Command;
  expect(cmd.contained).toBe(true);
  const { b, merge } = peer(r);
  const at = b.src.indexOf('\\sys{} now') + '\\sys{}'.length;
  b.ytext.delete(at, 1);
  merge();
  expect(r.src).toContain('Use \\sys{}now and');
  const was = r.src;
  expect(r.bridge.applyCommand(cmd)).toBe('conflict');
  expect(r.src).toBe(was);
  r.check();
  // Without the flag the same command lands and breaks the build: the flag is what protects.
  const bare = { ...cmd, key: 'bare' };
  delete bare.contained;
  expect(c.key).not.toBe(cmd.key);
  expect(r.bridge.applyCommand(bare)).toBe('applied');
  expect(r.src).toContain('Use \\sysnow and');
});

test('a rewrite is refused once another replica deleted the text before the atom that made it safe', () => {
  const r = replica('\\newcommand{\\sys}{S}\n\nUse \\sys{} \\textsc{now} and later.\n');
  const { out } = rewrite(r, '\\textsc{now}', 'now');
  expect(typeof out).toBe('object');
  const { b, merge } = peer(r);
  const at = b.src.indexOf('{} \\textsc');
  b.ytext.delete(at, 3);
  merge();
  expect(r.src).toContain('Use \\sys\\textsc{now}');
  const was = r.src;
  expect(r.bridge.applyCommand(out as Command)).toBe('conflict');
  expect(r.src).toBe(was);
  r.check();
});

test('an inline atom is rewritten to exactly the new bytes, or the rewrite is refused', () => {
  const doc =
    'See \\citep{a} here.\\footnote{Old note.} Use {\\bf x} and \\sys{}x now.\n\\newcommand{\\sys}{S}\n';
  const accepted: [string, string][] = [
    ['\\citep{a}', '\\citep[p.~3]{a,b}'],
    ['\\footnote{Old note.}', '\\footnote{New \\emph{note}.}'],
    ['{\\bf x}', '\\textbf{x}'],
  ];
  for (const [old, now] of accepted) {
    const r = replica(doc);
    const before = r.src;
    const { out } = rewrite(r, old, now);
    expect(typeof out, old).toBe('object');
    expect(r.bridge.applyCommand(out as never)).toBe('applied');
    expect(r.src).toBe(before.replace(old, now));
    r.check();
  }
  const refused: [string, string][] = [
    ['\\footnote{Old note.}', '\\footnote{x'],
    ['\\footnote{Old note.}', 'a\n\nb'],
    ['\\citep{a}', '\\citep{a} %'],
    ['\\sys{}', '\\sys'],
    ['\\citep{a}', '\\begin{equation}x\\end{equation}'],
  ];
  for (const [old, now] of refused) {
    const r = replica(doc);
    const before = r.src;
    expect(rewrite(r, old, now).out, `${old} -> ${now}`).toBe('spills');
    expect(r.src).toBe(before);
  }
  // A macro definition is never rewritten, not even to what it says already.
  const r = replica(doc);
  const def = r.src.match(/\\newcommand\{\\sys\}\{S\}/)![0];
  const found = inlineAtoms(r).find((x) => x.src.startsWith('\\newcommand'));
  if (found) {
    const c = r.bridge.atomCommand(r.state, found.pos, def)!;
    expect(r.bridge.rewriteCommand(c, def)).toBe('spills');
    expect(r.bridge.rewriteCommand(c, 'x')).toBe('spills');
  }
  // An atom that changed after the command was built is a conflict.
  const s = replica(doc);
  const { c } = rewrite(s, '\\citep{a}', '\\citep{a}');
  s.ytext.insert(s.src.indexOf('{a}') + 1, 'z');
  expect(s.bridge.rewriteCommand(c, '\\citep{b}')).toBe('conflict');
});

test('a display formula rewritten to another display formula is contained; one that loses its end is not', () => {
  const r = replica('Before.\n\n\\begin{equation}\nx = 1\n\\end{equation}\n\nAfter.\n');
  const a = mathBlocks(r)[0];
  const c = r.bridge.atomCommand(r.state, a.pos, a.src)!;
  const out = r.bridge.rewriteCommand(c, '\\begin{equation}\ny = 2\n\\end{equation}');
  expect(out).toMatchObject({ contained: true });
  expect(r.bridge.rewriteCommand(c, '\\begin{equation}\ny = 2')).toBe('spills');
  expect(r.bridge.rewriteCommand(c, '$$ y $$ and $$ z $$')).toBe('spills');
  expect(
    r.bridge.rewriteCommand(
      c,
      '\\begin{equation}\nx\n\\end{equation}\n\n\\begin{equation}\ny\n\\end{equation}',
    ),
  ).toBe('spills');
});

test('every inline atom of every fixture can be rewritten to what it already says', () => {
  let n = 0;
  let blocks = 0;
  for (const [path, text] of Object.entries(fixtures)) {
    const r = replica(text);
    for (const a of inlineAtoms(r)) {
      const c = r.bridge.atomCommand(r.state, a.pos, a.src)!;
      const out = r.bridge.rewriteCommand(c, a.src);
      // Definitions are the one kind refused, and they are not drawn as chips to open.
      if (
        out === 'spills' &&
        /^\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment|def|gdef|edef|xdef|let|newtheorem|DeclareMathOperator)\b/.test(
          a.src,
        )
      )
        continue;
      expect(typeof out, `${path}: ${a.src.slice(0, 40)}`).toBe('object');
      n++;
    }
    // A display formula too: it is contained, and the command says so.
    for (const a of mathBlocks(r)) {
      const c = r.bridge.atomCommand(r.state, a.pos, a.src)!;
      const out = r.bridge.rewriteCommand(c, a.src);
      expect(typeof out, `${path}: ${a.src.slice(0, 40)}`).toBe('object');
      expect((out as Command).contained).toBe(true);
      blocks++;
    }
  }
  expect(n).toBeGreaterThan(20);
  expect(blocks).toBeGreaterThan(0);
});

test(`${N} rewrites of an inline atom change its bytes and nothing else, or are refused`, () => {
  const paths = Object.keys(fixtures);
  let yes = 0;
  let no = 0;
  for (let seed = 0, done = 0; done < N; seed++) {
    const r = rng(seed);
    const rep = replica(fixtures[paths[seed % paths.length]]);
    const atoms = editable(rep);
    if (!atoms.length) continue;
    for (let step = 0; step < 8 && done < N && atoms.length; step++, done++) {
      const a = r.pick(atoms);
      const was = rep.src;
      const cps = Array.from(a.src);
      const [x, y] = [r.int(cps.length + 1), r.int(cps.length + 1)].sort((u, v) => u - v);
      const mutate = cps.slice(0, x).join('') + soup(r, r.int(3)) + cps.slice(y).join('');
      const now = r.int(2) ? soup(r, 1 + r.int(4)) : mutate;
      const where = `seed ${seed} step ${step}: ${JSON.stringify(a.src)} -> ${JSON.stringify(now)}`;
      try {
        const c = rep.bridge.atomCommand(rep.state, a.pos, a.src);
        if (!c) {
          // The atoms were listed before an earlier rewrite moved them: list again.
          atoms.splice(0, atoms.length, ...editable(rep));
          done--;
          continue;
        }
        const out = rep.bridge.rewriteCommand(c, now);
        if (out === 'spills' || out === 'conflict') {
          expect(rep.src, where).toBe(was);
          no++;
          continue;
        }
        expect(out.contained, where).toBe(true);
        // Sometimes another replica deletes a little text next to the atom first. Then the
        // command conflicts, or changes only the atom's bytes.
        if (r.int(3) === 0) {
          const other = replica('', rep.ydoc);
          const i = Y.createAbsolutePositionFromRelativePosition(c.from, rep.ydoc)!.index;
          const side = r.int(2) ? i + a.src.length : Math.max(0, i - 1 - r.int(3));
          other.ytext.delete(Math.min(side, other.src.length - 1), 1 + r.int(2));
          Y.applyUpdate(rep.ydoc, Y.encodeStateAsUpdate(other.ydoc));
          other.bridge.destroy();
          const mid = rep.src;
          const res = rep.bridge.applyCommand(out);
          if (res === 'conflict') {
            expect(rep.src, where).toBe(mid);
            rep.check();
            atoms.splice(0, atoms.length, ...editable(rep));
            continue;
          }
          expect(res).toBe('applied');
          const at2 = Y.createAbsolutePositionFromRelativePosition(c.from, rep.ydoc)!.index;
          // Whatever the other replica did, what applied is contained in the text it applied to.
          expect(contained(parse(mid), parse(rep.src), at2, a.src.length, now.length), where).toBe(
            true,
          );
          expect(rep.src.slice(0, at2), where).toBe(mid.slice(0, at2));
          expect(rep.src.slice(at2 + now.length), where).toBe(mid.slice(at2 + a.src.length));
          rep.check();
          atoms.splice(0, atoms.length, ...editable(rep));
          continue;
        }
        expect(rep.bridge.applyCommand(out)).toBe('applied');
        yes++;
        // The bytes before and after the atom are as they were.
        const at = Y.createAbsolutePositionFromRelativePosition(c.from, rep.ydoc)!.index;
        expect(rep.src.slice(0, at), where).toBe(was.slice(0, at));
        expect(rep.src.slice(at + now.length), where).toBe(was.slice(at + a.src.length));
        expect(rep.src.slice(at, at + now.length), where).toBe(now);
        rep.check();
        atoms.splice(0, atoms.length, ...editable(rep));
      } catch (err) {
        throw new Error(`${where}: ${(err as Error).message}`, { cause: err });
      }
    }
  }
  console.log(`atom rewrite fuzz: ${yes} accepted, ${no} refused of ${yes + no}`);
  expect(yes).toBeGreaterThan(N / 100);
  expect(no).toBeGreaterThan(N / 100);
});

const HALVES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test('an edit between the two halves of an emoji is refused and the source is left alone', () => {
  const src = 'a\u{1F600}\u{1F601}b\n';
  const tries = [
    (r: ReturnType<typeof replica>, s: number) => r.state.tr.insertText('z', s + 2),
    (r: ReturnType<typeof replica>, s: number) => r.state.tr.delete(s + 2, s + 3),
    (r: ReturnType<typeof replica>, s: number) => r.state.tr.delete(s + 1, s + 2),
    (r: ReturnType<typeof replica>, s: number) =>
      r.state.tr.insertText('\u{1F601}', s + 1, s + 3).insertText('q', s + 4),
  ];
  for (const mk of tries) {
    const r = replica(src);
    const s = textblocks(r)[0].start;
    expect(r.dispatch(mk(r, s))).toBe(false);
    expect(r.src).toBe(src);
    r.check();
  }
  // Whole characters still go: delete the first emoji, replace one, type after one.
  expect(typed(src, 1, '', 2)).toBe('a\u{1F601}b\n');
  expect(typed(src, 1, '\u{1F601}', 2)).toBe('a\u{1F601}\u{1F601}b\n');
  expect(typed(src, 3, 'z')).toBe('a\u{1F600}z\u{1F601}b\n');
});

test('a backslash and an emoji is one atom, and typing beside it leaves no half emoji', () => {
  const src = 'x \\\u{1F600} y\n';
  const r = replica(src);
  const s = textblocks(r)[0].start;
  expect(shown(r)).not.toMatch(HALVES);
  const at = 3;
  expect(r.dispatch(r.state.tr.insertText('z', s + at))).toBe(true);
  r.check();
  expect(r.src).toBe('x \\\u{1F600}z y\n');
  expect(r.src).not.toMatch(HALVES);
  expect(typed(src, 0, 'q')).toBe('qx \\\u{1F600} y\n');
});

/** Insert a heading at display offset `off` of paragraph `n`; the new source, or null if refused. */
function headed(
  src: string,
  n: number,
  off: number,
  level: 'section' | 'subsection' = 'subsection',
) {
  const r = replica(src);
  r.select(textblocks(r).filter((t) => t.para)[n].start + off);
  const c = r.bridge.headingCommand(r.state, level, 'Method');
  if (!c) return null;
  expect(r.bridge.applyCommand(c)).toBe('applied');
  r.check();
  return r.src;
}

test('a heading in the middle of a paragraph splits it and changes nothing else', () => {
  expect(headed('One.\n\nTwo here.\n\nThree.\n', 1, 3)).toBe(
    'One.\n\nTwo\n\n\\subsection{Method}\n\n here.\n\nThree.\n',
  );
  // Mid-line break inside a paragraph: the line's own break is used, not added to.
  expect(headed('One.\n\nTwo\nhere.\n', 1, 3)).toBe(
    'One.\n\nTwo\n\n\\subsection{Method}\n\nhere.\n',
  );
  const r = replica('One.\n\nTwo here.\n\nThree.\n');
  r.select(textblocks(r).filter((t) => t.para)[1].start + 3);
  r.bridge.applyCommand(r.bridge.headingCommand(r.state, 'subsection', 'Method')!);
  const kinds = r.state.doc.children.map((n) => n.type.name);
  expect(kinds).toEqual(['paragraph', 'paragraph', 'heading', 'paragraph', 'paragraph']);
  expect(r.state.doc.child(2).attrs.level).toBe(2);
  expect(r.state.doc.child(2).textContent).toBe('Method');
});

test('a heading at either end of a paragraph leaves no run of three line breaks', () => {
  const src = 'One.\n\nTwo here.\n\nThree.\n';
  expect(headed(src, 1, 0, 'section')).toBe('One.\n\n\\section{Method}\n\nTwo here.\n\nThree.\n');
  expect(headed(src, 1, 9)).toBe('One.\n\nTwo here.\n\n\\subsection{Method}\n\nThree.\n');
  for (const [n, off] of [
    [0, 0],
    [0, 4],
    [1, 0],
    [1, 9],
    [2, 0],
    [2, 6],
  ]) {
    const out = headed(src, n, off)!;
    expect(out).not.toMatch(/\n{3}/);
    expect(out).toContain('\\subsection{Method}');
  }
  // The first and last paragraph of a file, with and without a final line break.
  expect(headed('Only.', 0, 0)).toBe('\\subsection{Method}\n\nOnly.');
  expect(headed('Only.', 0, 5)).toBe('Only.\n\n\\subsection{Method}\n\n');
  expect(headed('Only.\n', 0, 5)).toBe('Only.\n\n\\subsection{Method}\n\n');
  // After a heading line with no blank line between.
  expect(headed('\\section{A}\nBody.\n', 0, 0)).toBe(
    '\\section{A}\n\n\\subsection{Method}\n\nBody.\n',
  );
});

test('a heading is refused in a list item, a heading, a raw block and a paragraph not yet written', () => {
  const src =
    '\\section{Head}\n\n\\begin{itemize}\n\\item One\n\\end{itemize}\n\nText.\n\n\\begin{figure}\n\\caption{Cap}\n\\end{figure}\n';
  const r = replica(src);
  const blocks: { start: number; type: string }[] = [];
  r.state.doc.descendants((n, pos) => {
    if (n.isTextblock) blocks.push({ start: pos + 1, type: n.type.name });
  });
  const types = blocks.map((b) => b.type);
  expect(types).toEqual(['heading', 'list_item', 'paragraph']);
  for (const b of blocks.slice(0, 2)) {
    r.select(b.start + 1);
    expect(r.bridge.headingCommand(r.state, 'section', 'X')).toBeNull();
  }
  r.select(blocks[2].start + 1);
  expect(r.bridge.headingCommand(r.state, 'section', 'X')).not.toBeNull();
  // A caption and the preamble are raw blocks: no caret can be put in them.
  const pre = replica('\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n');
  const tb = textblocks(pre).filter((t) => t.para)[0];
  pre.select(tb.start + 1);
  expect(pre.bridge.headingCommand(pre.state, 'section', 'X')).not.toBeNull();
  pre.select(1);
  expect(pre.bridge.headingCommand(pre.state, 'section', 'X')).toBeNull();

  // The paragraph opened with Enter, not yet in the source.
  const p = replica('One.\n');
  const first = textblocks(p)[0];
  const tr = p.state.tr.split(first.start + first.size);
  p.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(first.start + first.size + 2))));
  expect(p.bridge.model.phantom).not.toBeNull();
  expect(p.bridge.headingCommand(p.state, 'section', 'X')).toBeNull();
});

test('a heading ends a % comment that is open on the caret line', () => {
  const src = 'Before % a note\nafter the note.\n\nNext.\n';
  const r = replica(src);
  // The caret is at the end of the first line's visible text.
  r.select(textblocks(r)[0].start + 'Before '.length);
  const c = r.bridge.headingCommand(r.state, 'section', 'Method')!;
  expect(r.bridge.applyCommand(c)).toBe('applied');
  r.check();
  const out = r.src;
  expect(out).toBe('Before \n\n\\section{Method}\n\n% a note\nafter the note.\n\nNext.\n');
  expect(out).toContain('\\section{Method}');
  // The heading is on a line of its own and no comment text swallowed it.
  const line = out.split('\n').find((l) => l.includes('\\section{Method}'))!;
  expect(line).toBe('\\section{Method}');
  expect(out).not.toMatch(/%[^\n]*\\section/);
  expect(r.state.doc.children.some((n) => n.type.name === 'heading')).toBe(true);
  // Every block of text that was there still is.
  expect(out).toContain('% a note');
  expect(out).toContain('after the note.');
});

test('a heading put at the end of a paragraph whose last line ends in a comment is not commented out', () => {
  for (const tail of ['', '\n']) {
    const r = replica(`Before text % a note${tail}`);
    const tb = textblocks(r)[0];
    r.select(tb.start + tb.size);
    const c = r.bridge.headingCommand(r.state, 'section', 'Method')!;
    expect(r.bridge.applyCommand(c)).toBe('applied');
    r.check();
    const line = r.src.split('\n').find((l) => l.includes('\\section'))!;
    expect(line).toBe('\\section{Method}');
    expect(r.src).not.toMatch(/\n{3}/);
    expect(r.state.doc.children.map((n) => n.type.name)).toEqual(['paragraph', 'heading']);
  }
});

// Enter and Backspace in a list item.
const LIST =
  'Intro.\n\n\\begin{itemize}\n  \\item item uno\n  \\item item dos\n\\end{itemize}\n\nOutro.\n';
const items = (r: ReturnType<typeof replica>) =>
  textblocks(r)
    .filter((t) => !t.para)
    .slice(0);
const enterAt = (r: ReturnType<typeof replica>, at: number) => {
  const tr = r.state.tr.split(at);
  return r.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2))));
};

test('Enter in a list item opens a new \\item with the same indentation', () => {
  // At the end of an item.
  let r = replica(LIST);
  let li = items(r);
  expect(enterAt(r, li[0].start + li[0].size)).toBe(true);
  expect(r.src).toBe(
    LIST.replace('item uno\n', 'item uno\n  \\item \n').replace(
      '  \\item item dos',
      '  \\item item dos',
    ),
  );
  r.check();
  expect(items(r).length).toBe(3);
  // In the middle of an item, and in the last item.
  r = replica(LIST);
  li = items(r);
  expect(enterAt(r, li[0].start + 4)).toBe(true);
  expect(r.src).toBe(LIST.replace('item uno', 'item\n  \\item  uno'));
  r.check();
  r = replica(LIST);
  li = items(r);
  expect(enterAt(r, li[1].start + li[1].size)).toBe(true);
  expect(r.src).toBe(LIST.replace('item dos\n', 'item dos\n  \\item \n'));
  r.check();
  // Tabs are copied; an \item on the \begin line gives no indentation.
  r = replica('\\begin{itemize}\n\t\\item a\n\t\\item b\n\\end{itemize}\n');
  li = items(r);
  expect(enterAt(r, li[1].start + 1)).toBe(true);
  expect(r.src).toBe('\\begin{itemize}\n\t\\item a\n\t\\item b\n\t\\item \n\\end{itemize}\n');
  r.check();
  r = replica('\\begin{itemize}\\item a\n\\item b\n\\end{itemize}\n');
  li = items(r);
  expect(enterAt(r, li[0].start + 1)).toBe(true);
  expect(r.src).toBe('\\begin{itemize}\\item a\n\\item \n\\item b\n\\end{itemize}\n');
  r.check();
});

test('text typed in the item Enter opened goes after \\item, and Backspace undoes the Enter', () => {
  const r = replica(LIST);
  const li = items(r);
  expect(enterAt(r, li[0].start + li[0].size)).toBe(true);
  const fresh = items(r)[1];
  expect(r.dispatch(r.state.tr.insertText('New', fresh.start))).toBe(true);
  expect(r.src).toBe(LIST.replace('item uno\n', 'item uno\n  \\item New\n'));
  r.check();
  // Enter then Backspace gives back the original bytes, at the end of an item and mid-word.
  for (const where of ['end', 'mid']) {
    const q = replica(LIST);
    const a = items(q)[0];
    expect(enterAt(q, a.start + (where === 'end' ? a.size : 2))).toBe(true);
    expect(q.src).not.toBe(LIST);
    const b = items(q)[1];
    expect(q.dispatch(q.state.tr.join(b.start - 1))).toBe(true);
    expect(q.src).toBe(LIST);
    q.check();
  }
});

test('Enter inside \\emph{} or in an empty item changes nothing', () => {
  const emph = '\\begin{itemize}\n  \\item a \\emph{bc} d\n\\end{itemize}\n';
  const r = replica(emph);
  const li = items(r)[0];
  expect(enterAt(r, li.start + 3)).toBe(false);
  expect(r.src).toBe(emph);
  r.check();
  const empty = '\\begin{itemize}\n  \\item \n  \\item two\n\\end{itemize}\n';
  const e = replica(empty);
  enterAt(e, items(e)[0].start);
  expect(e.src).toBe(empty);
  e.check();
  expect(items(e).length).toBe(2);
});

test('one replica splits an item while another types in it, and both converge', () => {
  const r = replica(LIST);
  const { b, merge } = peer(r);
  const li = items(r)[0];
  expect(enterAt(r, li.start + li.size)).toBe(true);
  const lb = items(b)[0];
  expect(b.dispatch(b.state.tr.insertText('!', lb.start + lb.size))).toBe(true);
  merge();
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(r.ydoc));
  expect(b.src).toBe(r.src);
  r.check();
  b.check();
  expect(items(r).length).toBe(3);
});

test('typing into an empty list item puts the text right after its \\item', () => {
  const src = '\\begin{itemize}\n  \\item \n  \\item Three\n\\end{itemize}\n';
  const r = replica(src);
  expect(r.dispatch(r.state.tr.insertText('X', items(r)[0].start))).toBe(true);
  expect(r.src).toBe('\\begin{itemize}\n  \\item X\n  \\item Three\n\\end{itemize}\n');
  r.check();
});
