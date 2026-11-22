import { floatParts } from '../../latex/src/floats.ts';
import { fragment, rng, soup } from '../../latex/src/testutil.ts';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { fixtures, replica, shown, textblocks, visualOp } from './harness.ts';
import { contained, DEFAULT_TRANSPARENT, parse } from '@paperweave/latex';
import type { Command } from './bridge.ts';
import { fromSrc, toSrc } from './project.ts';
import { needs, pasteable } from './clipboard.ts';
import { schema } from './schema.ts';
import { getTextBetween, getTextSerializersFromSchema } from '@tiptap/core';

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

/** Type `text` at display offset `off` of text block `k` (deleting `del`); returns the source. */
function typedIn(src: string, k: number, off: number, text: string, del = 0) {
  const r = replica(src);
  const start = textblocks(r)[k].start + off;
  expect(r.dispatch(r.state.tr.insertText(text, start, start + del)), src).toBe(true);
  r.check();
  return r;
}

test('a [ or * typed where LaTeX looks past spaces for an argument is kept as text', () => {
  const LIST1 = '\\begin{itemize}\n\\item One\n\\item See [1] here\n\\end{itemize}\n';
  // Start of an item.
  let r = typedIn(LIST1, 0, 0, '[1] ');
  expect(r.src).toContain('\\item {}[1] One');
  expect(shown(r)).toContain('[1] One');
  // Deleting what stood before it.
  r = typedIn(LIST1, 1, 0, '', 4);
  expect(r.src).toContain('\\item {}[1] here');
  expect(shown(r)).toContain('[1] here');
  // Enter just before it.
  r = replica(LIST1);
  const at = textblocks(r)[1].start + 4;
  const tr = r.state.tr.split(at);
  expect(r.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2))))).toBe(true);
  r.check();
  expect(r.src).toContain('\\item See \n\\item {}[1] here');
  // The first paragraph of a theorem or a proof.
  for (const env of ['theorem', 'proof']) {
    const T = `\\begin{${env}}\nLet $K$ be compact.\n\\end{${env}}\n`;
    r = typedIn(T, 0, 0, '[0,1] or ');
    expect(r.src).toContain(`\\begin{${env}}\n{}[0,1] or Let`);
    expect(shown(r)).toContain('[0,1] or Let');
  }
  // After a line break, with a space or a newline between.
  for (const src of ['a\\\\ b\n', 'a\\\\\nb\n']) {
    r = typedIn(src, 0, 2, '[x]');
    expect(r.src, src).toMatch(/\\\\\s*\{\}\[x\]/);
    expect(shown(r)).toContain('[x]');
    r = typedIn(src, 0, 2, '*');
    expect(r.src, src).toMatch(/\\\\\s*\{\}\*/);
    expect(shown(r)).toContain('*');
  }
});

test('a [ typed where LaTeX takes no argument stays unguarded', () => {
  // After a blank line, after a style command's group, in the middle of a sentence.
  expect(typedIn('\\begin{theorem}\n\nSome.\n\\end{theorem}\n', 0, 0, '[1] ').src).not.toContain(
    '{}',
  );
  expect(typed('See \\textbf{x} here.\n', 6, '[1] ')).toBe('See \\textbf{x} [1] here.\n');
  expect(typed('One two.\n', 4, '[1] ')).toBe('One [1] two.\n');
  expect(typed('a\n\nb\n', 3, '[1] ')).toBe('a\n\n[1] b\n');
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
  expect(counts.drop, 'drop').toBeGreaterThan(N / 500);
});

test(`${N} interleavings of visual and source edits converge with nothing lost`, () => {
  const base = fixtures['article-basic/main.tex'];
  const para = base.indexOf('Collaborative editors');
  const paraEnd = base.indexOf('Our contributions');
  // SEED=n replays just that seed.
  const only = process.env.SEED === undefined ? undefined : Number(process.env.SEED);
  for (let seed = only ?? 0; seed < (only === undefined ? N : only + 1); seed++) {
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

test('a command never splits an emoji, so both replicas keep the same text', () => {
  const a = replica('ab\u{1F600}cd\n');
  const b = replica('', a.ydoc);
  const start = textblocks(a)[0].start;
  // A selection that ends between the two halves of the emoji (the editor counts UTF-16 units).
  for (const [from, to] of [
    [0, 3],
    [3, 5],
    [3, 3],
  ]) {
    a.select(start + from, start + to);
    const c = a.bridge.emphCommand(a.state);
    if (c) expect(a.bridge.applyCommand(c)).toBe('applied');
    a.check();
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc), 'net');
    expect(b.src, `${from}-${to}`).toBe(a.src);
    expect(a.src).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
  }
  // The caret between the halves: an insertion there is refused as well.
  a.select(start + 3);
  expect(a.bridge.insertCommand(a.state, '\\x')).toBeNull();
  expect(a.bridge.headingCommand(a.state, 'section', 'T')).toBeNull();
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

// Starting a list from the visual view, and leaving it with Enter in its empty last item.
/** Put the caret at display offset `off` of paragraph `n` and insert a list; the replica, or null. */
function listed(src: string, n: number, off: number, ordered = false) {
  const r = replica(src);
  r.select(textblocks(r).filter((t) => t.para)[n].start + off);
  const c = r.bridge.listCommand(r.state, ordered);
  if (!c) return null;
  expect(r.bridge.applyCommand(c)).toBe('applied');
  r.check();
  return r;
}
const EMPTY = '\\begin{itemize}\n\\item \n\\end{itemize}';

test('a list put in the middle of a paragraph splits it', () => {
  expect(listed('One.\n\nTwo here.\n\nThree.\n', 1, 3)!.src).toBe(
    `One.\n\nTwo\n\n${EMPTY}\n\n here.\n\nThree.\n`,
  );
  expect(listed('One.\n\nTwo\nhere.\n', 1, 3)!.src).toBe(`One.\n\nTwo\n\n${EMPTY}\n\nhere.\n`);
});

test('a list at either end of a paragraph leaves no run of three line breaks', () => {
  const src = 'One.\n\nTwo here.\n\nThree.\n';
  expect(listed(src, 1, 0)!.src).toBe(`One.\n\n${EMPTY}\n\nTwo here.\n\nThree.\n`);
  expect(listed(src, 1, 9)!.src).toBe(`One.\n\nTwo here.\n\n${EMPTY}\n\nThree.\n`);
  for (const [n, off] of [
    [0, 0],
    [0, 4],
    [1, 0],
    [1, 9],
    [2, 0],
    [2, 6],
  ])
    expect(listed(src, n, off)!.src).not.toMatch(/\n{3}/);
  expect(listed('Only.', 0, 0)!.src).toBe(`${EMPTY}\n\nOnly.`);
  expect(listed('Only.', 0, 5)!.src).toBe(`Only.\n\n${EMPTY}\n\n`);
  expect(listed('Only.\n', 0, 5)!.src).toBe(`Only.\n\n${EMPTY}\n\n`);
});

test('a numbered list is an enumerate', () => {
  expect(listed('One.\n\nTwo.\n', 1, 4, true)!.src).toBe(
    'One.\n\nTwo.\n\n\\begin{enumerate}\n\\item \n\\end{enumerate}\n\n',
  );
});

test('the new list is one empty item, the caret resolves in it, and typing fills it', () => {
  const r = listed('One.\n\nTwo here.\n', 1, 3)!;
  const kinds = r.state.doc.children.map((n) => n.type.name);
  expect(kinds).toEqual(['paragraph', 'paragraph', 'list', 'paragraph']);
  const list = r.state.doc.child(2);
  expect(list.childCount).toBe(1);
  expect(list.child(0).type.name).toBe('list_item');
  expect(list.child(0).content.size).toBe(0);
  const caret = fromSrc(r.bridge.model, r.state.doc, r.src.indexOf('\\item ') + '\\item '.length);
  expect(r.state.doc.resolve(caret).parent.type.name).toBe('list_item');
  r.select(caret);
  expect(r.dispatch(r.state.tr.insertText('x', caret))).toBe(true);
  expect(r.src).toContain('\\item x\n\\end{itemize}');
  r.check();
});

test('a list is refused in an item, a heading, a caption and a paragraph not yet written', () => {
  const src =
    '\\section{Head}\n\n\\begin{itemize}\n\\item One\n\\end{itemize}\n\nText.\n\n\\begin{figure}\n\\caption{Cap}\n\\end{figure}\n';
  const r = replica(src);
  const blocks: { start: number; type: string }[] = [];
  r.state.doc.descendants((n, pos) => {
    if (n.isTextblock) blocks.push({ start: pos + 1, type: n.type.name });
  });
  expect(blocks.map((b) => b.type)).toEqual(['heading', 'list_item', 'paragraph']);
  for (const b of blocks.slice(0, 2)) {
    r.select(b.start + 1);
    expect(r.bridge.listCommand(r.state, false)).toBeNull();
  }
  r.select(blocks[2].start + 1);
  expect(r.bridge.listCommand(r.state, false)).not.toBeNull();
  // The caption is inside a raw block: it has no text block, so no caret can be put in it.
  const pre = replica('\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n');
  pre.select(1);
  expect(pre.bridge.listCommand(pre.state, false)).toBeNull();
  const p = replica('One.\n');
  const first = textblocks(p)[0];
  const tr = p.state.tr.split(first.start + first.size);
  p.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(first.start + first.size + 2))));
  expect(p.bridge.model.phantom).not.toBeNull();
  expect(p.bridge.listCommand(p.state, false)).toBeNull();
});

