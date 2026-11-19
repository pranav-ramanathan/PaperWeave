# Overleaf: what public documentation says

Gathered on 18 November 2026 from public pages only, by an automated reader. Nothing here was
observed in an Overleaf account, and no Overleaf source code was read.

**Read this first.** Overleaf's terms (`overleaf.com/legal`) forbid using "any manual or
automated means, including robots, scripts, or spiders to access, monitor, crawl, scrape, spider
or mine" its site. That was noticed partway through, and nothing was fetched from `overleaf.com`
afterwards. Most of what follows is from `docs.overleaf.com`, which publishes its pages as plain
text for automated readers (`llms.txt`); some is from blog and help pages on `overleaf.com`
itself, read before the clause was noticed. Whether to keep this file is the owner's decision,
together with the one already open in `docs/plan.md` about replaying competitors' products.
No more will be fetched from there without it.

How to read the "Kind" column: **stated** is on a vendor page that was read; **archived** is a
vendor page read as an Internet Archive copy, since the live address now redirects; **inferred**
is a conclusion drawn here from stated facts; **not stated** means no page found says.

## Replay 1: the visual editor around custom LaTeX

| Question                                                       | What the pages say                                                                                                                                                       | Kind                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| What the Visual Editor is                                      | "Effectively the Code Editor with decorations"; "a core principle ensuring that code was always accessible" (Overleaf engineer, TUGboat 44:2, 2023)                      | stated               |
| An unknown macro or environment                                | Only tables are covered: complex ones "may be partially, or entirely displayed as LaTeX code". By that and the line above, an unknown macro is most likely shown as code | inferred             |
| Does a visual edit change other source (whitespace, comments)? | No page says. Both modes are views of one source text, so there is no second model to convert back from                                                                  | not stated; inferred |
| What is shown visually                                         | Headings, lists, theorems, text styling, maths (custom maths commands included), figures with a dialog, tables, links, chemical formulas                                 | stated               |
| Table editing limits                                           | Rows, columns, borders, alignment by column, merging in a row. Not: aligning single cells, bold from the toolbar inside cells, tables built by packages or macros        | stated               |
| Switching views                                                | A toggle at the top left of the editing pane                                                                                                                             | stated               |
| Is the caret or selection kept on switching?                   | No page says                                                                                                                                                             | not stated           |

**For PaperWeave.** Same shape as the plan: one source text, a visual view over it, code shown
where the view does not understand. What Overleaf does not document, PaperWeave tests: a visual
edit changes only its own bytes (`packages/bridge` byte-range suite, `visual.spec`), and
switching views keeps the selection (`visual.spec`). A live replay would settle whether
Overleaf's visual edits touch nearby whitespace; nothing in the build depends on the answer.

## Replay 2: inserting maths and citations

| Question                     | What the pages say                                                                                                                                                                                                    | Kind               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Maths in the Visual Editor   | Previewed inline. An "Insert Math" tool exists; inline versus display is not described                                                                                                                                | stated             |
| Maths in the Code Editor     | Symbols previewed in autocomplete. An inline preview of formulas is not described                                                                                                                                     | stated; not stated |
| Symbol palette               | Paid plans, either editor; symbols must be inserted inside maths                                                                                                                                                      | stated             |
| Keyboard shortcuts for maths | None documented                                                                                                                                                                                                       | not stated         |
| Citations                    | Typing in `\cite{}` searches the keys of the project's `.bib` files (all plans). Search by author, title or year, and of linked reference managers, is on paid plans; a chosen entry is added to the project's `.bib` | stated             |
| References to labels         | A blog post says they can be added without code. `\ref` completion is not described                                                                                                                                   | not stated         |
| Generated labels             | The figure and table dialogs write a `\label`                                                                                                                                                                         | stated             |

**For PaperWeave.** The plan's D1 and D2 match, and go further in two documented gaps: a
keyboard path for inserting an equation, a reference and a citation (`insert.spec`), and a
reference picker that lists the paper's labels.

## Replay 3: two authors and tracked changes

| Question                                                        | What the pages say                                                                                                                                                                                                  | Kind       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| How tracking is turned on                                       | A "Reviewing" mode. A Reviewer is always in it; an Editor can switch                                                                                                                                                | stated     |
| Who may accept or reject                                        | Editors. Reviewers suggest and comment; Viewers read comments                                                                                                                                                       | stated     |
| Where tracked changes live                                      | Not said outright. A copied project has them applied and its review data empty; a restored version brings them back; downloading and uploading again "could" lose them. So: beside the text, as data of the project | inferred   |
| Are pending changes in the PDF?                                 | No page says                                                                                                                                                                                                        | not stated |
| Which text is in a downloaded `.tex` while changes are pending? | No page says                                                                                                                                                                                                        | not stated |
| A comment whose text is deleted                                 | No page says                                                                                                                                                                                                        | not stated |
| Comments                                                        | Anchored to selected text; reply, resolve, re-open, delete, mention. Resolved ones can be restored, deleted ones cannot                                                                                             | stated     |
| Limits                                                          | People who can edit or review: 1 on the free plan, 10 on Student and Standard, unlimited on Pro. Viewers unlimited                                                                                                  | stated     |

