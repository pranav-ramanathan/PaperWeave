// docs/grammar-benchmark.md says how the checker does on labelled sentences
// (fixtures/grammar/corpus.json). It is written by this test from what the checker answers:
// WRITE_BENCHMARK=1 SANDBOX=1 pnpm vitest run packages/server/src/grammar-benchmark
// Needs the grammar checker of infra/compose.yaml.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inProse, prose } from '@paperweave/latex';
import { expect, test } from 'vitest';
import { NEVER } from './grammar.ts';
import { TEST_ENV } from './testing.ts';

const ROOT = join(import.meta.dirname, '../../..');
const DOC = join(ROOT, 'docs/grammar-benchmark.md');
const corpus: {
  about: string;
  mistakes: { kind: string; latex: string; find: string[] }[];
  clean: string[];
} = JSON.parse(readFileSync(join(ROOT, 'fixtures/grammar/corpus.json'), 'utf8'));

type Match = { offset: number; length: number; rule: { id: string } };
/** What the checker points at in a paragraph, as the product would show it. */
async function findings(latex: string, language: string) {
  const src = `\\begin{document}\n${latex}\n\\end{document}\n`;
  const { annotation, segments } = prose(src);
  const res = await fetch(`${TEST_ENV.GRAMMAR_URL}/v2/check`, {
    method: 'POST',
    body: new URLSearchParams({
      data: JSON.stringify({ annotation }),
      language,
      disabledRules: NEVER.join(','),
    }),
  });
  const { matches } = (await res.json()) as { matches: Match[] };
  const hard = matches.filter((m) =>
    segments.some((s) => s.kind === 'hard' && s.from < m.offset + m.length && s.to > m.offset),
  );
  return {
    shown: matches
      .filter((m) => inProse(segments, m.offset, m.offset + m.length))
      .map((m) => ({ words: src.slice(m.offset, m.offset + m.length), rule: m.rule.id })),
    // Findings that touch something that is not prose. They are never shown.
    dropped: hard.length,
  };
}

test('the checker on the labelled sentences', async () => {
  const software = (
    (await (await fetch(`${TEST_ENV.GRAMMAR_URL}/v2/check?language=en-GB&text=ok`)).json()) as {
      software: { name: string; version: string };
    }
  ).software;
  const kinds = [...new Set(corpus.mistakes.map((m) => m.kind))];
  const found: Record<string, number> = {};
  const missed: string[] = [];
  for (const m of corpus.mistakes) {
    const { shown } = await findings(m.latex, 'en-GB');
    const hit = shown.some((f) =>
      m.find.some((w) => f.words.trim() === w.trim() || f.words.includes(w) || w.includes(f.words)),
    );
    if (hit) found[m.kind] = (found[m.kind] ?? 0) + 1;
    else missed.push(`- ${m.kind}: \`${m.latex}\``);
  }
  const wrong: string[] = [];
  let dropped = 0;
  for (const latex of corpus.clean) {
    const answer = await findings(latex, 'en-GB');
    dropped += answer.dropped;
    for (const f of answer.shown) wrong.push(`- \`${f.rule}\` on "${f.words}" in: \`${latex}\``);
  }
  // British text read as American: the spellings are pointed at, which is what choosing
  // American English is for.
  const american = (
    await Promise.all(corpus.clean.map((latex) => findings(latex, 'en-US')))
  ).flatMap((a) => a.shown.map((f) => f.words));

  const total = corpus.mistakes.length;
  const hits = total - missed.length;
  const flagged = new Set(wrong.map((w) => w.slice(w.indexOf('in: '))));
  const of = (kind: string) => corpus.mistakes.filter((m) => m.kind === kind).length;
  const doc = [
    '# Grammar benchmark',
    '',
    `How ${software.name} ${software.version}, run as in \`infra/compose.yaml\` and asked the way the`,
    'product asks it, does on the labelled sentences in `fixtures/grammar/corpus.json`. This file is',
    'written by `packages/server/src/grammar-benchmark.sandbox.test.ts` and that test fails when',
    'the checker no longer answers this way.',
    '',
    corpus.about,
    '',
    '## Mistakes found',
    '',
    `${hits} of ${total} sentences with a mistake had it pointed at.`,
    '',
    '| Kind | Found | Of |',
    '| --- | --- | --- |',
    ...kinds.map((k) => `| ${k} | ${found[k] ?? 0} | ${of(k)} |`),
    '',
    missed.length ? 'Missed:' : 'None missed.',
    ...(missed.length ? ['', ...missed] : []),
    '',
    '## Correct text left alone',
    '',
    `${corpus.clean.length - flagged.size} of ${corpus.clean.length} correct sentences, each with the LaTeX a paper has`,
    'around its prose, had nothing pointed at.',
    '',
    wrong.length ? 'Pointed at wrongly:' : 'Nothing was pointed at wrongly.',
    ...(wrong.length ? ['', ...wrong] : []),
    '',
    `The checker also answered ${dropped} ${dropped === 1 ? 'time' : 'times'} about something that is not prose (a`,
    'formula, a citation, a command). Those answers are dropped before anyone sees them, so they',
    'are not counted above.',
    '',
    '## British and American',
    '',
    'The correct sentences are British. Read as American English, these words are pointed at:',
    `${[...new Set(american)].map((w) => `"${w}"`).join(', ') || 'none'}.`,
    '',
    '## What this does not show',
    '',
    '- How it does on real manuscripts. These sentences were written for the purpose.',
    '- Mistakes of meaning, which no rule-based checker finds.',
    '- Another engine. LanguageTool is the one the spec names; nothing here was a reason to look',
    '  further.',
    '',
  ].join('\n');
  if (process.env.WRITE_BENCHMARK) writeFileSync(DOC, doc);
  expect(existsSync(DOC) ? readFileSync(DOC, 'utf8') : '').toBe(doc);
  // The floor the product is held to, whatever the document says.
  expect(hits / total).toBeGreaterThanOrEqual(0.8);
  expect(flagged.size / corpus.clean.length).toBeLessThanOrEqual(0.15);
}, 120_000);