test('Enter in the empty last item takes that \\item away and leaves the caret after the list', () => {
  const src = 'Intro.\n\n\\begin{itemize}\n  \\item one\n  \\item two\n  \\item \n\\end{itemize}\n';
  const r = replica(src);
  expect(items(r).length).toBe(3);
  expect(enterAt(r, items(r)[2].start)).toBe(true);
  expect(r.src).toBe('Intro.\n\n\\begin{itemize}\n  \\item one\n  \\item two\n\\end{itemize}\n');
  expect(r.bridge.model.phantom).not.toBeNull();
  r.check();
  expect(r.state.doc.children.map((n) => n.type.name)).toEqual(['paragraph', 'list', 'paragraph']);
  expect(r.state.doc.child(1).childCount).toBe(2);
  // The caret is in the paragraph after the list; typing there writes after \end{itemize}.
  const $h = r.state.selection.$head;
  expect($h.depth).toBe(1);
  expect($h.index(0)).toBe(2);
  expect(r.dispatch(r.state.tr.insertText('x', r.state.selection.head))).toBe(true);
  expect(r.src).toBe(
    'Intro.\n\n\\begin{itemize}\n  \\item one\n  \\item two\n\\end{itemize}\n\nx\n',
  );
  r.check();
  expect(r.state.doc.children.map((n) => n.type.name)).toEqual(['paragraph', 'list', 'paragraph']);
});

test('Enter in a middle or a sole empty item still does nothing', () => {
  for (const src of [
    '\\begin{itemize}\n  \\item \n  \\item two\n\\end{itemize}\n',
    '\\begin{itemize}\n  \\item \n\\end{itemize}\n',
  ]) {
    const r = replica(src);
    enterAt(r, items(r)[0].start);
    expect(r.src).toBe(src);
    r.check();
    expect(r.bridge.model.phantom).toBeNull();
  }
});

test('a list started, filled, left and written after, on two replicas that converge', () => {
  const r = listed('One.\n\nTwo.\n', 1, 4)!;
  const { b, merge } = peer(r);
  const at = r.src.indexOf('\\item ') + '\\item '.length;
  let caret = fromSrc(r.bridge.model, r.state.doc, at);
  r.select(caret);
  r.dispatch(r.state.tr.insertText('a', caret));
  expect(enterAt(r, items(r)[0].start + 1)).toBe(true);
  r.select(items(r)[1].start);
  r.dispatch(r.state.tr.insertText('b', items(r)[1].start));
  expect(enterAt(r, items(r)[1].start + 1)).toBe(true);
  expect(enterAt(r, items(r)[2].start)).toBe(true);
  caret = r.state.selection.head;
  r.dispatch(r.state.tr.insertText('c', caret));
  merge();
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(r.ydoc));
  expect(b.src).toBe(r.src);
  expect(r.src).toBe(
    'One.\n\nTwo.\n\n\\begin{itemize}\n\\item a\n\\item b\n\\end{itemize}\n\nc\n\n',
  );
  r.check();
  b.check();
});

// Bold works as emphasis does, with \textbf.
/** Select display offsets [a, b) of paragraph `n`, toggle `mark`, and return the replica. */
function marked(src: string, a: number, b: number, mark: 'emph' | 'textbf', n = 0) {
  const r = replica(src);
  const t = textblocks(r).filter((x) => x.para)[n];
  r.select(t.start + a, t.start + b);
  const c = r.bridge.markCommand(r.state, mark);
  if (!c) return null;
  expect(r.bridge.applyCommand(c)).toBe('applied');
  r.check();
  return r;
}

test('bold wraps the selection in \\textbf and a second press removes exactly those bytes', () => {
  const src = 'Alpha beta gamma.\n\nDelta.\n';
  const on = marked(src, 6, 10, 'textbf')!;
  expect(on.src).toBe('Alpha \\textbf{beta} gamma.\n\nDelta.\n');
  const t = textblocks(on)[0];
  on.select(t.start + 6, t.start + 10);
  const off = on.bridge.markCommand(on.state, 'textbf')!;
  expect(off.replacement).toBe('beta');
  expect(on.bridge.applyCommand(off)).toBe('applied');
  expect(on.src).toBe(src);
  on.check();
  // Emphasis is the same command with another name.
  expect(marked(src, 6, 10, 'emph')!.src).toBe('Alpha \\emph{beta} gamma.\n\nDelta.\n');
});

test('bold inside and around emphasis leaves the other mark alone', () => {
  const nested = 'A \\emph{\\textbf{xy}} B.\n';
  // Bold off, with emphasis outside it; emphasis off, with bold inside it.
  expect(marked(nested, 2, 4, 'textbf')!.src).toBe('A \\emph{xy} B.\n');
  expect(marked(nested, 2, 4, 'emph')!.src).toBe('A \\textbf{xy} B.\n');
  // Bold on, inside emphasis and around it.
  expect(marked('A \\emph{xy} B.\n', 2, 4, 'textbf')!.src).toBe('A \\emph{\\textbf{xy}} B.\n');
  expect(marked('A \\emph{xy} B.\n', 0, 6, 'textbf')!.src).toBe('\\textbf{A \\emph{xy} B}.\n');
  // Part of the emphasised text: a new mark inside, the old one stays.
  expect(marked('A \\emph{xyz} B.\n', 2, 3, 'textbf')!.src).toBe('A \\emph{\\textbf{x}yz} B.\n');
  // A selection that ends inside a group it did not start in does not nest: refused.
  expect(marked('\\textbf{A \\emph{xy}}\n', 0, 4, 'textbf')).toBeNull();
});