**For PaperWeave.** This bears on a decision waiting on the owner (`docs/plan.md`): proposals
are stored beside the source, not in it. What the pages show is consistent with Overleaf doing
the same, and with the cost the plan already counts: review data does not travel in a plain ZIP.
PaperWeave's answer is the review-data file in the ZIP (plan E5, `reviewdata.ts`). The two
unanswered questions (the PDF, and which text is downloaded) are the ones a live replay would
be for. PaperWeave's own answers are fixed and tested: the PDF never shows a pending proposal,
and a download holds the text as it stands.

## Replay 6: looking for claims without a source

| Question                                                  | What the pages say                                                                                                                                                                                                                   | Kind       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| The feature                                               | "Scan for unsupported statements" in the AI assistant: highlights passages "that may be missing references" and suggests papers "sourced from Dimensions"; a chosen paper is "added to your document and bibliography automatically" | stated     |
| Its stated limit                                          | A citation request typed into the assistant instead "will use an LLM", with results "not verified against an authoritative source"                                                                                                   | stated     |
| How a claim is judged unsupported; how often it is right  | No page says                                                                                                                                                                                                                         | not stated |
| Whether a suggested paper is checked to support the claim | No page says                                                                                                                                                                                                                         | not stated |
| What leaves the product                                   | Project content goes to OpenAI for the assistant, after consent asked once; "never used to train AI models"; can be turned off by a person or an institution                                                                         | stated     |

**For PaperWeave.** The plan's E4 differs on purpose. A claim with thin evidence gets a
question for the author, not a paper to insert (`critique.ts`); a reference's details being
right and a reference supporting the claim are tracked as two things (`evidence.ts`); and
nothing is sent to a model unless the deployment and the paper's owner have both turned it on.

## For the importer

| Question                                                            | What the pages say                                                                                                                 | Kind             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| What a downloaded ZIP holds                                         | "The source files only": no PDF, no generated files such as `.bbl`                                                                 | stated           |
| History, comments, tracked changes, compiler and main-file settings | Not listed either way. By "source files only" and the warning under Replay 3, none is in the ZIP                                   | inferred         |
| Main file                                                           | A project setting. Must contain `\documentclass`; on upload it is detected                                                         | stated           |
| Compiler                                                            | A project setting: pdfLaTeX (the default), LaTeX, XeLaTeX or LuaLaTeX. An uploaded project starts on pdfLaTeX                      | stated           |
| `% !TEX program` and similar comments                               | Not mentioned anywhere                                                                                                             | not stated       |
| `latexmkrc`                                                         | An ordinary project file that changes the build, so it travels in the ZIP                                                          | stated; inferred |
| Limits                                                              | 2,000 files a project; 50 MB an upload; 2 MB an editable file; 7 MB of editable text a project. Compile time 10 s free, 240 s paid | stated           |

**For PaperWeave.** Nothing to change. The importer already detects the root file and the
compiler, lists a `latexmkrc` as present and never run, and reports that review data was not in
the archive (`docs/import-matrix.md`). One difference to know about: an Overleaf paper that
needs its `latexmkrc` to build will not build the same way here, and the import report says so.

## Sources

Read as published text from `docs.overleaf.com`: the pages on the editor, tables, symbols,
citations and reference search, track changes, commenting, reviewers, sharing, copying,
downloading and uploading a project, the main document, compilers, `latexmkrc`, plan limits,
premium features, AI features, the AI assistant, and Grammarly.

- [Ben Davies, "The Overleaf Visual Editor", TUGboat 44:2 (2023)](https://tug.org/TUGboat/tb44-2/tb137davies-visual.pdf)
- [Overleaf documentation, index for automated readers](https://docs.overleaf.com/llms.txt)
- [Overleaf: track changes](https://docs.overleaf.com/collaborating/track-changes.md)
- [Overleaf: sharing a project, and what each role can do](https://docs.overleaf.com/collaborating/sharing-a-project.md)
- [Overleaf: copying a project](https://docs.overleaf.com/managing-projects-and-files/copying-a-project.md)
- [Overleaf: downloading a project](https://docs.overleaf.com/managing-projects-and-files/downloading-a-project.md)
- [Overleaf: the main document](https://docs.overleaf.com/getting-started/recompiling-your-project/the-main-document.md)
- [Overleaf: plan limits](https://docs.overleaf.com/getting-started/free-and-premium-plans/plan-limits.md)
- [Overleaf: tables in the Visual Editor](https://docs.overleaf.com/writing-and-editing/generating-and-inserting-tables/edit-or-customize-an-inserted-table.md)
- [Overleaf: searching for references](https://docs.overleaf.com/citing-and-references/adding-citations-and-references/searching-for-references.md)
- [Overleaf: the AI assistant](https://docs.overleaf.com/integrations-and-add-ons/ai-features/ai-assistant.md)
- [Overleaf: AI features and what they send](https://docs.overleaf.com/integrations-and-add-ons/ai-features.md)

Short quotations from three `overleaf.com` pages (the features overview and two blog posts)
came through a tool that summarises, and should be checked against the page before being
repeated as Overleaf's words.
