# Phase A: reference behaviour

Six replays from spec §9, to be run by a person in disposable, authorised accounts with synthetic
files only. **Nothing here has been observed live yet.** What the products' public documentation
says has been gathered instead: `overleaf.md` (replays 1, 2, 3 and 6, and facts for the
importer), `grammarly.md` (replay 4) and `prism.md` (replay 5). Each says what is stated, what
is inferred, and what no page says. The "not stated" rows are what a live replay is still for.

Before starting, confirm that replaying these products is allowed by their terms. Do not read
Overleaf's source code; PaperWeave's code, prompts and schemas are written independently.

## For every replay, record

- date and time, product plan or tier, browser
- the fixture used and its digest from `fixtures/digests.json`
- exact steps, what happened, and what could not be checked
- whether each observation was seen directly or taken from documentation

Use the projects in `fixtures/` as the synthetic files: zip `fixtures/ieee-multifile` to upload.

## Matrix

| #   | Replay                                                                                                                                                               | From public documentation                                                                                                                                              | Observed                                                                     | Design decision it informs                                                          | Acceptance test it becomes                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Overleaf visual editing around custom LaTeX: open `ieee-multifile`, edit prose next to `\sys` and `\todo{...}` in the visual editor, then diff the downloaded source | One source with a visual view over it; unknown LaTeX most likely shown as code. Whether nearby source is rewritten: not stated. `overleaf.md`                          | not yet                                                                      | What the visual view shows for unknown macros and whether it rewrites nearby source | A visual edit next to a custom macro changes only the typed bytes             |
| 2   | Maths and citation insertion in both Overleaf modes                                                                                                                  | Maths previewed in the visual view; `\cite` completion from the `.bib`; no maths shortcuts or `\ref` completion documented. `overleaf.md`                              | not yet                                                                      | Insert commands and their keyboard paths (plan D1, D2)                              | Inserted equation and citation compile and round-trip                         |
| 3   | Two authors: one makes a tracked edit while the other types in source in the same paragraph                                                                          | Reviewing mode; editors accept; changes kept beside the text (inferred) and may be lost on re-upload. PDF and download with pending changes: not stated. `overleaf.md` | not yet                                                                      | Whether tracked changes live in the source or beside it (owner decision before E2)  | A proposal on text that changed underneath is flagged stale                   |
| 4   | Grammarly rewriting a paragraph that contains numbers and hedges                                                                                                     | Rewrites of sentences and paragraphs; nothing about keeping numbers or hedges; warnings to check. `grammarly.md`                                                       | not yet                                                                      | Which changes count as material (plan E4)                                           | The challenge set flags any changed quantity, negation or hedge               |
| 5   | Prism: export a project as ZIP and list what the archive holds (optional: see `prism.md`)                                                                            | Migration guide separates project files from collaboration state                                                                                                       | not live; public sources say the ZIP holds source files only, see `prism.md` | What the importer can bring over and what it must report missing (plan C2, E5)      | Import report lists comments and history as missing when the archive has none |
| 6   | Overleaf citation review on a claim with no source                                                                                                                   | A scan highlights passages and suggests papers to insert; how it judges, and whether a paper supports the claim: not stated. `overleaf.md`                             | not yet                                                                      | How an unsupported claim is surfaced (plan E4)                                      | A claim with thin evidence produces a review question, not a rewrite          |

Replay 5 is optional. Public sources already say what a Prism export holds (`prism.md`); a real
export would only confirm the folder layout. If someone has one, keep the ZIP as a fixture. Prism
shuts down on 1 January 2027.