test('bold is refused where emphasis is refused', () => {
  const r = replica('Text \\newcommand{\\todo}[1]{x} end.\n\nSecond one.\n');
  const [a, b] = textblocks(r);
  r.select(a.start, a.start + 8);
  expect(r.bridge.markCommand(r.state, 'textbf')).toBeNull();
  // Across two paragraphs, and with no selection.
  r.select(a.start, b.start + 2);
  expect(r.bridge.markCommand(r.state, 'textbf')).toBeNull();
  r.select(b.start + 1);
  expect(r.bridge.markCommand(r.state, 'textbf')).toBeNull();
  // Over parts of two groups, which would not nest.
  expect(marked('A \\emph{xy} B \\emph{zw}.\n', 3, 9, 'textbf')).toBeNull();
});

test('bold made on one replica and typing on another converge', () => {
  const r = replica('Alpha beta gamma.\n');
  const { b, merge } = peer(r);
  const t = textblocks(r)[0];
  r.select(t.start + 6, t.start + 10);
  const c = r.bridge.markCommand(r.state, 'textbf')!;
  const tb = textblocks(b)[0];
  expect(b.dispatch(b.state.tr.insertText('!', tb.start + 17))).toBe(true);
  expect(r.bridge.applyCommand(c)).toBe('applied');
  merge();
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(r.ydoc));
  expect(b.src).toBe(r.src);
  expect(r.src).toBe('Alpha \\textbf{beta} gamma.!\n');
  r.check();
  b.check();
});

// Deleting a whole block from the visual view.
type Rep = ReturnType<typeof replica>;
/** Delete the top-level node at `index`, as Backspace or Delete on a selected block does. */
function dropAt(r: Rep, index: number) {
  let at = 0;
  for (let i = 0; i < index; i++) at += r.state.doc.child(i).nodeSize;
  return r.dispatch(r.state.tr.delete(at, at + r.state.doc.child(index).nodeSize));
}
/** Index of the first top-level node of a type, or the n-th. */
const nodeIndex = (r: Rep, type: string, nth = 0) => {
  const found: number[] = [];
  r.state.doc.forEach((n, _o, i) => void (n.type.name === type && found.push(i)));
  return found[nth];
};
const dropped = (src: string, type: string, nth = 0) => {
  const r = replica(src);
  expect(dropAt(r, nodeIndex(r, type, nth)), src).toBe(true);
  r.check();
  return r.src;
};

test('deleting a display formula leaves the blank lines as they were', () => {
  const M = '\\[x\\]';
  // Single newlines: no paragraph break appears.
  expect(dropped(`A\n${M}\nB`, 'math_block')).toBe('A\nB');
  expect(dropped(`A\n${M}\nB\n`, 'math_block')).toBe('A\nB\n');
  // Double newlines: exactly one blank line stays.
  expect(dropped(`A\n\n${M}\n\nB\n`, 'math_block')).toBe('A\n\nB\n');
  // Only one side holds the blank line: it is kept, whichever side it is.
  expect(dropped(`A\n${M}\n\nB\n`, 'math_block')).toBe('A\n\nB\n');
  expect(dropped(`A\n\n${M}\nB\n`, 'math_block')).toBe('A\n\nB\n');
  // An equation put in the middle of a break leaves one newline on one side and three on the
  // other: removing it gives the break back.
  expect(dropped(`A\n${M}\n\n\nB\n`, 'math_block')).toBe('A\n\nB\n');
  expect(dropped(`A\n\n\n${M}\nB\n`, 'math_block')).toBe('A\n\nB\n');
  expect(dropped(`A\n\n\n${M}\n\nB\n`, 'math_block')).toBe('A\n\nB\n');
  // Several blank lines on both sides: one stays.
  expect(dropped(`A\n\n\n${M}\n\n\n\nB\n`, 'math_block')).toBe('A\n\nB\n');
  // The start and the end of the file.
  expect(dropped(`${M}\n\nB\n`, 'math_block')).toBe('B\n');
  expect(dropped(`${M}\nB\n`, 'math_block')).toBe('B\n');
  expect(dropped(`A\n\n${M}\n`, 'math_block')).toBe('A\n');
  expect(dropped(`A\n\n${M}`, 'math_block')).toBe('A');
  expect(dropped(`A\n${M}`, 'math_block')).toBe('A');
  expect(dropped(`A\n\n${M}\n\n`, 'math_block')).toBe('A\n\n');
  expect(dropped(`${M}\n`, 'math_block')).toBe('');
  expect(dropped(M, 'math_block')).toBe('');
  // Next to another block, with and without blank lines between.
  expect(dropped(`${M}\n\\[y\\]\n`, 'math_block')).toBe('\\[y\\]\n');
  expect(dropped(`${M}\n\n\\[y\\]\n`, 'math_block', 1)).toBe(`${M}\n`);
  expect(dropped(`A\n\n${M}\n\\[y\\]\n\nB\n`, 'math_block')).toBe('A\n\n\\[y\\]\n\nB\n');
  expect(dropped(`A\n\n${M}\n\\[y\\]\n\nB\n`, 'math_block', 1)).toBe(`A\n\n${M}\n\nB\n`);
  // The other display forms.
  expect(dropped('A\n\n$$x$$\n\nB\n', 'math_block')).toBe('A\n\nB\n');
  expect(dropped('A\n\n\\begin{equation}\n  x\n\\end{equation}\n\nB\n', 'math_block')).toBe(
    'A\n\nB\n',
  );
});

test('deleting a figure, a table or a lone label takes only that block', () => {
  const fig = '\\begin{figure}\n  \\caption{Cap}\n  \\label{fig:a}\n\\end{figure}';
  const tab = '\\begin{table}\n\\begin{tabular}{c}\na\n\\end{tabular}\n\\end{table}';
  const src = `Intro.\n\n${fig}\n\n${tab}\n\nOutro.\n`;
  let r = replica(src);
  expect(dropAt(r, nodeIndex(r, 'raw_block', 0))).toBe(true);
  expect(r.src).toBe(`Intro.\n\n${tab}\n\nOutro.\n`);
  r.check();
  r = replica(src);
  expect(dropAt(r, nodeIndex(r, 'raw_block', 1))).toBe(true);
  expect(r.src).toBe(`Intro.\n\n${fig}\n\nOutro.\n`);
  r.check();
  expect(dropped('A\n\n\\label{sec:a}\n\nB\n', 'raw_block')).toBe('A\n\nB\n');
  expect(dropped('\\begin{verbatim}\nx\n\\end{verbatim}\n\nB\n', 'raw_block')).toBe('B\n');
});

test('deleting an empty heading or a list of one empty item removes the whole block', () => {
  expect(dropped('A\n\n\\section{}\n\nB\n', 'heading')).toBe('A\n\nB\n');
  expect(dropped('\\subsection{}\nB\n', 'heading')).toBe('B\n');
  expect(dropped('A\n\n\\section{Keep}\n\n\\section{}\n', 'heading', 1)).toBe(
    'A\n\n\\section{Keep}\n',
  );
  expect(dropped('A\n\n\\begin{itemize}\n  \\item \n\\end{itemize}\n\nB\n', 'list')).toBe(
    'A\n\nB\n',
  );
  expect(dropped('A\n\n\\begin{enumerate}\n\\item\n\\end{enumerate}\n', 'list')).toBe('A\n');
});

test('deleting a block inside a document keeps the preamble and the end intact', () => {
  const pre = '\\documentclass{article}\n\\begin{document}\n';
  const post = '\\end{document}\n';
  expect(dropped(`${pre}\n\\section{}\n\nText.\n${post}`, 'heading')).toBe(
    `${pre}\nText.\n${post}`,
  );
  expect(dropped(`${pre}Text.\n\n\\[x\\]\n${post}`, 'math_block')).toBe(`${pre}Text.\n\n${post}`);
  expect(dropped(`${pre}\\[x\\]\n${post}`, 'math_block')).toBe(`${pre}${post}`);
});

