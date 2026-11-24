// docs/grammar-benchmark.md says how the checker does on labelled sentences
// (fixtures/grammar/corpus.json). It is written by this test from what the checker answers:
// WRITE_BENCHMARK=1 SANDBOX=1 pnpm vitest run packages/server/src/grammar-benchmark
// Needs the grammar checker of infra/compose.yaml.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inProse, placed, prose, readAs, spellingWords } from '@paperweave/latex';
import { expect, test } from 'vitest';
import { coined, NEVER } from './grammar.ts';
import { describeImport } from './import.ts';
import { TEST_ENV } from './testing.ts';

const ROOT = join(import.meta.dirname, '../../..');
const DOC = join(ROOT, 'docs/grammar-benchmark.md');
const corpus: {
  about: string;
  mistakes: { kind: string; latex: string; find: string[] }[];
  clean: string[];
} = JSON.parse(readFileSync(join(ROOT, 'fixtures/grammar/corpus.json'), 'utf8'));

type Match = { offset: number; length: number; rule: { id: string; category: { id: string } } };
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
  // The checker answers 503 "Server overloaded" when too many checks are queued at once.
  if (!res.ok) throw new Error(`the checker answered ${res.status}: ${await res.text()}`);
  const { matches } = (await res.json()) as { matches: Match[] };
  const hard = matches.filter((m) =>
    segments.some((s) => s.kind === 'hard' && s.from < m.offset + m.length && s.to > m.offset),
  );
  return {
    shown: matches
      .filter((m) => inProse(segments, m.offset, m.offset + m.length))
      // An abbreviation or a made-up name is not shown as misspelt.
      .filter(
        (m) =>
          m.rule.category.id !== 'TYPOS' ||
          !coined(readAs(src, segments, m.offset, m.offset + m.length)),
      )
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
  // American English is for. One at a time, as above: twenty at once filled the checker's
  // queue on a two-core runner, and it answered "Server overloaded".
  const american: string[] = [];
  for (const latex of corpus.clean)
    american.push(...(await findings(latex, 'en-US')).shown.map((f) => f.words));

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

test('mistakes in a caption and in a footnote are found where they are written, and the sentence around a footnote is left alone', async () => {
  const src = [
    '\\documentclass{article}',
    '\\usepackage{graphicx}',
    '\\begin{document}',
    '\\section{Results}',
    'The method\\footnote{See the the appendix for a longer acount.} works well on every run.',
    'It is fast.\\footnote{Measured on one machine.} We report the mean.',
    '',
    '\\begin{figure}',
    '  \\centering',
    '  \\includegraphics[width=\\linewidth]{teh-plot}',
    '  \\caption[Latency]{Merge latency by number of concurent writters\\label{fig:teh}}',
    '\\end{figure}',
    '',
    '\\begin{table}',
    '  \\caption{An summary of the runs.}',
    '  \\begin{tabular}{ll} recieve & 1 \\\\ \\end{tabular}',
    '\\end{table}',
    'The end is short.',
    '\\end{document}',
    '',
  ].join('\n');
  const { annotation, segments, asides } = prose(src);
  const res = await fetch(`${TEST_ENV.GRAMMAR_URL}/v2/check`, {
    method: 'POST',
    body: new URLSearchParams({
      data: JSON.stringify({ annotation }),
      language: 'en-GB',
      disabledRules: NEVER.join(','),
    }),
  });
  if (!res.ok) throw new Error(`the checker answered ${res.status}: ${await res.text()}`);
  const { matches } = (await res.json()) as {
    matches: { offset: number; length: number; replacements: { value: string }[] }[];
  };
  const shown = matches.flatMap((m) => {
    const at = placed(src, asides, m.offset, m.length);
    return at && inProse(segments, at[0], at[1])
      ? [{ from: at[0], words: src.slice(at[0], at[1]), first: m.replacements[0]?.value }]
      : [];
  });
  // Each where it is written, in the order they are read: the footnotes, then the captions.
  expect(shown.map((f) => f.words)).toEqual(['the the', 'acount', 'concurent', 'writters', 'An']);
  for (const f of shown) expect(f.from).toBe(src.indexOf(f.words));
  expect(shown[0].first).toBe('the');
  expect(shown[2].first).toBe('concurrent');
  expect(shown[4].first).toBe('A');
  // Nothing in the sentences the footnotes hang on, the file name, the label or the table's cell.
});

test('an abbreviation or a made-up name is not called misspelt, and a slip beside one still is', async () => {
  const src = [
    '\\documentclass{article}',
    '\\begin{document}',
    'We train a ResNet and an EfficientNet with RMSProp, and report mAP on QNLI and on MSCOCO.',
    'THe GPU-acelerated run recieved two SVHNs, a BiT-L model and word2vek features.',
    'Our Frobnet baseline uses teh same DBN-based setup.\\footnote{As in SpanBERT, with a smal change.}',
    '\\end{document}',
    '',
  ].join('\n');
  const { annotation, segments, asides } = prose(src);
  const res = await fetch(`${TEST_ENV.GRAMMAR_URL}/v2/check`, {
    method: 'POST',
    body: new URLSearchParams({
      data: JSON.stringify({ annotation }),
      language: 'en-GB',
      disabledRules: NEVER.join(','),
    }),
  });
  if (!res.ok) throw new Error(`the checker answered ${res.status}: ${await res.text()}`);
  const { matches } = (await res.json()) as {
    matches: {
      offset: number;
      length: number;
      rule: { category: { id: string } };
      replacements: { value: string }[];
    }[];
  };
  const all = matches.flatMap((m) => {
    const at = placed(src, asides, m.offset, m.length);
    return at && inProse(segments, at[0], at[1])
      ? [
          {
            words: src.slice(at[0], at[1]),
            reads: readAs(src, segments, at[0], at[1]),
            spelling: m.rule.category.id === 'TYPOS',
            first: m.replacements[0]?.value,
          },
        ]
      : [];
  });
  const shown = all.filter((f) => !(f.spelling && coined(f.reads)));
  // What the checker calls misspelt before the rule: the names too.
  expect(all.map((f) => f.words)).toEqual(
    expect.arrayContaining(['ResNet', 'RMSProp', 'mAP', 'QNLI', 'SpanBERT']),
  );
  expect(shown.map((f) => f.words)).toEqual([
    'THe',
    'GPU-acelerated',
    'recieved',
    'Frobnet',
    'teh',
    'DBN-based',
    'smal',
  ]);
  expect(shown[1].first).toBe('GPU-accelerated');
}, 60_000);

const AMERICAN =
  'color colors colored coloring behavior behaviors behavioral neighbor neighbors neighboring neighborhood ' +
  'favor favors favored favorable favorite flavor tumor tumors labor honor endeavor harbor rumor vapor armor ' +
  'odor humor rigor vigor unlabeled mislabeled labeled labeling modeling modeled remodeling traveling canceled ' +
  'signaling channeled tunneling fueled dialed totaled equaled rivaled leveled center centers centered centering ' +
  'recenter epicenter barycenter analyze analyzes analyzed analyzing analyzer reanalyze fiber fibers defense ' +
  'offense catalog catalogs distill distills skeptic skeptical skepticism fulfill fulfills fulfillment aluminum ' +
  'kilometer kilometers centimeter millimeters liter liters';
const BRITISH =
  'colour colours coloured colouring behaviour behaviours behavioural neighbour neighbours neighbouring ' +
  'neighbourhood favour favours favoured favourable favourite flavour tumour tumours labour honour endeavour ' +
  'harbour rumour vapour armour odour humour rigour vigour disfavoured discoloured centre centres centred ' +
  'centring recentre epicentre barycentre analyse analysed analysing analyser reanalysed normalise normalised ' +
  'normalising normalisation normalisations summarise summarised polarised parameterised factorised optimise ' +
  'optimised optimiser optimisers minimising maximised organise organised organising organiser recognise ' +
  'recognised recognisable utilise utilised stabilised generalise generalised initialised regularised ' +
  'localisation visualisation parametrised emphasise emphasised synthesised hypothesised criticised standardised ' +
  'quantised discretised digitised prioritised customised randomised fibre fibres defence offence licence ' +
  'programme programmes artefact artefacts distil sceptic sceptical scepticism aluminium kilometre kilometres ' +
  'centimetre millimetres metre metres litre litres';

/** Which of the words the checker calls misspelt, each asked about on a line of its own. */
async function misspelt(words: string[], language: string) {
  const text = words.map((w) => `We read ${w} here.`).join('\n\n');
  const res = await fetch(`${TEST_ENV.GRAMMAR_URL}/v2/check`, {
    method: 'POST',
    body: new URLSearchParams({ text, language }),
  });
  if (!res.ok) throw new Error(`the checker answered ${res.status}: ${await res.text()}`);
  const { matches } = (await res.json()) as {
    matches: { offset: number; length: number; rule: { category: { id: string } } }[];
  };
  const bad = new Set(
    matches
      .filter((m) => m.rule.category.id === 'TYPOS')
      .map((m) => text.slice(m.offset, m.offset + m.length)),
  );
  return words.filter((w) => bad.has(w));
}

test('a word counted as American is misspelt in British and right in American, and the other way round', async () => {
  const american = AMERICAN.split(' ');
  const british = BRITISH.split(' ');
  for (const w of american) expect([w, spellingWords(w)]).toEqual([w, { american: 1, british: 0 }]);
  for (const w of british) expect([w, spellingWords(w)]).toEqual([w, { american: 0, british: 1 }]);
  expect(await misspelt(american, 'en-GB')).toEqual(american);
  expect(await misspelt(american, 'en-US')).toEqual([]);
  expect(await misspelt(british, 'en-US')).toEqual(british);
  expect(await misspelt(british, 'en-GB')).toEqual([]);
  // What says nothing is right in both.
  const both =
    'organize normalization modelling labelled analyses arise promise premises advertise exercise improvisation laboratory honorary humorous meter program gray'.split(
      ' ',
    );
  for (const w of both) expect([w, spellingWords(w)]).toEqual([w, { american: 0, british: 0 }]);
  expect(await misspelt(both, 'en-GB')).toEqual([]);
  expect(await misspelt(both, 'en-US')).toEqual([]);
}, 60_000);

test('an American paper checked as the importer chooses shows its mistakes and not its spelling', async () => {
  const body = [
    'We model the behavior of each neighbor and color the labeled nodes.',
    'The centered plots were analyzed twice, and one recieved a new color.',
    'Modeling the tumor data took teh longest.',
  ].join('\n');
  const main = `\\documentclass{article}\n${'\\begin{document}'}\n${body}\n\\end{document}\n`;
  const { report } = describeImport([{ path: 'main.tex', bytes: Buffer.from(main) }]);
  expect(report.spelling).toEqual({ language: 'en-US', by: 'words' });
  const words = async (language: string) =>
    (await findings(body, language)).shown.map((f) => f.words);
  expect(await words(report.spelling!.language)).toEqual(['recieved', 'teh']);
  // As every imported paper was checked before.
  expect(await words('en-GB')).toEqual([
    'behavior',
    'neighbor',
    'color',
    'labeled',
    'centered',
    'analyzed',
    'recieved',
    'color',
    'Modeling',
    'tumor',
    'teh',
  ]);
}, 60_000);
