import { DEFAULT_TRANSPARENT } from '@paperweave/latex';
import { expect, test } from 'vitest';
import { markerOf } from './marker';

const T = DEFAULT_TRANSPARENT;
const own = new Set([...T, 'obs']);

test('a lone label is a label marker with its key', () => {
  expect(markerOf('\\label{sec:intro}', 'label', T)).toEqual({ kind: 'label', text: 'sec:intro' });
});

test('a begin line names its environment, and its optional title if plain', () => {
  expect(markerOf('\\begin{theorem}[Convergence]', 'theorem', T)).toEqual({
    kind: 'begin',
    text: 'Theorem (Convergence)',
  });
  expect(markerOf('\\begin{proof}', 'proof', T)).toEqual({ kind: 'begin', text: 'Proof' });
  expect(markerOf('\\begin{multicols}{2}', 'multicols', T)?.text).toBe('Multicols');
  expect(markerOf('\\begin{multicols*}{2}', 'multicols*', T)?.text).toBe('Multicols');
  expect(markerOf('\\begin{theorem}[$x$ \\emph{a}]', 'theorem', T)?.text).toBe('Theorem');
  expect(markerOf('\\begin{theorem}[a][b]', 'theorem', T)?.text).toBe('Theorem');
});

test('an end line says what ended', () => {
  expect(markerOf('\\end{theorem}', 'end', T)).toEqual({ kind: 'end', text: 'End of theorem' });
  expect(markerOf('\\end{multicols*}', 'end', T)?.text).toBe('End of multicols');
});

test('the end of the document is a marker only when nothing follows it', () => {
  expect(markerOf('\\end{document}\n', 'end document', T)).toEqual({
    kind: 'end-document',
    text: 'End of document',
  });
  expect(markerOf('\\end{document}\nstray', 'end document', T)).toBeNull();
});

test('an environment the paper declares is a marker only while it is in the set', () => {
  expect(markerOf('\\begin{obs}', 'obs', own)?.text).toBe('Obs');
  expect(markerOf('\\end{obs}', 'end', own)?.text).toBe('End of obs');
  expect(markerOf('\\begin{obs}', 'obs', T)).toBeNull();
  expect(markerOf('\\end{obs}', 'end', T)).toBeNull();
});

test('everything else stays a box', () => {
  expect(markerOf('\\label{a} % note', 'label', T)).toBeNull();
  expect(markerOf('\\label{a{b}}', 'label', T)).toBeNull();
  expect(markerOf('\\documentclass{article}\n\\begin{document}', 'source only', T)).toBeNull();
  expect(markerOf('\\documentclass{article}', 'documentclass', T)).toBeNull();
  expect(markerOf('\\maketitle', 'maketitle', T)).toBeNull();
  expect(markerOf('\\begin{figure}\n\\end{figure}', 'figure', T)).toBeNull();
  expect(markerOf('\\begin{figure}', 'figure', T)).toBeNull();
  expect(markerOf('\\input{x}', 'input', T)).toBeNull();
  expect(markerOf('% \\label{a}', 'label', T)).toBeNull();
  expect(markerOf('\\label{a}', 'end', T)).toBeNull();
});