test('a block whose removal would glue two commands is separated', () => {
  expect(dropped('\\LaTeX\\[x\\]foo\n', 'math_block')).toBe('\\LaTeX{}foo\n');
});

test('a block that is not a whole formula, figure, label, empty heading or list is refused', () => {
  const cases: [string, string, number?][] = [
    ['\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n', 'raw_block', 0],
    ['\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n', 'raw_block', 1],
    ['\\begin{document}\nA\n\\end{document}\n', 'raw_block', 0],
    ['A\n\n\\begin{theorem}\nT\n\\end{theorem}\n', 'raw_block', 0],
    ['A\n\n\\begin{theorem}\nT\n\\end{theorem}\n', 'raw_block', 1],
    ['A\n\n\\newcommand{\\x}{y}\n\nB\n', 'raw_block', 0],
    ['A\n\n\\input{other}\n\nB\n', 'raw_block', 0],
    ['A\n\n\\maketitle\n\nB\n', 'raw_block', 0],
    ['A\n\n% a comment\n\nB\n', 'raw_block', 0],
    ['A\n\n\\label{a} % why\n\nB\n', 'raw_block', 0],
    ['A\n\n\\section{Title}\n\nB\n', 'heading', 0],
    ['A\n\n\\begin{itemize}\n\\item Full\n\\end{itemize}\n\nB\n', 'list', 0],
    ['A\n\n\\begin{itemize}\n\\item \n\\item \n\\end{itemize}\n\nB\n', 'list', 0],
    ['A\n\n\\begin{itemize}\n\\item\n\\item x\n\\end{itemize}\n\nB\n', 'list', 0],
    ['A\n\n\\end{itemize}\n\nB\n', 'frozen', 0],
  ];
  for (const [src, type, nth] of cases) {
    const r = replica(src);
    const i = nodeIndex(r, type, nth ?? 0);
    expect(i, `${type} in ${JSON.stringify(src)}`).toBeDefined();
    expect(dropAt(r, i), JSON.stringify(src)).toBe(false);
    expect(r.src).toBe(src);
    r.check();
  }
});

test('typing over a selected block is refused', () => {
  const src = 'A\n\n\\[x\\]\n\nB\n';
  const r = replica(src);
  const at = r.state.doc.child(0).nodeSize;
  const size = r.state.doc.child(1).nodeSize;
  expect(r.dispatch(r.state.tr.insertText('hello', at, at + size))).toBe(false);
  expect(r.src).toBe(src);
  r.check();
});

test('two equal blocks side by side: the one chosen goes', () => {
  const src = '\\label{x}\n\n\\label{x}\nB\n';
  let r = replica(src);
  expect(dropAt(r, 0)).toBe(true);
  expect(r.src).toBe('\\label{x}\nB\n');
  r.check();
  r = replica(src);
  expect(dropAt(r, 1)).toBe(true);
  expect(r.src).toBe('\\label{x}\n\nB\n');
  r.check();
});

test('a paragraph opened with Enter further down survives a block deleted above it', () => {
  const r = replica('A\n\n\\[x\\]\n\nB\n');
  const tr = r.state.tr.split(r.state.doc.content.size - 1);
  const end = tr.doc.content.size;
  expect(r.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(end - 1))))).toBe(true);
  expect(r.bridge.model.phantom).not.toBeNull();
  expect(dropAt(r, 1)).toBe(true);
  expect(r.src).toBe('A\n\nB\n');
  r.check();
  expect(r.bridge.model.phantom?.index).toBe(2);
});

test('one replica deletes a block while another types in the next paragraph, and both converge', () => {
  for (const [src, typedIn] of [
    ['A\n\n\\[x\\]\n\nB\n', 1],
    ['A\n\n\\[x\\]\nB\n', 1],
    ['A\n\\[x\\]\n\nB\n', 1],
    ['A\n\n\\[x\\]\n\nB\n', 0],
  ] as const) {
    const r = replica(src);
    const { b, merge } = peer(r);
    const tb = textblocks(b)[typedIn];
    expect(b.dispatch(b.state.tr.insertText('typed', tb.start + 1))).toBe(true);
    expect(dropAt(r, nodeIndex(r, 'math_block'))).toBe(true);
    merge();
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(r.ydoc));
    expect(b.src).toBe(r.src);
    expect(r.src).not.toContain('\\[x\\]');
    expect(r.src.split('typed').length - 1).toBe(1);
    r.check();
    b.check();
    expect(r.state.doc.eq(b.state.doc)).toBe(true);
  }
});

test('one replica deletes a block while another edits inside it: nothing is left half-deleted', () => {
  const r = replica('A\n\n\\begin{figure}\n\\caption{Cap}\n\\end{figure}\n\nB\n');
  const { b, merge } = peer(r);
  const at = b.src.indexOf('Cap') + 1;
  b.ytext.insert(at, 'zz');
  expect(dropAt(r, nodeIndex(r, 'raw_block'))).toBe(true);
  merge();
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(r.ydoc));
  expect(b.src).toBe(r.src);
  r.check();
  b.check();
});

test('undoing the deletion of a block restores every byte', () => {
  const srcs = [
    'A\n\n\\[x\\]\n\nB\n',
    'A\n\\[x\\]\nB\n',
    'A\n\n\\[x\\]\nB\n',
    '\\[x\\]\n\nB\n',
    'A\n\n\\[x\\]',
    '\\LaTeX\\[x\\]foo\n',
    'A\n\n\\begin{figure}\n\\caption{C}\n\\end{figure}\n\nB\n',
    'A\n\n\\section{}\n\nB\n',
    'A\n\n\\begin{itemize}\n  \\item \n\\end{itemize}\n\nB\n',
    'A\n\n\\label{x}\n',
  ];
  for (const src of srcs) {
    const r = replica(src);
    const um = new Y.UndoManager(r.ytext, { trackedOrigins: new Set([r.bridge]) });
    const i =
      r.state.doc.childCount -
      1 -
      [...Array(r.state.doc.childCount).keys()]
        .reverse()
        .findIndex((k) =>
          ['math_block', 'raw_block', 'heading', 'list'].includes(r.state.doc.child(k).type.name),
        );
    expect(dropAt(r, i), src).toBe(true);
    expect(r.src).not.toBe(src);
    um.undo();
    expect(r.src, src).toBe(src);
    r.check();
    um.redo();
    expect(r.src).not.toBe(src);
    um.undo();
    expect(r.src).toBe(src);
  }
});

const ELSEVIER = fixtures['real-elsevier/main.tex'];

test('typing in an abstract inside frontmatter splices only those bytes, and undo restores them', () => {
  const r = replica(ELSEVIER);
  const um = new Y.UndoManager(r.ytext, { trackedOrigins: new Set([r.bridge]) });
  const tb = textblocks(r).find(
    (t) => r.state.doc.textBetween(t.start, t.start + 10) === 'River gaug',
  )!;
  expect(tb, 'the abstract is a paragraph').toBeDefined();
  expect(r.dispatch(r.state.tr.insertText('really ', tb.start + 'River gauges are '.length))).toBe(
    true,
  );
  r.check();
  const at = ELSEVIER.indexOf('read far more');
  expect(r.src).toBe(ELSEVIER.slice(0, at) + 'really ' + ELSEVIER.slice(at));
  um.undo();
  expect(r.src).toBe(ELSEVIER);
  r.check();
});

