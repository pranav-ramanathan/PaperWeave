# Import matrix

What happens to each kind of paper when it is imported or started from a template. This file
is written by `packages/server/src/matrix.test.ts` from the papers themselves, and the test
fails when it no longer matches them.

| Paper | Class | .tex files | Compiler | Bibliography | Prose editable visually | Files edited in source only |
| --- | --- | --- | --- | --- | --- | --- |
| Fixture `fixtures/article-basic` | `article` | 1 | pdflatex | BibTeX | 74% | none |
| Fixture `fixtures/ieee-multifile` | `IEEEtran` | 6 | pdflatex | BibTeX | 66% | `macros.tex` |
| Fixture `fixtures/ams-multifile` | `amsart` | 3 | pdflatex | Biber | 82% | none |
| Template "Article" | `article` | 1 | pdflatex | BibTeX | 81% | none |
| Template "IEEE conference paper" | `IEEEtran` | 4 | pdflatex | BibTeX | 43% | none |
| Template "AMS article" | `amsart` | 1 | pdflatex | BibTeX | 66% | none |

For every row:

- The root file and the compiler are found without being told.
- The paper builds to a PDF in the pinned toolchain image (`infra/tex`), with its
  bibliography. The sandbox tests build each one.
- Downloaded again unedited, every file has the bytes it came in with.
- "Prose editable visually" is the share of the body text, by characters, that can be typed
  into in the visual view. Maths, references and citations are shown in place and changed
  through their own controls. The rest is shown and edited in the source view. The preamble
  and comments are not counted.

## Packages these papers load

All are in the toolchain image:
`amsmath`, `amssymb`, `amsthm`, `biblatex`, `booktabs`, `cite`, `graphicx`, `inputenc`.

## Not supported

- Packages that run external programs (`minted`, `pythontex`): shell escape is off.
- A `latexmkrc`: it is never run.
- Files that are not UTF-8, or that mix line endings: kept byte for byte and built, but not
  editable here.
- Comments, history and sharing settings from another service: a ZIP does not hold them.
