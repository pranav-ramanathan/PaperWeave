# Phase B gate: can a visual editor sit on top of LaTeX source?

16 November 2026. Measured in a 4-core cloud container, headless Chromium, TeX Live 2022 in the
pinned image (`infra/tex/Dockerfile`).

## Recommendation: go

The source stays the only stored document and the Tiptap view is derived from it. The four
safety gates pass. The usefulness gate passes on pooled numbers but is uneven across papers; the
gap is tables, figures and front matter, which are already planned (D3), not a flaw in the bridge.
No cut to typing is needed. Structure editing stays as designed: text edits and a few explicit
commands in the visual view, everything else in source.

## Gates

| Gate      | Result         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lossless  | Pass           | Every character of every fixture file belongs to exactly one node. Same for 3,000 random strings per run (60,000 in a one-off run) and for 58 files from 15 real papers. Incremental reparse equals a full parse after each of 3,000 random edits.                                                                                                                                                               |
| Byte-safe | Pass           | Every decodable fixture file, CRLF and BOM included, exports byte-identical. 10,000 generated visual edits per run (80,000 in a one-off run) leave every byte outside their range untouched. Typing a character and deleting it restores the file at more than 3,000 positions; the only difference allowed, and seen in under 1% of them, is a separator that kept the letter out of a command name or comment. |
| Race-safe | Pass           | 10,000 interleavings of visual and source edits in one paragraph on two replicas, with updates delivered in any order and sometimes twice: both replicas end with the same text, and each visual document equals a fresh projection of it. In the 5,000 insert-only runs every typed token is present exactly once.                                                                                              |
| Recovers  | Pass           | An unclosed `\emph{` freezes the blocks up to the next heading; the paragraph before stays editable; closing the brace restores the paragraph. Damage that cannot cross a blank line (`$`, a stray `}`) freezes only its paragraph. Checked headlessly and in the browser.                                                                                                                                       |
| Useful    | Pass, unevenly | See coverage and timing below.                                                                                                                                                                                                                                                                                                                                                                                   |

### Coverage

Share of body characters that are editable text, out of editable text plus everything shown as raw
LaTeX. Maths, references and citations are shown in place and left out of both sides. The preamble,
comments and files of definitions are left out too.

| Source                                                      | Editable                                  |
| ----------------------------------------------------------- | ----------------------------------------- |
| `article-basic` fixture                                     | 74%                                       |
| `ieee-multifile` fixture                                    | 66%                                       |
| `ams-multifile` fixture                                     | 82%                                       |
| Fixtures pooled                                             | 71%                                       |
| 14 real papers pooled (arXiv sources, not kept in the repo) | 72%                                       |
| The same papers one by one                                  | 48% to 98%, median 66%; 6 of 14 reach 70% |

What is raw in the real papers, by size: `table` and `figure` environments (about two thirds),
`thebibliography`, lists with nested lists or several paragraphs per item, `algorithm`, and
front matter such as `\title` and `\author`. Two further papers were not measured: one is plain
TeX with no `\documentclass`, one keeps its body where the include graph did not find it.

The fixtures were written for this spike, so their numbers are weak evidence. The real-paper sample
is small and all from arXiv.

### Timing on a 151,676-character file (1,538 blocks), p95 of 60

| Measure                                                          | Result      | Target           |
| ---------------------------------------------------------------- | ----------- | ---------------- |
| Keystroke until the source text is updated                       | 6 to 8 ms   | one frame, 16 ms |
| Keystroke until the next paint                                   | 30 to 36 ms | 50 ms (spec §8)  |
| Source edit from the other author until the visual view repaints | 48 to 58 ms | 100 ms           |

Reparsing after a one-character edit takes about 1 ms (p95 under 2 ms); a full parse about 14 ms.

### Compile

The compile entrypoint runs latexmk in a container with no network, a read-only root, no
capabilities, an unprivileged user and limits on time, memory and processes. A project `latexmkrc`
is never read and shell escape is off.

- All three fixtures compile to PDF with SyncTeX: 1.1 to 3.7 s each, image already local.
- Each template still compiles after 150 generated visual edits spread over its files.
- A `\write18` probe is refused, a TCP connect fails, writing outside the work directory fails, and
  an endless loop is killed at its time limit.
- A deliberate error is reported as `sections/intro.tex:8: Undefined control sequence.`

## What the spike showed that the plan did not expect

- **Files of definitions must be source-only.** Text typed into a file that is `\input` before
  `\begin{document}` breaks the build. The include graph now reports such files and the visual
  editor shows them as one block.
- **Macro definitions must be untouchable.** `\newcommand`, `\def` and `\let` are parsed whole,
  and the visual editor refuses to delete them or wrap them in emphasis.
- **Collapsing spaces loses the caret.** Showing two source spaces as one made a space typed before
  another space vanish. Spaces are now shown one for one; only a line break collapses to a space.
- **Comparing documents is ambiguous.** Typing "ab" into "abab" has two valid readings. The bridge
  uses the editor's own replacement position when it has one.
- **An empty paragraph has no LaTeX form.** Enter at the end of a paragraph opens one that exists
  only in the visual view until something is typed, and only while the caret is in it.

## Limits, as built

- An edit that spans two blocks, deletes a whole block or splits a heading or list item is refused
  with a pointer to the source editor.
- Lists with nested lists, several paragraphs per item or `\item[...]` are shown raw. Tables,
  figures, `\title` and `\author` are shown raw.
- `--`, quotes and the space TeX drops after a command name are shown as typed, not as typeset.
- Emphasis is the only command-class edit. Commands apply in the browser against the local
  replica; the server path is plan item C6.
- The spike page edits one file at a time and forgets edits when the file is switched. Its relay
  stands in for the sync server.
- The parser assumes default category codes and does not look inside `\verb` when matching braces.

## Not run

- Safari and Firefox, and real Japanese or Chinese input methods. Only Chromium is installed
  here; composition was driven through the DevTools protocol.
- Screen readers. Controls have labels and status does not rely on colour, but nothing was read
  aloud.
- The Hocuspocus comparison, which belongs to C3.

## Reproduce

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
docker build -t paperweave-tex infra/tex
pnpm test:sandbox
pnpm e2e
```