test('a citation in the acknowledgments opens in the atom window and its rewrite is accepted', () => {
  const src = `\\begin{acknowledgments}\nThanks to the crews \\cite{a}.\n\\end{acknowledgments}\n`;
  const r = replica(src);
  const { out } = rewrite(r, '\\cite{a}', '\\citep{a}');
  expect(typeof out).toBe('object');
  expect(r.bridge.applyCommand(out as Command)).toBe('applied');
  expect(r.src).toBe(src.replace('\\cite{a}', '\\citep{a}'));
  r.check();
});

describe("a paper's own theorem environment", () => {
  const OBS = '\\begin{observation}\nWords \\cite{a} here.\n\\end{observation}\n\nAfter.\n';
  const own = new Set([...DEFAULT_TRANSPARENT, 'observation']);

  test('typing inside it splices only those bytes', () => {
    const r = replica(OBS, undefined, { transparent: own });
    const tb = textblocks(r)[0];
    expect(r.dispatch(r.state.tr.insertText('new ', tb.start + 'Words '.length))).toBe(true);
    expect(r.src).toBe(OBS.replace('Words ', 'Words new '));
    r.check();
    // Without the name it is one raw block: nothing in it is typed into.
    expect(shown(replica(OBS))).not.toContain('Words');
  });

  test('a contained command carries the set, and applyCommand applies it', () => {
    const r = replica(OBS, undefined, { transparent: own });
    const { out } = rewrite(r, '\\cite{a}', '\\cite{b}');
    expect(out).toMatchObject({ contained: true, prose: ['observation'] });
    expect(r.bridge.applyCommand(out as Command)).toBe('applied');
    expect(r.src).toBe(OBS.replace('\\cite{a}', '\\cite{b}'));
    r.check();
  });

  test('the default set sends no names', () => {
    const r = replica('Use \\cite{a} now.\n');
    const { out } = rewrite(r, '\\cite{a}', '\\cite{b}');
    expect(out).toMatchObject({ contained: true });
    expect(out).not.toHaveProperty('prose');
  });

  test('a command made for a set the replica does not hold is a conflict', () => {
    const maker = replica(OBS, undefined, { transparent: own });
    const { out } = rewrite(maker, '\\cite{a}', '\\cite{b}');
    // Another replica of the same text, with the default set: the atom is not in prose there.
    const r = replica(OBS);
    const c = {
      ...(out as Command),
      from: Y.createRelativePositionFromTypeIndex(r.ytext, OBS.indexOf('\\cite')),
      to: Y.createRelativePositionFromTypeIndex(r.ytext, OBS.indexOf('\\cite') + 8),
    };
    expect(r.bridge.applyCommand(c)).toBe('conflict');
  });
});

// Delete or type over a selection that runs from one list item into another.
const wrap = (...rows: string[]) => `\\begin{itemize}\n${rows.join('\n')}\n\\end{itemize}\n`;
const L3 = wrap('  \\item one two', '  \\item three four', '  \\item five six');

/** Select item i at offset o to item j at offset p, then delete (no text) or type `text` over it. */
function overItems(src: string, i: number, o: number, j: number, p: number, text = '') {
  const r = replica(src);
  const li = items(r);
  const from = li[i].start + o;
  const to = li[j].start + p;
  r.select(from, to);
  const ok = r.dispatch(text ? r.state.tr.insertText(text, from, to) : r.state.tr.delete(from, to));
  return { r, ok };
}

test('deleting from the middle of one item into the middle of the next joins them', () => {
  const { r, ok } = overItems(L3, 0, 4, 1, 3);
  expect(ok).toBe(true);
  expect(r.src).toBe(wrap('  \\item one ee four', '  \\item five six'));
  r.check();
  expect(items(r).length).toBe(2);
});

test('deleting across three items takes the one between whole', () => {
  const { r, ok } = overItems(L3, 0, 4, 2, 5);
  expect(ok).toBe(true);
  expect(r.src).toBe(wrap('  \\item one six'));
  r.check();
});

test('typing over a selection across items replaces it with the typed text', () => {
  const { r, ok } = overItems(L3, 0, 4, 1, 3, 'X');
  expect(ok).toBe(true);
  expect(r.src).toBe(wrap('  \\item one Xee four', '  \\item five six'));
  r.check();
  const t = overItems(L3, 0, 3, 2, 5, 'a_b');
  expect(t.ok).toBe(true);
  expect(t.r.src).toBe(wrap('  \\item onea\\_bsix'.replace('onea', 'one' + 'a')));
  t.r.check();
});

test('selecting from the start of the first item to the end of the last leaves one empty \\item', () => {
  const { r, ok } = overItems(L3, 0, 0, 2, 'five six'.length);
  expect(ok).toBe(true);
  expect(r.src).toBe(wrap('  \\item '));
  r.check();
  expect(items(r).length).toBe(1);
});

test('a selection ending at the start of an item removes the \\item before it', () => {
  const { r, ok } = overItems(L3, 0, 4, 1, 0);
  expect(ok).toBe(true);
  expect(r.src).toBe(wrap('  \\item one three four', '  \\item five six'));
  r.check();
});

test('a first item that ends in a comment loses the comment with its tail, and the line stays valid', () => {
  const src = wrap('  \\item one% note', '  \\item two', '  \\item three');
  for (const [text, out] of [
    ['', 'onewo'],
    ['Q', 'oneQwo'],
  ]) {
    const { r, ok } = overItems(src, 0, 3, 1, 1, text);
    expect(ok).toBe(true);
    expect(r.src).toBe(wrap(`  \\item ${out}`, '  \\item three'));
    r.check();
  }
});

test('tab and space indentation are both left alone', () => {
  for (const ind of ['\t', '    ', '']) {
    const src = wrap(`${ind}\\item aa bb`, `${ind}\\item cc dd`, `${ind}\\item ee ff`);
    const { r, ok } = overItems(src, 0, 3, 2, 3);
    expect(ok, JSON.stringify(ind)).toBe(true);
    expect(r.src).toBe(wrap(`${ind}\\item aa ff`));
    r.check();
  }
});

test('a selection across items is refused when an end sits inside \\emph, or when it leaves a paragraph', () => {
  const emph = wrap('  \\item a \\emph{bc} d', '  \\item two');
  let { r, ok } = overItems(emph, 0, 3, 1, 1);
  expect(ok).toBe(false);
  expect(r.src).toBe(emph);
  r.check();
  ({ r, ok } = overItems(wrap('  \\item a', '  \\item \\emph{bc} d'), 0, 1, 1, 1));
  expect(ok).toBe(false);
  r.check();
  // Paragraph to item would orphan the \begin.
  const src = `Intro text.\n\n${L3}`;
  const q = replica(src);
  const p = textblocks(q).filter((t) => t.para)[0];
  const li = items(q)[1];
  q.select(p.start + 3, li.start + 2);
  expect(q.dispatch(q.state.tr.delete(p.start + 3, li.start + 2))).toBe(false);
  expect(q.src).toBe(src);
  q.check();
});

test('a macro definition inside the removed items is refused', () => {
  const src = wrap('  \\item aa', '  \\item \\newcommand{\\z}{1}', '  \\item bb');
  const { r, ok } = overItems(src, 0, 1, 2, 1);
  expect(ok).toBe(false);
  expect(r.src).toBe(src);
  r.check();
});

test('two replicas converge when one edits across items and the other types in a middle one', () => {
  const r = replica(L3);
  const { b, merge } = peer(r);
  r.select(items(r)[0].start + 4, items(r)[2].start + 5);
  expect(r.dispatch(r.state.tr.delete(items(r)[0].start + 4, items(r)[2].start + 5))).toBe(true);
  const mid = items(b)[1];
  expect(b.dispatch(b.state.tr.insertText('!', mid.start + 2))).toBe(true);
  merge();
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(r.ydoc));
  expect(b.src).toBe(r.src);
  r.check();
  b.check();
});

