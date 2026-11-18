# Grammar benchmark

How LanguageTool 6.8, run as in `infra/compose.yaml` and asked the way the
product asks it, does on the labelled sentences in `fixtures/grammar/corpus.json`. This file is
written by `packages/server/src/grammar-benchmark.sandbox.test.ts` and that test fails when
the checker no longer answers this way.

Synthetic sentences written for this benchmark, in the manner of a systems paper. Each item with mistakes lists the words a checker should point at. Clean items are correct British English with the LaTeX a paper has around it. A corpus of real manuscripts reviewed by people is still wanted.

## Mistakes found

23 of 25 sentences with a mistake had it pointed at.

| Kind | Found | Of |
| --- | --- | --- |
| spelling | 6 | 6 |
| agreement | 3 | 4 |
| article | 3 | 3 |
| repeat | 3 | 3 |
| confused | 3 | 4 |
| verb | 3 | 3 |
| punctuation | 1 | 1 |
| capital | 1 | 1 |

Missed:

- agreement: `The results of the experiment shows a clear trend.`
- confused: `The replicas exchange there state every second.`

## Correct text left alone

18 of 20 correct sentences, each with the LaTeX a paper has
around its prose, had nothing pointed at.

Pointed at wrongly:

- `A_INFINITIVE` on "the write" in: `It took \SI{40}{\milli\second} for the write to become durable.`
- `MORFOLOGIK_RULE_EN_GB` on "Lamport" in: `This behaviour was first described by Lamport~\cite{lamport1978} and has been studied since.`

The checker also answered 1 time about something that is not prose (a
formula, a citation, a command). Those answers are dropped before anyone sees them, so they
are not counted above.

## British and American

The correct sentences are British. Read as American English, these words are pointed at:
"organised", "summarises", "behaviour", "analyse", "colour-coded", "the write", "Lamport".

## What this does not show

- How it does on real manuscripts. These sentences were written for the purpose.
- Mistakes of meaning, which no rule-based checker finds.
- Another engine. LanguageTool is the one the spec names; nothing here was a reason to look
  further.
