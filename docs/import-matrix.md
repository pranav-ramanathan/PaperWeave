# Import matrix

What happens to each kind of paper when it is imported or started from a template. This file
is written by `packages/server/src/matrix.test.ts` from the papers themselves, and the test
fails when it no longer matches them.

| Paper | Class | .tex files | Compiler | Bibliography | Prose editable visually | Files edited in source only |
| --- | --- | --- | --- | --- | --- | --- |
| Fixture `fixtures/article-basic` | `article` | 1 | pdflatex | BibTeX | 74% | none |
| Fixture `fixtures/ieee-multifile` | `IEEEtran` | 6 | pdflatex | BibTeX | 66% | `macros.tex` |
| Fixture `fixtures/ams-multifile` | `amsart` | 3 | pdflatex | Biber | 82% | none |
| Fixture `fixtures/real-natbib` | `article` | 2 | pdflatex | BibTeX | 38% | none |
| Fixture `fixtures/real-biblatex-subfiles` | `article` | 5 | pdflatex | Biber | 81% | none |
| Fixture `fixtures/real-tikz` | `article` | 2 | pdflatex | BibTeX | 24% | none |
| Fixture `fixtures/real-acm` | `acmart` | 1 | pdflatex | BibTeX | 38% | none |
| Fixture `fixtures/real-xelatex` | `article` | 2 | xelatex | BibTeX | 72% | none |
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
`algorithm2e`, `amsmath`, `amssymb`, `amsthm`, `biblatex`, `booktabs`, `caption`, `cite`, `cleveref`, `fontenc`, `fontspec`, `graphicx`, `hyperref`, `import`, `inputenc`, `listings`, `lmodern`, `microtype`, `natbib`, `pgfplots`, `polyglossia`, `siunitx`, `subcaption`, `subfiles`, `tikz`, `unicode-math`.

## Not supported

- Packages that run external programs (`minted`, `pythontex`): shell escape is off.
- A `latexmkrc`: it is never run.
- Files that are not UTF-8, or that mix line endings: kept byte for byte and built, but not
  editable here.
- Comments, history and sharing settings from another service: a ZIP does not hold them.
- Fonts the image does not have: `libertine`, `newtxtext`, `newtxmath`, `inconsolata`. A class that
  asks for them (`acmart`) warns and builds with Computer Modern.

## Shown as LaTeX, edited in the source view

These are kept byte for byte, build, and are shown in place as the LaTeX they are, with a way
to their source. Measured on the `real-*` fixtures and on small samples:

- `\footnote{}`, `{\bf ...}`, `\textsc{}`, `\SI{}{}`, `\qty{}{}`, `\num{}`, `\url{}`,
  `\href{}{}` and `\foreignlanguage{}{}` inside a paragraph: one raw atom each. The words
  around them are editable; the words inside them are not.
- `description`, a list with `\item[label]`, and a list with another list inside it: the whole
  environment is one raw block.
- `tikzpicture`, `pgfplots` axes, `lstlisting`, `algorithm`, `figure` and `table` (the caption of
  a figure or table is edited through its own control, the first of several in `subfigure`s),
  `CCSXML`, `\ccsdesc`, `\keywords`, `teaserfigure` and the title block of `acmart`.
- `\subfile`, `\import`, `\include` and `\input` lines, and a subfile's own preamble.
- A citation or a reference is shown in place with its source as its title; it is changed in
  the source view (the visual view inserts new ones, and opens a formula with a double click).
- A `.tex` file that is a root of its own (`standalone`, a subfile) is listed as another file that
  could be the root. The root chosen is the shallowest, then one named `main`, then the one that
  brings in the most files.