test('undo restores every byte of a deletion or type-over across items', () => {
  for (const text of ['', 'Q']) {
    const r = replica(L3);
    const um = new Y.UndoManager(r.ytext, { trackedOrigins: new Set([r.bridge]) });
    const from = items(r)[0].start + 4;
    const to = items(r)[2].start + 5;
    r.select(from, to);
    expect(
      r.dispatch(text ? r.state.tr.insertText(text, from, to) : r.state.tr.delete(from, to)),
    ).toBe(true);
    expect(r.src).not.toBe(L3);
    um.undo();
    expect(r.src).toBe(L3);
    r.check();
    um.redo();
    expect(r.src).toBe(wrap(`  \\item one ${text}six`));
    um.undo();
    expect(r.src).toBe(L3);
  }
});

describe('< > | typed in the visual view', () => {
  const SRC = 'We found p, see a b.\n';

  test('are written as commands, show as themselves, and Backspace removes each whole', () => {
    for (const [ch, cmd] of [
      ['<', '\\textless{}'],
      ['>', '\\textgreater{}'],
      ['|', '\\textbar{}'],
    ]) {
      const r = replica(SRC);
      const tb = textblocks(r)[0];
      expect(r.dispatch(r.state.tr.insertText(ch + ' ', tb.start + 9))).toBe(true);
      r.check();
      expect(r.src).toBe(`We found ${cmd} p, see a b.\n`);
      expect(shown(r)).toBe(`We found ${ch} p, see a b.`);
      // Backspace over the character takes the whole command.
      const at = textblocks(r)[0].start + 9; // the character after "We found "
      expect(r.dispatch(r.state.tr.delete(at, at + 1))).toBe(true);
      r.check();
      expect(r.src).toBe('We found  p, see a b.\n');
    }
  });

  test('two replicas typing them converge', () => {
    const r = replica(SRC);
    const { b, merge } = peer(r);
    expect(r.dispatch(r.state.tr.insertText('<', textblocks(r)[0].start + 3))).toBe(true);
    expect(b.dispatch(b.state.tr.insertText('|', textblocks(b)[0].start + 14))).toBe(true);
    merge();
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(r.ydoc));
    expect(b.src).toBe(r.src);
    expect(r.src).toContain('\\textless{}');
    expect(r.src).toContain('\\textbar{}');
    r.check();
    b.check();
  });

  test('a bare one already in the source shows as itself and its bytes are not touched', () => {
    const src = 'We found p < 0.05 and n > 30, see a | b.\n';
    const r = replica(src);
    expect(shown(r)).toBe('We found p < 0.05 and n > 30, see a | b.');
    expect(r.dispatch(r.state.tr.insertText('X', textblocks(r)[0].start))).toBe(true);
    expect(r.src).toBe('X' + src);
    r.check();
  });
});

describe('invisible and unusual space characters typed in the visual view', () => {
  const SRC = 'Hello world.\n';
  const ZW = '\u200b';

  test('a thin or narrow space is written as \\, and the rest of the text as typed', () => {
    const r = replica(SRC);
    const tb = textblocks(r)[0];
    expect(r.dispatch(r.state.tr.insertText('x\u202f!', tb.start + 6))).toBe(true);
    r.check();
    expect(r.src).toBe('Hello x\\,!world.\n');
  });

  test('a zero-width character alone changes nothing in the source or the document', () => {
    const r = replica(SRC);
    const tb = textblocks(r)[0];
    r.dispatch(r.state.tr.insertText(ZW, tb.start + 6));
    r.check();
    expect(r.src).toBe(SRC);
    expect(r.state.doc.textContent).not.toContain(ZW);
  });

  test('one typed right after a macro adds no {}', () => {
    const r = replica('\\LaTeX is\n');
    const tb = textblocks(r)[0];
    r.dispatch(r.state.tr.insertText(ZW, tb.start + 1));
    r.check();
    expect(r.src).toBe('\\LaTeX is\n');
  });

  test('one typed over a selection deletes the selection', () => {
    const r = replica(SRC);
    const tb = textblocks(r)[0];
    r.dispatch(r.state.tr.insertText(ZW, tb.start + 6, tb.start + 11));
    r.check();
    expect(r.src).toBe('Hello .\n');
    expect(r.state.doc.textContent).not.toContain(ZW);
  });

  test('one typed in a just-opened phantom paragraph leaves the source alone', () => {
    const r = replica('One.\n');
    const first = textblocks(r)[0];
    const tr = r.state.tr.split(first.start + first.size);
    r.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(first.start + first.size + 2))));
    expect(r.bridge.model.phantom).not.toBeNull();
    r.dispatch(r.state.tr.insertText(ZW, r.state.selection.head));
    r.check();
    expect(r.src).toBe('One.\n');
    expect(r.state.doc.textContent).not.toContain(ZW);
  });
});

describe('" typed in the visual view', () => {
  const SRC = 'We found p, see a b.\n';

  test('is written as \\symbol{34}, shows as itself, and Backspace removes it whole', () => {
    const r = replica(SRC);
    const tb = textblocks(r)[0];
    expect(r.dispatch(r.state.tr.insertText('"x" ', tb.start + 9))).toBe(true);
    r.check();
    expect(r.src).toBe('We found \\symbol{34}x\\symbol{34} p, see a b.\n');
    expect(shown(r)).toBe('We found "x" p, see a b.');
    const at = textblocks(r)[0].start + 9;
    expect(r.dispatch(r.state.tr.delete(at, at + 1))).toBe(true);
    r.check();
    expect(r.src).toBe('We found x\\symbol{34} p, see a b.\n');
  });

  test('two replicas typing it converge', () => {
    const r = replica(SRC);
    const { b, merge } = peer(r);
    expect(r.dispatch(r.state.tr.insertText('"', textblocks(r)[0].start + 3))).toBe(true);
    expect(b.dispatch(b.state.tr.insertText('"', textblocks(b)[0].start + 14))).toBe(true);
    merge();
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(r.ydoc));
    expect(b.src).toBe(r.src);
    expect(r.src.match(/\\symbol\{34\}/g)).toHaveLength(2);
    r.check();
    b.check();
  });

  test('a bare one already in the source shows as itself and its bytes are not touched', () => {
    const src = 'He said "hi" and left.\n';
    const r = replica(src);
    expect(shown(r)).toBe('He said "hi" and left.');
    expect(r.dispatch(r.state.tr.insertText('X', textblocks(r)[0].start))).toBe(true);
    expect(r.src).toBe('X' + src);
    r.check();
  });
});

