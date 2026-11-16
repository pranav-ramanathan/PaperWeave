# Phase A: reference behaviour

Six replays from spec §9, to be run by a person in disposable, authorised accounts with synthetic
files only. Nothing here has been observed yet: every "Expected from docs" cell restates spec §2,
which is itself documentation-backed, not a live observation.

Before starting, confirm that replaying these products is allowed by their terms. Do not read
Overleaf's source code; PaperWeave's code, prompts and schemas are written independently.

## For every replay, record

- date and time, product plan or tier, browser
- the fixture used and its digest from `fixtures/digests.json`
- exact steps, what happened, and what could not be checked
- whether each observation was seen directly or taken from documentation

Use the projects in `fixtures/` as the synthetic files: zip `fixtures/ieee-multifile` to upload.

## Matrix

| #   | Replay                                                                                                                                                               | Expected from docs                                               | Observed | Design decision it informs                                                          | Acceptance test it becomes                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Overleaf visual editing around custom LaTeX: open `ieee-multifile`, edit prose next to `\sys` and `\todo{...}` in the visual editor, then diff the downloaded source | Visual and source editing on the same project                    | not yet  | What the visual view shows for unknown macros and whether it rewrites nearby source | A visual edit next to a custom macro changes only the typed bytes             |
| 2   | Maths and citation insertion in both Overleaf modes                                                                                                                  | Equation and citation tools in both editors                      | not yet  | Insert commands and their keyboard paths (plan D1, D2)                              | Inserted equation and citation compile and round-trip                         |
| 3   | Two authors: one makes a tracked edit while the other types in source in the same paragraph                                                                          | Live collaboration and tracked changes                           | not yet  | Whether tracked changes live in the source or beside it (owner decision before E2)  | A proposal on text that changed underneath is flagged stale                   |
| 4   | Grammarly rewriting a paragraph that contains numbers and hedges                                                                                                     | Paragraph rewrites with explanations                             | not yet  | Which changes count as material (plan E4)                                           | The challenge set flags any changed quantity, negation or hedge               |
| 5   | Prism: export a project as ZIP and list what the archive holds                                                                                                       | Migration guide separates project files from collaboration state | not yet  | What the importer can bring over and what it must report missing (plan C2, E5)      | Import report lists comments and history as missing when the archive has none |
| 6   | Overleaf citation review on a claim with no source                                                                                                                   | A scan for unsupported statements                                | not yet  | How an unsupported claim is surfaced (plan E4)                                      | A claim with thin evidence produces a review question, not a rewrite          |

Do replay 5 first: the spec says Prism retires on 1 January 2027. Keep the exported ZIP; it becomes
a fixture.
