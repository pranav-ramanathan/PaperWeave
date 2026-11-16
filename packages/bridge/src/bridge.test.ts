import { fragment, rng } from '../../latex/src/testutil.ts';
import { TextSelection } from '@tiptap/pm/state';
import { expect, test } from 'vitest';
import * as Y from 'yjs';
import { fixtures, replica, shown, textblocks, visualOp } from './harness.ts';
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

test('an edit the visual editor cannot express is refused and changes nothing', () => {
  const r = replica(DOC);
  const [a, b] = textblocks(r);
  let refused = 0;
  r.bridge.onReject = () => refused++;
  // Deleting across two paragraphs, and deleting a whole block.
  expect(r.dispatch(r.state.tr.delete(a.start + 2, b.start + 2))).toBe(false);
  expect(r.dispatch(r.state.tr.delete(0, r.state.doc.child(0).nodeSize))).toBe(false);
  expect(refused).toBe(2);
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
  for (const k of ['ins', 'del', 'rep', 'enter', 'join', 'emph'])
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