describe('cut and paste of a stretch of source', () => {
  const SENT =
    'The effect was significant ($p < 0.05$) as shown by \\cite{smith2020} in Figure~\\ref{fig:a}\\footnote{See appendix.}, with p \\textless{} 0.05 in 50\\% of \\emph{all} cases.';
  const SRC = `${SENT}\n\nSecond paragraph here.\n`;
  const selectFirst = (r: ReturnType<typeof replica>) => {
    const tb = textblocks(r)[0];
    r.select(tb.start, tb.start + tb.size);
  };

  test('sourceOf is the selected source, byte for byte', () => {
    const r = replica(SRC);
    selectFirst(r);
    expect(r.bridge.sourceOf(r.state)).toBe(SENT);
    // Part of a paragraph, from the first word to just before the formula.
    const tb = textblocks(r)[0];
    r.select(tb.start + 4, tb.start + 25);
    expect(r.bridge.sourceOf(r.state)).toBe(SENT.slice(4, 25));
    // Nothing selected: nothing to say.
    r.select(tb.start + 3);
    expect(r.bridge.sourceOf(r.state)).toBeNull();
  });

  test('the default text serializer keeps formulas and citations', () => {
    const r = replica(SRC);
    const tb = textblocks(r)[0];
    const text = getTextBetween(
      r.state.doc,
      { from: tb.start, to: tb.start + tb.size },
      { textSerializers: getTextSerializersFromSchema(schema) },
    );
    expect(text).toContain('$p < 0.05$');
    expect(text).toContain('\\cite{smith2020}');
    expect(text).toContain('\\ref{fig:a}');
    expect(text).toContain('\\footnote{See appendix.}');
  });

  test('cut, then insert at another paragraph, loses nothing', () => {
    const r = replica(SRC);
    selectFirst(r);
    const latex = r.bridge.sourceOf(r.state)!;
    expect(r.dispatch(r.state.tr.deleteSelection())).toBe(true);
    r.check();
    const tbs = textblocks(r);
    r.select(tbs[tbs.length - 1].start + tbs[tbs.length - 1].size);
    const c = r.bridge.insertCommand(r.state, latex)!;
    expect(r.bridge.applyCommand(c)).toBe('applied');
    r.check();
    for (const part of [
      '$p < 0.05$',
      '\\cite{smith2020}',
      'Figure~\\ref{fig:a}',
      '\\footnote{See appendix.}',
      '\\emph{all}',
      '\\textless{}',
      '50\\%',
    ])
      expect(r.src).toContain(part);
    expect(r.src).toContain(`Second paragraph here.${SENT}`);
  });

  test('several paragraphs come with their breaks', () => {
    const src = 'One \\emph{a} b.\n\nTwo $x$ c.\n\nThree d.\n';
    const r = replica(src);
    const tbs = textblocks(r);
    r.select(tbs[0].start + 2, tbs[2].start + 3);
    expect(r.bridge.sourceOf(r.state)).toBe(src.slice(2, src.indexOf('Three') + 3));
  });

  test('half of a group, or of a block, is not offered', () => {
    const r = replica('A \\emph{bc de} f.\n');
    const tb = textblocks(r)[0];
    r.select(tb.start + 4, tb.start + 9); // "c de f" runs out of the emphasis
    expect(r.bridge.sourceOf(r.state)).toBeNull();
    r.select(tb.start + 2, tb.start + 4); // "bc" is inside it, balanced
    expect(r.bridge.sourceOf(r.state)).toBe('bc');
    const l = replica('Before.\n\n\\begin{itemize}\n\\item one\n\\item two\n\\end{itemize}\n');
    const t = textblocks(l);
    l.select(t[0].start + 2, t[1].start + 2);
    expect(l.bridge.sourceOf(l.state)).toBeNull();
  });

  test('the paste check refuses what would change the text around it', () => {
    for (const bad of [
      'a { b',
      'a } b',
      '\\begin{itemize} x',
      'x \\end{itemize}',
      '\\begin{a} x \\end{b}',
      '\\end{document}',
      '\\documentclass{article}',
      '\\usepackage{x} y',
      'text % a comment',
      'a $b',
      'a \\[ b',
      'ends with \\',
      '',
      '   ',
    ])
      expect(pasteable(bad), bad).toBe(false);
    for (const ok of [
      SENT,
      'a \\{ b \\} c \\% d',
      'x % note\ny',
      'a\n\nb \\begin{itemize}\\item q\\end{itemize}',
      '$$x$$ and $y$ and \\(z\\)',
      '\\\\% a comment\nz',
    ])
      expect(pasteable(ok), ok).toBe(true);
  });
});

describe('text put in by a command is guarded as typed text is', () => {
  /** Put `latex` where the caret is, through the command path, and return the source. */
  const put = (src: string, at: (r: ReturnType<typeof replica>) => number, latex: string) => {
    const r = replica(src);
    r.select(at(r));
    const c = r.bridge.fillCommand(r.bridge.insertCommand(r.state, '')!, latex);
    expect(r.bridge.applyCommand(c)).toBe('applied');
    r.check();
    return r.src;
  };
  const start = (i: number) => (r: ReturnType<typeof replica>) => textblocks(r)[i].start;
  const end = (i: number) => (r: ReturnType<typeof replica>) =>
    textblocks(r)[i].start + textblocks(r)[i].size;
  const LIST = (item: string) => `\\begin{itemize}\n\\item ${item}\n\\end{itemize}\n`;

  test('a [ at the start of an item does not become its label', () => {
    expect(put(LIST('Run it.'), start(0), '[Optional] ')).toBe(LIST('{}[Optional] Run it.'));
  });

  test('cut guarded text, paste at the start of another item', () => {
    const src = `\\begin{itemize}\n\\item {}[Optional] Run it.\n\\item Stop.\n\\end{itemize}\n`;
    const r = replica(src);
    r.select(textblocks(r)[0].start, textblocks(r)[0].start + textblocks(r)[0].size);
    const latex = r.bridge.sourceOf(r.state)!;
    expect(latex).toContain('[Optional] Run it.');
    expect(r.dispatch(r.state.tr.deleteSelection())).toBe(true);
    r.select(textblocks(r)[1].start);
    const c = r.bridge.fillCommand(r.bridge.insertCommand(r.state, '')!, latex);
    expect(r.bridge.applyCommand(c)).toBe('applied');
    r.check();
    expect(r.src).toContain('\\item {}[Optional] Run it.Stop.');
  });

  test('paragraphs starting with [ at an item start', () => {
    expect(put(LIST('Run it.'), start(0), '[1] First.\n\nSecond.')).toContain(
      '\\item {}[1] First.',
    );
  });

  test('a command name is not joined to the word after it, or before it', () => {
    expect(put('Then go.\n', start(0), 'so on\\ldots')).toBe('so on\\ldots{}Then go.\n');
    const after = put('A \\ldots\n', end(0), 'and');
    expect(after).toBe('A \\ldots{}and\n');
  });

  test('text put after a comment starts on a new line', () => {
    const r = replica('Para text % TODO check\n\nNext.\n');
    r.select(end(0)(r));
    const c = r.bridge.fillCommand(r.bridge.insertCommand(r.state, '')!, 'Pasted $x$.');
    expect(r.bridge.applyCommand(c)).toBe('applied');
    expect(r.src).toContain('% TODO check\nPasted $x$.');
  });

  test('plain words after a space are left as they are', () => {
    expect(put('A b.\n', (r) => textblocks(r)[0].start + 2, 'word ')).toBe('A word b.\n');
    expect(put('Figure x\n', (r) => textblocks(r)[0].start + 7, '~\\ref{a}')).toBe(
      'Figure ~\\ref{a}x\n',
    );
  });
});

