import { expect, test } from 'vitest';
import { graphicsPaths, includeGraph } from './graph.ts';

test('\\graphicspath folders are read, and a comment hides them', () => {
  expect(graphicsPaths('\\graphicspath{{a/}{b/c/}}')).toEqual(['a/', 'b/c/']);
  expect(graphicsPaths('\\graphicspath{ {figs/} }')).toEqual(['figs/']);
  expect(graphicsPaths('% \\graphicspath{{a/}}\nx')).toEqual([]);
  expect(graphicsPaths('\\begin{document}')).toEqual([]);
});

test('a picture found through \\graphicspath is not missing', () => {
  const root = '\\graphicspath{{figures/}}\\includegraphics{plot}\\includegraphics{gone}';
  const g = includeGraph({ 'main.tex': root }, 'main.tex', ['main.tex', 'figures/plot.png']);
  expect(g.edges).toContainEqual({ from: 'main.tex', to: 'figures/plot.png', kind: 'graphics' });
  expect(g.missing.map((m) => m.target)).toEqual(['gone']);
});
