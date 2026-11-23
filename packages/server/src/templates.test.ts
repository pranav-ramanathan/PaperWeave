import { expect, test } from 'vitest';
import { TEMPLATES } from './templates.ts';

test.each(TEMPLATES.map((t) => [t.id, t] as const))(
  'the %s template loads graphicx, which the Figure dialog needs',
  (_id, t) => {
    const main = t.files['main.tex'];
    const preamble = main.slice(0, main.indexOf('\\begin{document}'));
    expect(preamble).toMatch(/\\usepackage(\[[^\]]*\])?\{graphicx\}/);
  },
);