describe('block-level text only goes where LaTeX can take it', () => {
  const LIST =
    'Before.\n\n\\begin{itemize}\n\\item alpha \\textbf{bold}\n\\item two\n\\end{itemize}\n\n';
  const caretIn = (r: ReturnType<typeof replica>, tb: number, at: number) =>
    r.select(textblocks(r)[tb].start + at);

  test('blockPlace names the block the caret is at the top level of', () => {
    const r = replica(`\\section{Head}\n\n${LIST}Text \\emph{inside} here.\n`);
    // heading, list items, paragraph
    const tbs = textblocks(r);
    r.select(tbs[0].start + 2);
    expect(r.bridge.blockPlace(r.state)).toBeNull();
    r.select(tbs[1].start + 2);
    expect(r.bridge.blockPlace(r.state)).toBe('para');
    r.select(tbs[2].start + 2);
    expect(r.bridge.blockPlace(r.state)).toBe('item');
    r.select(tbs[2].start + 'alpha '.length + 2); // inside \textbf
    expect(r.bridge.blockPlace(r.state)).toBeNull();
    r.select(tbs[4].start + 'Text '.length + 2); // inside \emph
    expect(r.bridge.blockPlace(r.state)).toBeNull();
    r.select(tbs[4].start + 2);
    expect(r.bridge.blockPlace(r.state)).toBe('para');
  });

  test('a heading or a list is refused inside a group', () => {
    const r = replica('a \\emph{bcd} e.\n');
    caretIn(r, 0, 4);
    expect(r.bridge.headingCommand(r.state, 'section', 'T')).toBeNull();
    expect(r.bridge.listCommand(r.state, false)).toBeNull();
    caretIn(r, 0, 1);
    expect(r.bridge.headingCommand(r.state, 'section', 'T')).not.toBeNull();
    expect(r.bridge.listCommand(r.state, false)).not.toBeNull();
  });

  test('needs', () => {
    expect(needs('alpha\n\\item two')).toBe('item');
    expect(needs('\\begin{itemize}\n\\item a\n\\end{itemize}')).toBe('block');
    expect(needs('a $x$ b')).toBe('inline');
    expect(needs('a\n\nb')).toBe('block');
    expect(needs('a \\[x\\] b')).toBe('block');
    expect(needs('a \\section{T} b')).toBe('block');
    expect(needs('a\n\\item b\n\n')).toBe('item');
  });

  test('none of the failing pastes and inserts writes a source LaTeX cannot take', () => {
    // Copy across two items.
    const l = replica(LIST + 'Para text.\n');
    const tbs = textblocks(l);
    l.select(tbs[1].start + 2, tbs[2].start + 2);
    const slice = l.bridge.sourceOf(l.state);
    expect(slice).not.toBeNull();
    {
      expect(needs(slice!)).toBe('item');
      l.select(tbs[3].start + 2);
      expect(l.bridge.accepts(l.state, slice!)).toBe(false);
      // At an item's top level it is accepted, and splits the item correctly.
      l.select(tbs[2].start + 2);
      expect(l.bridge.accepts(l.state, slice!)).toBe(true);
      const c = l.bridge.insertCommand(l.state, slice!)!;
      expect(l.bridge.applyCommand(c)).toBe('applied');
      l.check();
      expect(parse(l.src).blocks.length).toBeGreaterThan(0);
      expect(l.src).toContain('\\item twpha \\textbf{bold}\n\\item two\n\\end{itemize}');
    }
    // Two paragraphs, caret in a heading or inside \emph.
    for (const [src, at] of [
      ['\\section{Intro}\n\nx\n', 3],
      ['a \\emph{bcd} e.\n', 4],
    ] as const) {
      const r = replica(src);
      r.select(textblocks(r)[0].start + at);
      expect(r.bridge.blockPlace(r.state)).toBeNull();
      expect(r.bridge.accepts(r.state, 'P one.\n\nP two.')).toBe(false);
      expect(r.bridge.headingCommand(r.state, 'section', 'T')).toBeNull();
      expect(r.bridge.listCommand(r.state, true)).toBeNull();
    }
    // Plain words stay fine anywhere.
    const h = replica('\\section{Intro}\n');
    h.select(textblocks(h)[0].start + 3);
    expect(h.bridge.accepts(h.state, 'a $x$ b')).toBe(true);
  });
});

// A float (figure, table) goes after the paragraph the caret is in, not at the caret.
const FLOAT = '\\begin{figure}[t]\n  \\caption{A.}\n\\end{figure}';
/** Insert FLOAT (as the dialog hands it over, in line breaks) for the caret at offset `off` of paragraph `n`. */
function floated(src: string, n: number, off: number) {
  const r = replica(src);
  r.select(textblocks(r).filter((t) => t.para)[n].start + off);
  const c = r.bridge.floatCommand(r.state, `\n${FLOAT}\n`);
  if (!c) return null;
  expect(r.bridge.applyCommand(c)).toBe('applied');
  r.check();
  return r.src;
}

test('a float with the caret mid-sentence keeps the paragraph whole and goes after it', () => {
  const src = 'One.\n\nAs shown before \\cite{a} and more.\nSecond line.\n\nThree.\n';
  const out = floated(src, 1, 'As shown before'.length)!;
  expect(out).toBe(
    `One.\n\nAs shown before \\cite{a} and more.\nSecond line.\n\n${FLOAT}\n\nThree.\n`,
  );
  expect(out).not.toMatch(/\n{3}/);
  expect(out).toContain('before \\cite{a} and more.');
});

test('a float at the end of a paragraph, and at the start, go after it with no run of three line breaks', () => {
  const src = 'One.\n\nTwo here.\n\nThree.\n';
  for (const off of [0, 4, 9]) {
    const out = floated(src, 1, off)!;
    expect(out).toBe(`One.\n\nTwo here.\n\n${FLOAT}\n\nThree.\n`);
    expect(out).not.toMatch(/\n{3}/);
  }
});

test('a float in the last paragraph of a file goes after it, with or without a final line break', () => {
  expect(floated('One.\n\nLast bit.', 1, 4)).toBe(`One.\n\nLast bit.\n\n${FLOAT}\n\n`);
  expect(floated('One.\n\nLast bit.\n', 1, 4)).toBe(`One.\n\nLast bit.\n\n${FLOAT}\n\n`);
  expect(floated('Only.', 0, 0)).toBe(`Only.\n\n${FLOAT}\n\n`);
  expect(floated('Only.\n', 0, 5)).not.toMatch(/\n{3}/);
});

test('a float whose paragraph ends in a comment is not commented out', () => {
  const out = floated('One.\n\nText here % a note\n\nNext.\n', 1, 4)!;
  expect(out.split('\n')).toContain('\\begin{figure}[t]');
  expect(out).toBe(`One.\n\nText here % a note\n\n${FLOAT}\n\nNext.\n`);
});

test('a float where the caret is not in a paragraph is put at the caret, as before', () => {
  const r = replica(LIST);
  const li = items(r);
  r.select(li[0].start + 4);
  const c = r.bridge.floatCommand(r.state, '\nX\n')!;
  expect(c.replacement).toBe('\nX\n');
  expect(r.bridge.applyCommand(c)).toBe('applied');
  r.check();
});

test('a float after a paragraph is refused if the text around its place was deleted, and replicas converge', () => {
  const r = replica(FLOW);
  r.select(textblocks(r).filter((t) => t.para)[1].start + 3);
  const c = r.bridge.floatCommand(r.state, `\n${FLOAT}\n`)!;
  const { b, merge } = peer(r);
  // Someone else types in the next paragraph meanwhile.
  b.ytext.insert(b.src.indexOf('Three.') + 6, ' More.');
  merge();
  expect(r.bridge.applyCommand(c)).toBe('applied');
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(r.ydoc));
  expect(b.src).toBe(r.src);
  expect(r.src).toBe(`One.\n\nTwo here.\n\n${FLOAT}\n\nThree. More.\n`);
  r.check();
  b.check();
  // And with the paragraph deleted by another replica, it is refused rather than moved.
  const r2 = replica(FLOW);
  r2.select(textblocks(r2).filter((t) => t.para)[1].start + 3);
  const c2 = r2.bridge.floatCommand(r2.state, `\n${FLOAT}\n`)!;
  const p = peer(r2);
  p.b.ytext.delete(p.b.src.indexOf('Two here.'), 'Two here.\n\n'.length);
  p.merge();
  expect(r2.bridge.applyCommand(c2)).toBe('conflict');
  expect(r2.src).toBe('One.\n\nThree.\n');
});
