# Status

Read this first. Update it in every pull request.

## Done

- **Scaffold.** pnpm workspace, TypeScript, ESLint, Prettier, Vitest, Playwright, CI.
- **Fixtures.** `fixtures/`: article, IEEE and AMS multi-file papers, five papers written the way
  real ones are (`real-*`), encoding variants, a shell-escape probe. `fixtures/digests.json` pins their bytes; run `node fixtures/digest.mjs`
  after changing one on purpose.
- **C1: accounts and papers.** `packages/server` (migrations, sign-in through Better Auth,
  `authorize()`, projects, members, invitations, blob store) and the web pages that use it. Web
  forms are server actions that call `packages/server` directly; there is no separate JSON API.
- **C2: import.** Upload a ZIP on `/projects`. `packages/server/src/archive.ts` reads it with
  limits and refuses hostile archives whole; `import.ts` splits it into papers (an "export all
  projects" archive becomes several), finds the root file and compiler, stores every file as a blob
  and writes the import report shown on the paper's page. Download gives the same bytes back.
  The import runs inside the upload request for now; it moves onto the job queue with C4.
- **C3: live editing.** `apps/sync` is a Hocuspocus server; `packages/server/src/sync.ts` holds
  everything durable. The app has a source editor at `/projects/<id>/files/<fileId>` with a file
  list, presence, and a status line that says whether edits are saved, waiting or offline.
  - **The Hocuspocus check from the plan: kept.** Its `beforeSync` hook is awaited before an edit
    is applied or acknowledged, so each edit is appended to `file_updates` first. Measured: 100
    hard kills of the server while a client typed, zero acknowledged edits missing from the log,
    and every unacknowledged edit saved after reconnect.
  - Write access is checked in the same SQL statement that appends the edit. A role change or
    removal also notifies the sync server, which re-checks open connections at once.
  - Reviewers and viewers connect read-only: what they type is neither saved nor shared.
  - Export builds an edited file from its log and restores its newline style and BOM.
- **C4: builds.** The `builds` table is the job queue: `apps/workers/src/main.ts` takes the oldest
  queued row with `for update skip locked` and holds it while it builds, so a worker that dies
  gives the build back. The plan named pg-boss; a table already needed for results does the same
  job with no extra dependency. Revisit if retries or scheduling grow.
  - A build reads the text as it stands when the worker starts, so a burst of requests is one
    build. Asking while one is queued returns that one. A paper may build 120 times an hour.
  - The cache key covers every file's bytes, the root, the compiler and the toolchain image ID.
    Results are reused only within the same paper.
  - The TeX image has pdfLaTeX, XeLaTeX and LuaLaTeX.
  - Measured gaps in the image, now filled (`infra/tex/Dockerfile`): `\usepackage[T1]{fontenc}`
    without lmodern built with generated bitmap fonts (`mktexpk`, `ecrm1000.600pk`) because
    cm-super was missing, and `babel` had only English and Greek, so `[ngerman]`, `[french]` and
    the rest failed with "Unknown option". Added `cm-super-minimal` (it has the T1 Type 1 fonts)
    and `texlive-lang-` german, french, spanish, italian, portuguese, european (dutch among
    others), polish and cyrillic. Image size 1.49 GB to 1.61 GB (content size 412 MB to 448 MB;
    `cm-super-minimal` was later replaced by the full `cm-super`, see "Five papers written the way
    real ones are");
    a clean build of the image took about 2m40 here. Left out then: texlive-fonts-extra (newtxtext,
    libertine, inconsolata); added later, see "`texlive-fonts-extra` added to the image". The toolchain image ID
    is in the cache key, so builds cached before this are not reused. Sandbox tests build a T1
    paper (no `mktexpk` in the log) and papers in german, french, spanish and russian.
  - The editor page shows the PDF beside the source. It compiles by itself once typing has paused,
    lists errors with file and line, and keeps showing the last good PDF, marked when it is behind
    the text. The PDF is shown in the browser's own viewer; PDF.js comes with SyncTeX (D5).
  - Import still runs inside the upload request.
- **C5: revisions.** A revision freezes every file's path and bytes with the root and compiler.
  - Cutting one locks the paper's file rows for the moment it takes to read them, so all files
    are captured at the same point. A cut that finds nothing changed returns the latest revision.
  - Every build is of a revision; a download of the live paper cuts one first. Named revisions
    can be built on request.
  - The PDF is stamped with the time its revision was cut, so the exported ZIP rebuilt elsewhere
    with the command in `paperweave-toolchain.json` gives the same bytes. A test does exactly
    that for all three templates.
  - The command also sets `FORCE_SOURCE_DATE=1`, which makes pdfTeX and XeTeX take `\today`
    from that same time (LuaTeX already did). So `\today` is the UTC date of the moment the
    revision was cut; a revision whose build was reused from an earlier identical one (same
    files, same image) shows the date of that first revision, as its manifest says. Not the
    time of the build or of the rebuild, and not the reader's timezone.
    The same setting also makes `\pdffilemoddate` and packages that print a file's modification
    date (`filemod`, `currfile`) report that time instead of the file's own.
  - Restore applies the difference as new edits through `editFile`, so people with the file open
    see it at once, and records a new revision. Nothing is erased.
  - Comparing two revisions shows changed lines, renames, additions and removals.
  - Renaming a file keeps its ID and history.
- **Files.** Add a blank text file or an upload, delete a file, choose the root file
  (`packages/server/src/files.ts`, controls on the paper's page).
  - Deleting hides the file: `files` is now a view of the live rows of `all_files`. The row and
    its edit log stay, so restoring a revision brings back the same file with its history, and
    someone who had it open merges into it instead of adding their text twice.
  - A delete cuts a revision first, so the file can always be brought back. The root file cannot
    be deleted. Restoring a revision removes files added since and brings back files deleted
    since, and can swap two files' names.
  - The first .tex file added to an empty paper becomes its root.
  - Deleting a file the paper reads first shows the lines that name it; see "Deleting a file the
    paper reads was done at one click".
  - When the server stops serving a file (deleted, or access removed) it says so, and the open
    editor locks and shows why. Before this the editor went on saying "All edits saved".
- **C6: commands and compaction.**
  - `runCommand` (`packages/server/src/commands.ts`) replaces one stretch of a file if it still
    reads as its author saw it. The stretch is given as Yjs relative positions, so edits elsewhere
    do not make it stale; a change inside it does, and the answer carries the current text. The
    check and the edit happen while the file's row is locked, so typing and other commands wait.
  - A command carries a key chosen by the client. Sent again with the same key it is not applied
    again. Keys are kept for a day (`file_commands`).
  - Editors ask for one over the live connection (see C7). There is no HTTP route for it.
  - `compactFile` rewrites a file's log as one entry holding the same document. The sync server
    does it each time a file's log has grown by 500 edits. Who typed each edit is not kept past
    a compaction.
- **C7: the visual editor in the app.** A .tex file opens in the visual view, or in the source
  view if that was the last one chosen in this browser, with a switch between them. Both are views of the same text (`FileEditor.tsx`, `apps/web/lib/visual.ts`,
  which `/spike` now shares).
  - Switching views carries the selection across. Undo is one history per person for both views.
  - Emphasis is a structural edit. The editor asks the sync server over its live connection; the
    server runs `runCommand`, answers the author with the edit, and only then sends it to
    everyone. The author applies the answer as their own edit, so it is an undo step of theirs.
    C6's HTTP route could not guarantee that order (the broadcast sometimes won, and Undo then
    took back the wrong thing), so it was removed.
  - Found and fixed on the way: after a file's text first arrived, the visual editor's selection
    was the whole document, and keys pressed before the first click registered were refused.
  - Bold (`\textbf`, Ctrl/Cmd+B and a "Bold" button) is made and taken off the same way as emphasis, by the same
    command with another name. Taking one off with the other inside it (`\emph{\textbf{x}}`) removes only its own
    `\name{` and `}`. A selection that ends inside a group it did not start in is refused, as for emphasis.
  - Not built: structural edits other than emphasis and bold, headings and starting a list (see "A heading
    from the visual view" and "Starting a list from the visual view"): moving a block,
    and changing an existing heading's level; and remembering which view a person last used.
    Deleting a block is built (see "Deleting a block from the visual view").
  - Whether a file is "definitions, source only" comes from the import report, so a file added
    later is never marked that way.
- **C8, first part: edits made offline across a restore.** Someone who comes back online to a
  paper that was restored while they were away, with edits they had not sent, is told so. Their
  edits are held, the editor is locked, and they choose: apply the edits to the restored paper, or
  discard them. With nothing unsent they simply see the restored text.
  - How: the sync ticket's answer says when the paper was last restored. The editor compares
    that with what it saw when it last connected, before it sends anything.
  - This is the editor's own check. The server would still accept the edits from a client that
    did not ask; anyone who can send them may edit the file anyway.
  - It is per paper, not per file: a restore that did not touch the open file still asks.
- **C8, second part: the fault suite and monitoring.**
  - `apps/sync/src/faults.sandbox.test.ts`: three people type while connections drop, edits
    are delivered twice, the server is killed, access is taken away and given back, the log is
    compacted and the paper is restored. Nothing the server confirmed may be missing from the
    stored text, at any check or right after a kill, and everyone must end with the same text.
    Seeded: `SEED=<n> FAULTS=<steps>` replays a run. It passed 20 seeds in a row, and one run of
    500 steps.
  - "Saved" is now exact. The editor asks the server whether it holds every insert and delete
    made in this tab (`localChanges` in `packages/bridge`, `holds` in `packages/server`). The
    sync library's own count reaches zero too early after a reconnect, because edits queued
    while offline are confirmed after the count was reset. The status line, the warning on
    closing the tab, and the hold after a restore all use the exact answer.
  - "Is it saved?" no longer scales with the size of the question. `holds` scanned every held
    delete range for each range in the client's snapshot, and a snapshot can repeat one range as
    often as a frame allows (a 533 KB message held the server for about 9 s). It now looks each
    range up by binary search; the answers are unchanged. `packages/server/src/saved.test.ts`
    covers it, including a comparison with the old scan on seeded random documents.
  - Restores replace whole lines. An edit made offline before a restore is merged in at an edge
    of the replaced part, and used to be able to land in the middle of a line. (Since changed:
    each changed stretch is replaced on its own, and a line changed in place word by word; an
    editor now holds edits made offline across a restore and asks. See "What a restore does to
    what is attached to the text".)
  - The editor reconnects whenever it should be connected. The library ignores a request to
    connect made while a disconnect is still closing, which could leave a tab offline for good.
  - Monitoring: the sync server serves `/metrics` (Prometheus text) to whoever sends
    `METRICS_TOKEN`; with no token set the page does not exist. It reports the build queue's
    length and the age of its oldest entry, builds finished in the last hour by result, edits
    saved and refused, connections let in, refused and open, structural edits, and compactions.
    Counts only. Nothing reads it yet: dashboards and alerts wait on the hosting decision.
  - Reconnects are not counted apart from first connections.
- **D1, first part: numbers from the compiled PDF.**
  - `labelIndex` (`packages/latex/src/labels.ts`) finds every `\label` and every reference
    (`\ref`, `\eqref`, `\cref` and relatives) in a file, skipping comments and verbatim text.
  - Each build stores the number and page LaTeX gave every label, read from its `.aux` files
    (`builds.labels`). A test checks them against the text of the PDF itself, for two templates.
  - In the visual editor a reference shows that number, as the PDF prints it ("II", "(2)"), and
    a labelled equation row shows its tag. Until there is a PDF a reference shows its key. When
    the text has moved on from the PDF the numbers are marked as old. A reference to a label
    that does not exist shows "??", as the PDF does.
  - The paper's page lists references to labels that do not exist, and label names used twice,
    each with its file and line (`labelReport`).
  - Not numbered: equations and sections without a label (LaTeX records numbers only for
    labels).
- **D1, second part: renaming a label.** On the paper's page: choose a label and a new name.
  A page then lists every line that would change, in every file, and nothing has changed yet.
  Confirming changes them all in one transaction, or none.
  - If the text has changed since the list was made so that the list would differ, the rename
    is refused and the list is shown again (`proposeLabelRename`, `renameLabel`).
  - A name already used by another label is refused, as is one LaTeX could not use.
  - Open editors get the new name without a reload.
- **D1, third part: renaming a file updates the lines that name it.** Renaming a file that an
  `\input`, `\include`, `\bibliography`, `\addbibresource` or `\includegraphics` line names
  first shows those lines as they would become. The rename and the lines change together, or
  not at all (`proposeFileRename`, `renameFileAndReferences`). A file nothing names is renamed
  at once, as before.
  - A name written without its extension stays without it; one of several names in a
    `\bibliography` list changes alone; a line in a comment is left as it is.
  - Names in `\includeonly` are updated too, written as the `\include` lines are.
  - "Rename only" is offered too, and says the paper will not build until the lines are fixed.
  - Not handled: moving the root file to another folder, which changes what every relative
    path in the paper means.
- **D1, fourth part: editing a formula in place.** A double click on a formula in the visual
  view, or Enter when it is selected, opens its LaTeX with a preview that follows what is typed.
  - Apply goes through the server (`Bridge.atomCommand`, then `runCommand`). What the formula
    said when it was opened is what the server must find: a formula someone else changed
    meanwhile is not overwritten, and the person is told. The edit can be undone.
  - The preview draws the paper's own macros: `\newcommand` and relatives, plain `\def`, and
    `\DeclareMathOperator`, read in TeX's order from the root file's preamble, the files it
    reads and the project's own `.sty`/`.cls` it loads (`mathMacros`, `paperMacros`). So does the
    visual view itself. An argument a macro declares but does not use is dropped, as in TeX.
  - Macros are read when the page loads. A macro defined since shows after a reload.
  - A formula the browser cannot draw can still be applied: the PDF is what decides.
- **D1, fifth part: inserting references and equations.** In the visual view, three ways each:
  the toolbar ("Reference", "Equation"), the keyboard (Alt+R, Alt+=), and a menu at a place in
  the text (right click, or the menu key). With that, D1 is done.
  - A reference is chosen from the paper's labels, each shown with its number in the PDF and
    its file; typing narrows the list. A label that starts `eq:` is inserted as `\eqref`.
  - An equation goes in the line (`$...$`) or on a line of its own, numbered
    (`\begin{equation}`), with a preview as it is typed.
    Text that would not stand alone (an unclosed brace, a blank line, a `%` at the end) is refused
    in the window; see "An equation typed into the Insert window can no longer stop the build".
  - Insertions go through the server, at the place the caret was when the window opened, even
    if the text has moved since (`Bridge.insertCommand`). Afterwards the caret is just after
    what was inserted.
  - The menu replaces the browser's own; Shift + right click still opens that one, and the menu
    says so. On a formula the menu offers to edit it.
  - `apps/web/.../Tools.tsx` holds the three small windows. They are native dialogs and a
    `role="menu"` list, worked from the keyboard.
- **D2, first part: the bibliography index and citing.**
  - `bibEntries` (`packages/latex/src/bib.ts`) reads a .bib file into entries by key, with
    where each is. It is an index only: nothing writes a .bib file from it. A test imports an
    awkward one (byte order mark, CRLF, tabs, stray text between entries), reads it, and gets
    the same bytes back.
  - `citeIndex` finds the keys in `\cite`, `\citep`, `\parencite` and their relatives.
  - The paper's page lists citations of a key no entry has, and keys that several entries have,
    each with file and line (`citationReport`).
  - In the visual view a citation says on hover what it cites ("Knuth 1984. The TeXbook"), and
    is marked if it has no entry.
  - A citation is inserted like a reference: toolbar, Alt+C, or the menu. The window finds
    entries by key, author, year or title, and inserts the citation command the paper already
    uses most.
  - The bibliography is read when the file page opens and after the citation window closes. An
    entry added in another tab shows after that.
  - BibTeX and Biber both build already (C4, C5): latexmk runs whichever the paper asks for.
- **D2, second part: what has been checked about a citation.** Two things, recorded apart
  (`packages/server/src/evidence.ts`, tables `doi_lookups` and `evidence_checks`), shown as two
  columns on the paper's page. With this D2 is done.
  - _Is the entry right?_ "Look up DOI" asks Crossref about the entry's DOI and sets the
    registry's title, year, first author and venue beside the entry's. It records the outcome
    (matches, differs with both sides, or no such DOI), the source and the time. Only the DOI
    leaves the service. Nothing in the paper is changed. A lookup of an entry edited since is
    marked as out of date.
  - _Does the source support the claim?_ A person quotes one claim from the paper and says
    whether the source supports it, partly supports it, or does not, with a note. If the
    paper no longer says those words, the check says so.
  - Owners, editors and reviewers may do both; viewers may read. A check is removed by its
    author or by someone who can edit the paper.
  - `CROSSREF_URL` points the lookup elsewhere; the browser tests point it at a stand-in. A
    registry that does not answer is reported and nothing is recorded.
  - A claim is matched by its words, not by its place in the text. Anchoring a check to a
    place comes with review threads (E1).
- **D3, first part: tables and captions edited in place.**
  - `floatParts` (`packages/latex/src/floats.ts`) reads a figure or table environment into its
    caption, its pictures (file, and description if it has one) and, for a table, its rows of
    cells, each with where it is in the source. Rules such as `\toprule` are not cells.
  - In the visual view a simple table is drawn as a grid with its caption. Pressing a cell or a
    caption turns it into a field holding its LaTeX; Enter puts the new text in its place,
    Escape leaves it. A figure's caption works the same way.
  - The change goes through the server and names only that cell (`Bridge.atomCommand` with a
    part). Two people can edit two cells of one table at once; the same cell twice is a
    conflict. A test edits every cell of a fixture in turn and checks the file differs in those
    cells and nowhere else.
  - Text that would break the grid (an unescaped `&`, a row break, a `%`) is refused. A caption
    is checked too (see "A caption or description typed in place can no longer stop the build").
  - If the table changes under an open field, the person is told, with the text they had typed.
  - A table that is not a plain grid (`\multicolumn`, `\multirow`, a nested table, rows of
    different lengths) is shown as source, with "Edit in source".
- **D3, second part: figures, and inserting figures and tables.**
  - A figure in the visual view shows its picture, found as LaTeX finds it (against the root
    file's folder, with the extension added if it was left off, upper case included). PNG and
    JPEG are shown; a PDF or EPS figure says it is in the PDF.
  - Each picture has a description for people who cannot see it: `alt={...}` in the picture's
    options. One that is missing is said to be missing, and is added in place. The pinned
    toolchain accepts the option; a test builds a paper that uses it.
  - "Figure" and "Table" on the toolbar, Alt+G and Alt+T, and the menu, insert a new one where
    the caret is: a figure with a picture chosen from the paper's files, its description and
    caption; a table of a chosen size with a caption. Each gets a label made from its caption
    that the paper does not already use.
  - The Figure window tells loading, loaded and failed apart: while the pictures load it says so
    and Insert waits (`aria-disabled`, with a guard); if they cannot be loaded it says so and
    offers Retry, rather than "no pictures yet". Each time it opens it starts clean. With two or
    more pictures none is chosen for the person ("Choose a picture…"); Insert refuses until one
    is, or "No picture yet" is. One picture is chosen on its own.
  - A figure or table goes after the end of the paragraph the caret is in, in blank lines, not
    at the caret, so it does not split a sentence from its citations (`Bridge.floatCommand`,
    `insertion({ block: true })`). In a list item, a caption or elsewhere it goes at the caret
    as before.
  - A build that fails outright (a picture the engine cannot read) now reports why. Such errors
    have no file and line and were dropped before.
  - The editor reads the selection in the text before acting even when a toolbar button has
    the keyboard.
- **D3, third part: table rows and columns.** Beside each row of a table in the visual view
  are buttons to add a row below it or delete it; under each column, to add a column after it
  or delete it (`tableEdit` in `packages/latex/src/floats.ts`). With this D3 is done.
  - A new row is empty and indented like its neighbours; rules such as `\midrule` stay where
    they are. A new column adds a cell to every row and an `l` to the column specification.
  - Adding and then removing restores every byte. A unit test checks that for rows and columns.
  - Columns cannot be changed when the specification is of a kind this does not take apart
    (`*{3}{c}`); the buttons are then not offered. A table is never left with no row or column.
  - A column change rewrites the stretch from the specification to the last row, so it
    conflicts with a cell someone else is changing at that moment. A row change does not.
- **D4, first part: data files.** A CSV file of a paper can be described: what each column
  holds (numbers, dates or text), its unit, which spellings mean "no value", where the data comes
  from, and whether the file goes into downloads. The paper's page lists data files under
  "Data"; `/projects/<id>/data/<fileId>` is where one is described.
  - `packages/server/src/csv.ts` reads CSV (quoted fields with delimiters, quotes and line
    breaks in them; comma, semicolon or tab, found by looking; a BOM) and guesses a description.
    A person approves it; nothing is used on a guess.
  - A description is of one exact version of the file (its sha256). Approving checks that the
    version on the form is still the current one, and that every value fits its column's type or
    is one of the "no value" spellings; otherwise it says which row and column does not.
  - `listDatasets` reports `changed` when the file is no longer the approved version.
    `datasetTable` gives the typed rows and refuses a changed file. Charts will read through it.
  - Data files stay out of downloaded ZIPs unless their description says to include them
    (`exportRevision`). A CSV that was never described is exported like any other file.
  - Table `datasets` (migration 0010).
- **D4, second part: charts.** A scatter, line or bar chart of two columns of a described data
  file, optionally split into groups by a text column. The paper's page lists charts under
  "Data"; `/projects/<id>/charts/<chartId>` shows one and holds the form that makes or changes it.
  - The worker draws it (`apps/workers/src/charts.ts`): Vega-Lite to SVG in Node, then SVG to
    PDF and PNG with `rsvg-convert` in the sandbox image, which now also has that tool and the
    DejaVu fonts. The two files are kept in the paper as `charts/<name>.pdf` and
    `charts/<name>.png`, so `\includegraphics{charts/<name>}` works in builds and downloads.
    The same chart of the same data gives the same bytes.
  - `vegaLite` in `packages/server/src/charts.ts` builds the specification. Units go into the
    axis titles. Rows with no value are left out and counted on the chart's page; a line can
    show them as gaps instead. Dates are drawn in UTC, as written. Groups differ by shape or
    dash as well as colour, and the colours are a colour-blind-safe set.
  - Refused with the reason: bars where several rows share a value and nothing says how to
    combine them (mean or sum), more than 8 groups, text along the bottom of a scatter or line.
  - A chart records the version of the data file it was drawn from. `listCharts` reports
    `stale` when the file is no longer that version. It is not redrawn until someone has looked
    at the new version and approved its description; the worker checks again when it draws.
  - Queue: rows of table `charts` with status `queued` (migration 0011), taken by the same
    worker process as builds.
- **D4, third part: captions, descriptions and the record of how a chart was made.** With this
  D4 is done.
  - A chart has a caption and a description for people who cannot see it. Left empty, the
    description is our own sentence ("Line chart of latency (ms) against day."), which follows
    the chart when its kind or columns change; the author's own words are kept.
  - In the visual editor's "Insert a figure", a chart is offered once, as its PDF, and brings
    its caption and description. The editor shows the PNG of the same name in the PDF's place
    (`picture` in `packages/server/src/files.ts`).
  - Every drawing is written to `chart_draws` (migration 0012): the data file and its exact
    version, the columns used with their units, the spellings for "no value", the chart's
    specification, rows left out, the versions of Vega and Vega-Lite and the sandbox image, and
    the digests of the two files. Rows are never changed and outlive the chart. The chart's page
    lists them under "How it was made".
  - The toolchain manifest of a download (`paperweave-toolchain.json`) has a `charts` entry for
    each drawn chart among its files, found by the file's bytes, so it is right for the revision
    downloaded.
- **D5, first part: the checks before submitting.** `/projects/<id>/submit`, linked from the
  paper's page, lists what stands between the paper as it is and one that can be sent
  (`submissionChecks` in `packages/server/src/submit.ts`). Each finding names its place and
  links to the file or chart.
  - Problems: no root file; a file the paper names and does not have (`\input`, a picture, a
    bibliography); a reference to a label that is not there; a label given twice; a citation of
    a key no entry has; a chart the paper shows that is out of date, failed or not yet drawn; no
    build, a build still running, a build older than the text, a failed build and each compiler
    error.
  - Worth a look, and not in the way: compiler warnings, two bibliography entries with one key,
    a file name put together by a macro (it cannot be checked).
  - With no problem left, the page offers the ZIP, the ZIP with its toolchain manifest, and the
    PDF, all of the revision that was built. "Build the paper and check again" asks for a build;
    the page looks again by itself while one runs.
  - A chart the paper does not show is not checked.
- **D5, second part: templates and the import matrix.**
  - A new paper can be started from a template: Article, IEEE conference paper, AMS article
    (`packages/server/src/templates.ts`). A template is brought in the way an uploaded ZIP is,
    so it gets the same report, root and compiler. Each builds as it is and passes the checks
    before submitting; a sandbox test holds that. `projects.template` records which one a
    paper came from (migration 0013), for counting later how each kind fares.
  - `docs/import-matrix.md` says, for each fixture and template: class, compiler, bibliography
    tool, how much of the prose can be edited visually, and which files are source only; then
    the packages they load and what is not supported. It is written by
    `packages/server/src/matrix.test.ts` from the papers themselves
    (`WRITE_MATRIX=1 pnpm vitest run packages/server/src/matrix.test.ts`), and that test fails
    when the file no longer matches them.
- **D5, third part: between the text and the PDF.** With this D5 and Phase D are done.
  - "Show in PDF" in the editor's toolbar (either view) brings the caret's line into view in
    the PDF beside it, with a band across the line. A double-click on a place in the PDF puts
    the caret on the line that made it, opening another file of the paper if it is there.
  - `packages/latex/src/synctex.ts` reads the SyncTeX file the build already kept and answers
    both questions. On the two-column IEEE fixture, more than 9 in 10 lines of prose lead to a
    place that leads back to them; a sandbox test holds that. Lines that put nothing of their
    own into the PDF (`\begin{tabular}`) give the next line that did. TeX does not record
    characters, so a place in a paragraph is known to the nearest space.
  - `sourceToPdf` and `pdfToSource` in `packages/server/src/builds.ts`, served at
    `/projects/<id>/builds/<buildId>/sync`. Files are matched by ID as they were named in the
    revision that was built, so a later rename does not matter.
  - The PDF is now drawn page by page with PDF.js (`PdfView.tsx`) instead of the browser's own
    viewer, which could neither be pointed at a place nor say where a click was. A rebuilt PDF
    appears where the old one was scrolled to. Pages are pictures: to select or search text,
    "Open the PDF by itself" opens the browser's viewer. A text layer is left for Phase F.
  - When the PDF is behind the text, lines are those of the text that was built, so a place can
    be a few lines off until the next build.
- **E1: threads.** Comments about a stretch of a file's text, in a "Comments" panel under the
  editor. Owners, editors and reviewers can start a thread on the selected text (in either
  view), reply, mention others on the paper, resolve and open again. Viewers read.
  - A thread's stretch is two Yjs relative positions (`packages/server/src/threads.ts`, tables
    in migration 0014). The start holds on to the character after it and the end to the one
    before, so text typed against either end stays outside, and the stretch follows the text.
  - `listThreads` says where each thread stands: `attached` (the text is as it was), `changed`
    (edited since, with how it reads now) or `detached` (all of it deleted). A detached thread
    keeps the words it was about and 80 characters either side, and can still be answered and
    resolved.
  - A detached thread can be attached again to the words it was started on, where they stand
    now, if they are in the file exactly once (`reattachThread`). Otherwise it says why not.
  - The editor makes the positions from its own copy of the text; the server checks them
    against the saved text and takes the words from there, not from the client. A stretch typed
    a moment ago and not yet saved is refused with "try again in a moment".
  - Open threads are marked in the text in both views (tinted and underlined). The editor
    places the marks from its own copy of the text, so they move as it is typed into without
    waiting for the server.
  - A mention sends an email that says who mentioned whom, on which paper, with a link. It
    holds none of the comment or the text.
  - "Show in the text" selects a thread's stretch in whichever view is open. The panel reads
    the threads again every five seconds. The paper's page lists its open threads.
  - A comment can be changed by its author and deleted by its author or the paper's owner; see
    "A comment changed or taken back".
- **E2: proposed changes.** A "Proposed changes" panel under the editor. Anyone who may comment
  (owner, editor, reviewer) selects text, or puts the caret where text should go, and proposes
  what should stand there, with a reason. Nothing is written to the paper until an owner or
  editor accepts it.
  - A proposal is kept beside the text, not in it (`packages/server/src/proposals.ts`, table in
    migration 0015), so a pending proposal is never in the PDF or a download. This is the
    plan's default; the owner has not yet confirmed it (see `docs/plan.md`).
  - Its stretch is two Yjs positions, as for threads, and it records the text it expects there.
    Accepting goes through the command path with that expectation: it lands exactly as proposed
    or not at all. The edit and the proposal's change of status are one transaction
    (`runCommand` now takes `within`).
  - A proposal whose text has changed since is **out of date**: it says how the text now reads,
    cannot be accepted, and can be changed by its author or an editor into a proposal about the
    text as it is (`reviseProposal`).
  - An accept can be undone while the accepted text still stands as accepted: the old text is
    put back, byte for byte, and the proposal is open again. Each step has its own idempotency
    key, so a retried accept or undo is applied once.
  - An owner or editor can reject; the author can withdraw. Decided proposals stay listed under
    "Decided" with who decided: that list, with the revision diff, is the record of changes.
  - Open proposals are marked in the text in both views with a dashed underline (threads have a
    solid one). The paper's page lists open proposals and threads under "Review", and the checks
    before submitting mention unfinished review without letting it stand in the way.
  - A proposal marks only the words it changes (struck in "Now:", added in "Proposed:").
  - Accepting several at once: for an owner or editor, with two or more plain proposals open, a
    button above the list reads "Accept the N plain changes". A plain proposal is open, not out
    of date, has no flag and no LaTeX warning, was not made by a model review, and is not the
    one being changed. It accepts them oldest first, at most 50 a press (the button says so when
    there are more), each with its own card's `seen`, so one changed since it was drawn is
    refused and left open. Then it reads the list once and says how many were accepted and how
    many were left. A lost connection stops it, and the note says how many were done. No server
    change: each is the ordinary accept, checked for `proposal.decide`.
- **E3: spelling and grammar.** A "Spelling and grammar" panel under the editor of a LaTeX
  file, and a wavy line under each finding in both views. Checked when the file opens and again
  once what was typed is saved and has been left alone for a moment.
  - The engine is LanguageTool 6.8, run by us (`grammar` in `infra/compose.yaml`, `GRAMMAR_URL`).
    No text goes to anyone else's service. Without `GRAMMAR_URL` the panel says checking is not
    set up, and everything else works.
  - `packages/latex/src/prose.ts` turns a file into prose plus markup: running text is sent as
    text; formulas, references, citations, commands, code (`\texttt`, listings), comments and
    the preamble are sent as markup with a stand-in ("Dummy", "[1]"; a comment in a paragraph, `\noindent`,
    `\-` and `\/` read as nothing, and `\\` as a space) so that the sentence still reads. The checker answers in source positions.
  - A finding is shown only if all of it lies in prose (`inProse`). So none is ever in a
    formula, a unit, code, a path or a citation; a service test seeds the same misspelling in
    each of those and holds that.
  - A suggestion is one click: someone who may edit makes the change through the command path
    (so it is refused if the text has moved, and is theirs to undo); a reviewer's click makes a
    proposed change instead.
  - Per paper (migration 0016, "Language" on the paper's page): British or American spelling,
    the paper's own words (not reported as misspelt), and rules switched off. A finding offers
    "It is a word of this paper" or "Do not check this in this paper". Saving the page changes
    only what was changed on it, and adding is done on what the paper holds then (see "A paper's
    own words saved from a page left open").
  - `docs/grammar-benchmark.md`: on 25 sentences with a seeded mistake, 23 are pointed at; of
    20 correct sentences with LaTeX in them, 18 are left alone. Written by
    `packages/server/src/grammar-benchmark.sandbox.test.ts`, which fails if the checker stops
    answering that way. The sentences are synthetic: a corpus of real manuscripts reviewed by
    people is still the owner's to supply.
  - Five rules are always off because they do not fit LaTeX source (its quotation marks, the
    spacing around stand-ins, Oxford -ize as an error): `NEVER` in
    `packages/server/src/grammar.ts`.
- **E4: scientific critique.** Two parts: rules that say what an edit changes about a claim,
  which run on every proposed change, and a review by a language model, which is off by default.
  - **Claim flags** (`packages/server/src/claims.ts`, rules version `claims-1`). The old and new
    text of a proposal are compared for numbers, units, negation, direction, certainty,
    causation, scope, novelty, significance, citations and references, and names. Any difference
    is shown on the proposal ("The numbers differ: 40 → 30.") before anyone decides. They are
    rules over text, not a model, and err towards flagging.
  - `fixtures/critique/challenge.json` has 45 rewrites. Every one that changes a claim is
    flagged for the change it makes, and none of the ten that only reword is flagged; a unit
    test holds both. One case the rules are known to miss ("doubled" to "tripled") is written
    down there as such. The set is synthetic: a set from real manuscripts, reviewed by people,
    is still the owner's to supply.
  - **Model review** (`packages/server/src/critique.ts`). "Ask a model to review the selected
    text" sends the selected passage (at most 6,000 characters) and the paper's own words, and
    nothing else. The answer becomes proposed changes, each with its reason and what in the
    passage it rests on, and questions, which are threads. Nothing is applied. A suggestion that
    does not quote the passage exactly is left out.
  - Three things must all hold before any text is sent: the deployment names a provider
    (`MODEL_PROVIDER=anthropic`), it has credentials, and the paper's owner has ticked "Allow
    passages of this paper to be sent" (migration 0017, off by default, owner only). With the
    owner's switch off the function returns before anything else; a service test with a
    stand-in for the model holds that nothing is sent.
  - Each proposal from a review records the model that answered and the rules version
    (`proposals.origin`, `made_by`, `evidence`; migration 0018).
  - The provider call uses the Anthropic SDK with a schema for the answer, and asks for the
    provider's fallback model if the first declines. **It has not been run against the real
    provider**: there is no key here, and the plan keeps model processing off until the owner
    confirms retention defaults. The tests supply the model's answer themselves.
  - Not yet: approved figure captions and selected evidence from a chosen revision as context
    for the model; a setting for the provider's retention; deleting what was sent.
- **F6: onboarding.** Someone with no papers is told the three ways to begin (a template, a
  ZIP, nothing). A new paper's page has "First steps" for its owner: give it files, write in it,
  see the PDF, bring in a co-author, take it away, each marked "Done" or "To do" in words with
  where to do it. The list comes from the paper's own state (`firstSteps` in
  `packages/server/src/projects.ts`), not from a record of clicks, and goes away once all are
  done.
- **F5: the Tectonic comparison.** `docs/tectonic-comparison.md`. Each fixture built with the
  service's TeX Live image and with Tectonic 0.15.0, with no network, by
  `infra/tectonic/compare.sh`. Recommendation: stay with TeX Live.
  - Both build the article and the IEEE paper to the same number of pages in about the same
    time. Under Tectonic the IEEE paper is set in Latin Modern, not Times, and its headings are
    not in small capitals. The AMS paper, which uses Biber, does not build with Tectonic.
  - Tectonic also fetches TeX files from the network the first time a paper needs them, which
    the service's builds never allow.
  - The Tectonic image is kept (`infra/tectonic/Dockerfile`) only for repeating the comparison.
    Nothing in the service uses it, and CI does not build it.
- **F4: security review.** `docs/security-review.md`: what was checked and how, what was found
  and fixed, and eight things left open with what to do about each.
  - Fixed: the Phase B workbench (`/spike` and `/api/spike/compile`) compiled LaTeX for anyone
    without signing in. Both now exist only with `SPIKE=1`, which the tests set and a
    deployment must not.
  - Fixed: no security headers were sent (now in `apps/web/next.config.ts`); upload and import
    trusted the length a request claimed (`bounded` in `apps/web/lib/server.ts` reads with a
    cap); nothing limited how often a paper asked for a model review (30 an hour,
    `model_requests`, migration 0021).
  - Open, most important first: no script policy yet; an edit can be any size; no general
    request limits; the rest in the document.
- **F3: a restore drill and benchmarks.**
  - `infra/backup.sh` and `infra/restore.sh` dump and restore the database.
    `pnpm --filter @paperweave/server check-blobs` then checks that the object store holds
    every object the database refers to, each matching its digest (`checkBlobs`).
  - The drill is a sandbox test (`apps/workers/src/restore-drill.sandbox.test.ts`): a paper with
    a history is backed up and restored with those scripts into an empty database, and comes
    back equal in files, revisions, a saved ZIP byte for byte, its PDF, its review, and the
    text typed since the last revision. The restored copy takes new edits. `docs/restore-drill.md`
    has the procedure and what the drill does not show (losing the object store, how much is
    lost between dumps, people connected at the time).
  - `docs/benchmarks.md`: twelve measurements of what people wait for, from parsing to building
    to drawing a chart, written by `apps/workers/src/bench.sandbox.test.ts`
    (`WRITE_BENCH=1`). In CI the same test holds each under a ceiling set far above it.
- **F2: product metrics.** How papers fare, as counts on the metrics page the sync server
  already serves to whoever holds `METRICS_TOKEN` (`productMetrics` in
  `packages/server/src/metrics.ts`).
  - Papers by how they began (a template's name, `imported`, `empty`), and how many of each
    have been downloaded as a ZIP and as a PDF (table `downloads`, migration 0020; a download
    of a revision's ZIP or PDF is counted, the PDF beside the editor is not).
  - Papers someone has edited, and papers at least two people have. The edit log says who
    wrote, but compaction forgets it, so compaction first notes the authors
    (`project_authors`).
  - Proposed changes by where they came from (a person, a model review) and what became of
    them. Accepted over decided is the useful-suggestion rate.
  - Labels are template names and statuses. Nothing of any paper is on the page; a test seeds
    a secret and holds that.
  - What became of the grammar checker's findings, by kind (spelling, grammar, style) and
    outcome: `changed` (one click by someone who may edit), `proposed` (a reviewer's click),
    `word` (made one of the paper's own words), `rule_off` (the rule switched off). Table
    `grammar_outcomes`, migration 0027, summed across papers as
    `paperweave_grammar_suggestions{kind,outcome}`. Only the names are kept, never the words or
    the rule. The useful rate is `changed / (changed + word + rule_off)`; `proposed` is left out
    because the reviewer's proposal is decided in the proposals counts.
  - Reviewer grammar proposals still show as `origin = 'person'` in the proposals metric.
    `origin` is left alone because it travels in the review-data export.
  - Dashboards and alerts are still the owner's to choose.
- **F1: accessibility.** `docs/accessibility.md` says what is held by tests, what was found and
  fixed, and what nobody has checked (a real screen reader is the largest gap).
  - `tests/e2e/a11y.spec.ts`: an automated audit (axe, WCAG 2.1 A and AA) of seven pages
    including the editor in both views with everything showing, and one flow done with the
    keyboard alone.
  - Fixed: every page had the title "PaperWeave"; each now names where it is, and never a paper
    the person may not see (`tests/e2e/titles.spec.ts`).
  - Fixed: the PDF pane could not be reached from the keyboard; the PDF's pages had no text (they
    now carry their words, which also makes them selectable); tabbing into the visual editor
    gave no caret; a keyboard selection could be cut short when the keyboard moved on.
- **E5: review data.** With this Phase E is done.
  - "ZIP with review data", beside "Download ZIP" on the paper's page puts the paper's threads and proposed
    changes into the archive as `paperweave-review.json` (`exportReview` in
    `packages/server/src/reviewdata.ts`). The plain download is unchanged and has none.
  - Importing an archive that has that file beside a paper brings the review in with it. Yjs
    positions belong to one copy's edit history and do not travel, so each item goes out with
    its words and 80 characters either side, and is placed by them: where the words are, or,
    if they are there more than once, where the surroundings match (`locateQuote`).
  - A thread whose words are not in the paper arrives detached, with its words. A proposal that
    cannot be placed is left out. The import report says how many of each came in and lists
    what did not, with the reason. Review data that cannot be read, or cannot be written (a
    comment with a NUL character, which the schema allows and Postgres refuses), is reported and
    does not stop the paper itself coming in. A paper's review is brought in as one transaction:
    if it fails, none of that paper's review is kept, and the report says "The review data could
    not be brought in, so none was." (the error itself is not logged, as it can hold manuscript
    text). A thread's comments are written by one statement per 500, not one per comment.
  - **Not done:** placing quotes on a large file with many threads still costs CPU time: about
    450 s worst case for 20,000 threads on a 5 MB file with a common quote (measured). A cap or a
    time budget is an owner decision. The caps (20,000 threads, 5,000 comments a thread) are
    unchanged.
  - The people named in the data may have no account here: they are kept as names
    (`imported_author`, migration 0019), and shown where an author is shown.
  - A service test exports a paper with two threads and four proposals (resolved, detached,
    accepted, rejected, on words that occur twice), imports it as someone else, and holds that
    everything but this copy's IDs is equal.
  - Not carried: who decided a proposal, and whom a comment mentioned.
- **A failed ticket fetch is not a refusal.** Found by a browser test failing once under load.
  Coming back online, the editor asks the web app for a ticket to connect with. If that request
  failed for a moment, the editor treated it as being refused and locked itself with "You no
  longer have access to this file". Now only an answer locks it (the sync server refusing, or
  being signed out); a fetch that fails is tried again a second later. `recover.spec` fails the
  first two fetches and holds that the editor carries on.
- **A restore keeps what it replaces.** Found by the fault suite on a seed it had not run before.
  A restore put back the chosen revision but kept no copy of the paper as it stood, so text typed
  since the last revision (an edit that reached the server a moment before, say) was erased with
  no way back. Now `restoreRevision` first cuts a revision of the paper as it is, and does the
  whole restore as one transaction with every file of the paper held: no edit lands in between,
  and a restore that fails half way changes nothing.
  - `editFile` is now one transaction under the file's lock; `editLocked`, `lockedUpdates` and
    `cut` are the same steps for use inside a larger transaction.
  - The fault suite reads what a restore took away from that kept revision, and checks that the
    kept revision holds everything that was stored.
- **Phase B spike.** Gate report: `docs/phase-b-gate.md`. Recommendation: go.
  - `packages/latex`: lossless block parser, incremental reparse, include graph, encoding round
    trip, coverage.
  - `packages/bridge`: projection to a ProseMirror document, visual edits as source splices.
  - `apps/web`: `/spike`, two authors with a source and a visual editor each.
  - `apps/workers`: sandboxed compile (`src/compile.ts`, CLI in `src/cli.ts`).
- **Publisher front matter, acknowledgments and common theorem names are prose in the visual
  view.** `DEFAULT_TRANSPARENT` (`packages/latex/src/parse.ts`) gained `frontmatter`, `keyword`,
  `acknowledgments`/`acknowledgements`/`acknowledgment`/`acknowledgement`, `acks`, `IEEEproof`,
  and `claim`, `conjecture`, `property`, `problem`, `exercise`, `question`, `solution`, `note`,
  `case` (all defined by `llncs.cls`; `conjecture` also by `acmart.cls`; `IEEEproof` by
  `IEEEtran.cls`). `assumption` was left out: none of llncs, acmart or IEEEtran defines it, and
  `svjour3.cls` is not in the TeX image. An `elsarticle` skeleton was one raw block; now each of
  `\title`, `\author`, `\affiliation` is a raw block and the abstract, keywords and
  acknowledgments are paragraphs (`fixtures/real-elsevier` 32% to 58%, `fixtures/real-llncs`
  56% to 65%, in `docs/import-matrix.md`; both build in `compile.sandbox.test.ts`).
  - The editor, the bridge's containment check and the server's check all read this one default
    (`parse` and `containedNear` default to it), so they agree.
  - A paper's own theorem environments (`\newtheorem`, `\spnewtheorem`, `\declaretheorem`,
    `\newmdtheoremenv`) are prose too, in the editor, the bridge, the server's containment check,
    the import report and the grammar check. `proseEnvs` (`packages/latex/src/envs.ts`) reads the
    names from the root's preamble, the files it reads and the project's own `.sty`/`.cls` it
    loads; `paperProse` loads them with the page, beside `paperMacros`. Names must be plain
    letters (at most 32, at most 64 of them) and not a maths, verbatim, list, float or table
    environment.
  - A contained command carries the set it was built with (`Command.prose`, the names beyond the
    default). The server checks them (`invalid_input` for a malformed list) and uses them for its
    containment check, so both sides agree by construction. That check is a correctness guard, not
    a permission: a writer can already type any bytes through Yjs.
  - Staleness: the set is read when the page loads, like the macros. A `\newtheorem` added since
    shows as a boxed block in the visual view (not a one-line marker) until a reload. The grammar check reads it on each check.
  - Proposals never set `contained`, so they run on the default set and are unchanged.

## DOI lookups are limited, polite and bounded

- **Found by** the security review: no limit on lookups, no contact address for the registry,
  an unbounded answer, redirects followed.
- **Now** `lookUpDoi` counts each ask in `doi_requests` (migration 0028) before making it:
  30 per person per ten minutes, 500 per paper per day (`DOI_LOOKUPS_PER_USER`,
  `DOI_LOOKUPS_PER_PROJECT`); past either: "Too many DOI lookups just now. Try again in a few
  minutes.", nothing sent. The permission check still comes first. `CROSSREF_MAILTO`, when set,
  goes in the User-Agent (`PaperWeave/0.1 (mailto:...)`); never logged or stored. The answer is
  read to 1 MB (`outbound.ts`), redirects are not followed; the language checker got the same.
- **Held by** `evidence.sandbox.test.ts`.
- **Not done:** no UI change; rows of `doi_requests` are not pruned.

## Upload addresses carry a size and are counted

- **Found by** the planner: one account got 300 size-less addresses, three 120 MB PUTs passed a
  100 MB limit, and the bytes sat in `tmp/` until dropped by hand.
- **Now** `startUpload` requires a whole `size` within the limit for ZIP or file and signs it as
  `content-length`; each address is recorded in `upload_addresses` (migration 0030): 10 untaken
  per person, 2 GiB declared per hour (`UPLOADS_OUTSTANDING_PER_USER`,
  `UPLOAD_BYTES_PER_USER_HOUR`); a key is taken once. The worker's sweep removes untaken uploads
  half an hour old (was a day; schedule unchanged) and forgets records a day old. `DirectUpload`
  already sent the size.
- **Store check:** SeaweedFS with an identity refuses a different length (403). The compose
  store has none and takes any length, so there only the take-time size check holds.
- **Held by** `uploads.sandbox.test.ts` (changed: size-less addresses are refused; a second take
  now says "not found", not "did not arrive") and `uploading.spec.ts`.
- **Not done:** a second PUT to an address before the take replaces the object (same length);
  concurrent requests may pass the count together by a few.

## One account cannot fill the build queue

- **Found by** the planner: one account started 100 papers and queued 100 builds in under a
  second, none refused, and a victim's was the 101st. Two papers of `\def\x{\x}\x` ran the full
  60 s each; the victim's 1 s build waited 121 s. Builds were counted per paper only, taken
  oldest first, and the worker drew a chart only when no build was queued.
- **Now** `requestBuild` counts by requester under a per-person advisory lock: 3 builds waiting
  or running over all papers and 120 asked for per hour (`BUILDS_WAITING_PER_USER`,
  `BUILDS_PER_USER_HOUR`), with a message that says why. Every build is queued there (the
  editor, the submit page's "build and check", a revision's build). The editor's own automatic
  build (header `x-auto-build`) is refused earlier, `BUILDS_RESERVED_FOR_PRESSED` (20) short of
  each hourly limit (per paper, `BUILDS_PER_PAPER_HOUR`, and per person), so pressed, submit and
  revision builds can still get in; once half the paper's hour is used, automatic builds are
  also 30 s apart. The route
  answers `{ id: null, paused: reason }`; the pane says "Automatic compiling is paused: ..." in
  its status and asks again every 30 s while the PDF is behind the text. Measured before this
  (typing in the editor, a sentence then a 3 to 5 s pause, 2 minutes): 16 automatic builds, one
  every 7 s, 17 rows and none answered from an earlier result, about 480 an hour of writing:
  the paper's 120 would have been gone in 15 minutes, and then every press refused. The worker takes the
  queued build whose requester has had the fewest builds done in the last hour, then the oldest
  (`takeBuild`; index `builds_requester`, migration 0031), and alternates builds and chart
  drawings (`takeTurns`) so neither starves the other.
- **Held by** `packages/server/src/builds.sandbox.test.ts`, `apps/workers/src/builds.sandbox.test.ts`
  (fair order) and `apps/workers/src/turns.test.ts`; each failed on the old code.
- **Not done:** several accounts still share one worker in proportion to their requests, and
  a build runs up to 60 s: more workers are a deployment decision. A running build is not
  counted in the fair order until it is done.

## Next

Every item in `docs/plan.md` from the scaffold to Phase F has been built. Since then the work
has been the security review's open items, the marked shortcuts the plan said to come back to,
and two faults in the editor that made browser tests fail once in a while (all below).

What is left is not code that can be written here:

1. **The owner's decisions**, listed below. Two of them change what should be built next:
   whether proposals stay stored beside the text, and whether model processing may be turned
   on (and with what retention at the provider).
2. **Hosting.** Nothing has been deployed. `docs/settings.md` lists what each service reads
   from its environment and what must reach what. `docs/security-review.md` ends with what only
   a deployment can settle: TLS, the production sandbox, where the store and backups live, a
   proxy that limits requests, who may read the metrics.
3. **What each document says was not checked.** A real screen reader, browsers other than
   Chromium (only Chromium is installed where this was built) and real input methods
   (`docs/accessibility.md`); losing the object store
   (`docs/restore-drill.md`); real manuscripts for the grammar benchmark and the claim
   challenge set, which are synthetic today.
4. **The Phase A replays**, which need a person with accounts: `docs/rea/matrix.md`. What the
   products' public documentation says has been gathered for all six (`docs/rea/overleaf.md`,
   `grammarly.md`, `prism.md`); nothing in it called for a change to what is built. Each file
   marks what no page says, which is what a live replay is still for. **Overleaf's terms
   forbid automated access to its site**: `overleaf.md` says what was read before that was
   noticed, and whether to keep that file is the owner's call.

That list was written before a run of faults that were all in code, and each reached by
ordinary use. Ten ways of looking found them, and each is cheap to do again:

1. **Do the second of something.** Open a second file, redraw a chart, build an older
   revision, restore across a chart. Found: a PDF that stayed "behind" for ever and used up
   the paper's builds; builds that stayed "up to date" after a chart was redrawn; a chart that
   said "drawn" with its files gone.
2. **Change something about a person while their page is open.** Sign them out, lower their
   role. Found: an editor that typed into nothing; a page that carried on as the next person
   to sign in.
3. **Give a paper many of something.** 5,000 revisions, 2,000 files, 200 people with 400
   threads, a .bib file of 2,000 entries. Found: a paper's page of 16 MB; every file read
   one after another; a file's page that took two seconds to take a key; a paper's page of
   23 MB that took twelve seconds to come.
4. **Make every browser test refuse what no page should do**, after first only collecting it
   over the whole suite. Found: pages fetched before anyone asked; a field's pattern that
   browsers ignored; a caret put where no text can go.
5. **Press things twice, and look where the first look did not go.** Buttons pressed twice;
   the accessibility audit in the editor's stopped states and on pages only reached through a
   flow. Found: invitations and sign-in links with no limit on how many one address is sent;
   two revisions from one save; a stopped editor the keyboard could not reach; two papers
   from one double press.
6. **Take a service away.** The build worker, the mail, the object store, the database.
   Found: "Compiling" for ever; an invitation left behind when its email could not be sent;
   an error page that the pages' own content policy refused; and a sync server that a
   database restart ended.
7. **Run two of a service.** Found: two sync servers on one database quietly showed people
   different text. Two workers were fine, and are now held by a test. Two web apps behind
   a proxy were fine too, once a fault that any proxy brings out was fixed (see 9).

8. **Change a thing while someone is part-way through working on it.** Resolve the thread
   they are replying to; decide the proposal they are changing. Found: both forms went, with
   what was written in them, at the next look at the server and without a word.

9. **Run it as it would be deployed, and read what each answer tells the browser.** Two
   copies of the web app behind a proxy; how long each answer may be kept. Found: forms
   that sent the browser to an inner address; a PDF handed over after signing out.

10. **Go back and forward.** Found: pages that showed what was no longer so, a removed
    member and a lost role among them.

11. **Bring something in from outside.** Paste into the visual view, and drop onto a page.
    Found: two paragraphs, a list and a picture each pasted to nothing, without a word; a file
    dropped on almost any page left to the browser, which opens it in place of the app; a
    `.bib` dropped on the source put into the text without a word.

12. **Go to each limit the app states: one under, exactly at it, one over.** Found: a file
    over 10 MB could not be added at all, though the stated limit is 50 MB, and was refused
    with a sentence about something else; a note with line breaks refused at a length its
    field allowed; a caption too long told it held the wrong characters.

13. **Make every answer slow.** Every message to and from the sync server held back a second
    each way, and once ten. Found: typing carried on elsewhere pulled back beside an insertion
    once its answer came; a full stop of the person's own deleted after a table cell was
    changed; an edit said to have failed that had been made, and made twice when tried again.

14. **Undo, and redo, everything the page can do.** Found: after undoing a paragraph just
    begun, the caret left where nothing can be typed, and what was typed next lost; undo in a
    paragraph just opened with Enter taking back the thing before it.

15. **Break the paper the ways authors do, and read what the page says.** Found: a mistake in
    the `.bib` failing the build with nothing listed; the stop listed as if it were the cause,
    and before it; errors placed in files the paper does not have; a PDF with ?? in it called
    up to date without a word in the editor.

16. **Take a paper out and bring it back, and compare everything.** Found: one item the
    importer would not read losing the whole review; the root file not carried, so the paper
    built a different document; a thread on edited words coming back detached; a stale accept
    coming back fresh; who decided a proposal not carried.

17. **Rename something, then look everywhere it was named.** Found: a paper whose root file is
    in a folder never building; a file renamed at once, without a word, when the page saw no line
    naming it, though a package, class, listing or data file was named another way; a picture
    found through `\graphicspath` not followed; a label's `\hyperref`, `\fref` and `\zcref` left
    behind, and the PDF's ?? not said.

18. **Follow one person in and out of a paper.** Found: someone removed, or who had left,
    joining again on a spare invitation; invitations that could not be seen or cancelled, so a
    mistyped address could join; a second invitation not replacing the first; an invitation
    page that said a member would become an editor, and one that left the wrong account with
    no way on.

19. **Ask whether the paper is ready, of papers that are and papers that are not.** Found: a
    hand-written bibliography, IEEE's own abbreviations and a label made by a package each
    keeping a correct paper from ever being ready; a reference through a macro, and a key in a
    `.bib` the paper does not name, called ready with ?? and [?] in the PDF.

20. **Take up everything the checker suggests, and read the source afterwards.** Found: a
    suggestion put into the source as plain text, so that a repeated `R\&D` became a bare `&`
    and a `%` hid the rest of its line from the PDF, by an owner or through a reviewer; a word
    offered for the paper's words that could not be one.

21. **Give the checks the entries real bibliographies hold.** Found: a DOI written for BibTeX
    said not to exist; an arXiv DOI said to have no record, as if wrong; two different titles
    in Chinese said to match, and a deleted Chinese claim said to be still in the paper; the
    same title, author, year or venue said to differ for the registry's markup or spelling.

22. **Use the jump while the PDF is behind the text.** Found: a double-click at the start of a
    wrapped line taken to the end of its paragraph, once into the next file; a heading at the
    top of an included file shown in the paragraph before it; after an edit above, a click
    put ten lines early with nothing said; a renamed file named by its old name, and a deleted
    one answered for.

23. **Press the ordinary keys everywhere in the visual view.** Found: a caret left where nothing
    could be typed, after Delete before a list or Backspace at a list's start; a refused
    selection kept, so that every key after it was refused; a selection across paragraphs that
    could not be deleted or typed over; a note that stayed after the next key worked.

24. **Restore, then look at everything that hangs off the text.** Found: threads and proposals on
    words a restore did not change cut loose, an accept that could no longer be undone, a second
    person's typing split and moved, and a lost proposal that could be saved as an insertion in
    the wrong place.

25. **Change a claim the way a reviewer would, and see whether the owner is warned.** Found: a
    one-word proposal judged on that word alone, a swapped comparison read as the same claim,
    plain opposites not known, and rewordings flagged though nothing changed; then formulas,
    units in `\SI` and `\qty`, names opening a sentence and number words past twelve not
    read at all.

26. **Import the shapes real papers come in.** Found: a root in a folder imported without the
    figures and bibliography beside it; an arXiv source without its `.bbl`; `.tikz`, `.pgf`,
    `.dat` and fonts dropped; a root name with a space that could never build; the cover letter
    taken for the paper; and refusals of a `.tar.gz`, a split root and a Latin-1 root that said
    nothing useful.

27. **Unpack what was downloaded and build it somewhere else.** Found: a paper called ready to
    send whose ZIP could not build, for a data file kept back that it reads, with nothing said
    at the download; a manifest naming a file not in it; and download names that lost every
    letter outside ASCII, and every PDF saved as `pdf.pdf`.

28. **Follow every email: who gets it, how fast, and where its link lands.** Found: a request
    held 30 to 60 seconds by a mail service that said nothing, a saved comment that looked
    unsent and was posted twice, mention emails without limit, a link that did not lead to the
    comment, a paper name that put lines into other people's emails, and "INVALID_TOKEN" on the
    page.

29. **Put distance between the web app and its database and store.** Found: a restore that held
    everyone's typing for 13 s at a 50 ms round trip; an open editor making about 290 round trips
    a minute; a paper's page reading each file four times; saves and downloads one file at a
    time.

30. **Use a page before its script has started.** Hold back `/_next/static/*.js` (`scriptsHeld`
    in `tests/e2e/helpers.ts`), as a slow line does. Found: a file dropped on the page opened in
    its place; a sign-in form posted as a plain GET with the address in the URL; a double press
    on "Create paper" 50 ms apart making two papers (see "Before the page's script has
    started").

Tried the same way and nothing found: thirty connections typing into one file at once (kept
as a test in `sync.sandbox.test`); 400 threads and 400 proposals on one file, on the server
(both lists took about 20 ms; not kept); and each tool of the visual view worked slowly
while a second tab typed steadily into another paragraph of the same file: a table cell, a
caption, a formula, the reference picker, the menu, a selection, a comment being written,
and typing itself. All eight kept their place and their text, three times over (not kept).

Also tried and found sound: every page and route under one paper, asked by someone on that
paper with the ids of another paper they are not on (its file, build, revision, thread and
proposal), by GET and by POST. Every answer was "not found", an empty list, or a refusal of
the request's own content, none carried any of the other paper's text, and nothing of the
other paper changed. Two answers are by design: `/api/sync-ticket` issues a ticket for any
file, and the sync server refuses the connection (its tests hold that); the rename page
checks the new name before it looks at the file. One probe, run once, not kept.

Also tried and found sound: 400 proposed changes on one file, in the browser. Measured with
the browser's own event timing and long-task records, one machine, once each, the rows
cloned in the database by a probe that is not kept:

| Open | Decided | Elements on the page | A key typed, source view | Visual view | Long tasks, 12 s idle |
| ---- | ------- | -------------------- | ------------------------ | ----------- | --------------------- |
| 1    | 0       | 761                  | 16 ms (worst 16)         | 16 ms (32)  | none                  |
| 20   | 380     | 4,814                | 16 ms (32)               | 24 ms (48)  | none                  |
| 400  | 0       | 8,991                | 16 ms (32)               | 24 ms (80)  | none                  |

Figures are medians, in the browser's 8 ms steps. Nothing was changed. Two costs are real
and harmless at this size: the 380 decided proposals are drawn inside their closed list
(4,605 of the elements), and the list is asked for whole every five seconds, 460 KB once
unpacked (16 KB over the wire). The bar for changing code was a median key over 50 ms or an
idle long task over 100 ms; neither came near. Noticed while planning this: the next section.

Not yet tried: a second browser.

If more is to be built before those are settled, the candidates are in the code as
`shortcut:` comments (seven of them, each saying when it stops being good enough) and in the
"Open" list of `docs/security-review.md`.

## An edit that is too large

Built after the security review, which had it as its second open item.

- **Limits.** 4 MB for anything read off the sync connection, 2 MB for one edit, 50 MB for a
  file's text (`MAX_EDIT_BYTES`, `MAX_FILE_TEXT` in `packages/server/src/sync.ts`). A
  structural edit is held to the file limit too.
- **What the server does.** The edit is not saved and not applied. The connection is told
  `too-large` and closed. Counted as `paperweave_sync_edits_too_large_total`.
- **What the editor does.** It stops, says the edit was too large and that unsaved edits
  cannot be kept, and offers "Discard my edits". It does not connect again until then, because
  connecting would send the same edit again. The text can still be selected and copied.
- **Why everything unsaved goes, not just the large edit:** the editor cannot take one edit
  back out of what it has not yet sent; later edits may rest on it.
- **Not limited:** how many files a paper holds. A member can still grow the log by adding
  and deleting. That is the review's "limits in general". How often someone edits is limited
  by size: see "A person's edits have a budget".

## A compiler warning says which file it is in

- **Before:** a warning from a build had a line and no file, so in a paper of several files
  "line 19" did not say where. Marked as a shortcut in the code since Phase B.
- **Now:** the file is the one TeX was reading when it wrote the warning, worked out from how
  its log nests the files it opens (`readingAt` in `apps/workers/src/compile.ts`). On the
  checks before submission the warning links to that file, and the link opens the editor at
  the line. So do the other findings there that have a line.
- **How far to trust it.** The log is not written to be read by a program: text in it has
  brackets of its own. Lines that quote the paper's text are passed over, and other brackets
  are taken to pair up within their line. A test builds each fixture and checks that every
  warning is placed in a file that exists, on a line it has. A log that breaks those
  assumptions could put a warning in the wrong file; it would never lose the warning.
- A warning written while TeX reads one of its own files (a package's) gets no file.
- A warning that runs over several lines of the log is read as one, with the line number it
  ends on: before, a package's two-line warning lost its line, and font warnings were not
  reported at all. The same warning written once per pass over the paper is shown once.

## What TeX writes is UTF-8, not Latin-1

- **Before:** the log, `.aux` and SyncTeX were read as Latin-1, so a file, label or citation key
  with an accent or CJK came out garbled: its diagnostic found no file, `\ref` showed `??` in the
  visual view, a defined reference got a false "LaTeX resolved it" warning, and source and PDF
  jumps failed for that file.
- **Now:** all three are read with `texText` (`packages/latex/src/encoding.ts`): UTF-8, and a
  byte that is not part of a valid sequence is its own Latin-1 character. pdflatex, xelatex and
  lualatex all echo the sources' bytes as they are (no `^^` escapes, no `\IeC` in labels or
  keys), checked against the real image. The log is stored as it is and served as UTF-8.
- Builds cached before this hold garbled diagnostics and labels, so the cache key carries a
  `TEX_TEXT` salt (`builder.ts`): each paper rebuilds once. Earlier build records are not rewritten.

## An EPS picture that built as an empty box

- **Before:** with `\includegraphics{fig.eps}`, pdfLaTeX and LuaLaTeX built "successfully" and drew
  a frame with the file's name where the figure should be; nothing in the log said so, so the ZIP
  and PDF shipped with boxes and the paper was ready. XeLaTeX failed (exit 12, no PDF) with only
  "failed without saying where". Cause: the build runs with `-no-shell-escape` (the spec), so
  `epstopdf` is not loaded; `graphics.sty` then switches that picture to draft mode quietly. The
  image has no Ghostscript, so XeLaTeX cannot convert either.
- **Now (detected, not converted):** `epsPictures()` (`apps/workers/src/compile.ts`) reads the
  `INPUT` lines of latexmk's `.fls` and gives the project path of each EPS the build opened
  (macros, `\graphicspath` and names with spaces included). A successful pdfLaTeX or LuaLaTeX
  build gets a warning `Picture not shown: <path> is an EPS file ...` for each. A paper that
  ships `fig-eps-converted-to.pdf` and loads `epstopdf` is not warned: the `.fls` shows the PDF
  was read. XeLaTeX's `xdvipdfmx` "Image format conversion ... failed" line becomes an error that
  names the file. The paper is not ready (`file` problem, with the file's id) while a build says
  so; the build pane lists them under "Built, but these pictures are not in the PDF". Importing a
  paper that includes an EPS adds a note naming the engine's behaviour.
- Cached builds are redone (`TEX_TEXT` is now `utf8-biber-eps`).
- **Not done, owner decisions:** Ghostscript in the TeX image (also makes XeLaTeX work and
  `epstopdf` possible with shell escape on), converting EPS to PDF on import, or a restricted
  shell escape that allows only `epstopdf`/`gs`. Until then an author converts the file.

## Characters the font lacks vanished from the PDF

- **Before:** with `fontspec` (XeLaTeX, LuaLaTeX) a character the font has no glyph for (CJK in
  an author line, μ ≤ ≠ ✓ in the text of the default Latin Modern) was left out of the PDF.
  TeX wrote `Missing character: There is no 王 (U+738B) in font [lmroman12-regular]:...!` to the
  log, exit 0, and `diagnostics()` read only `... Warning:` lines: the paper was ready.
  pdfLaTeX with `inputenc` errors instead (`Unicode character ... not set up`, already shown);
  it writes the line only for a slot the font lacks (`There is no ^^a0 in font cmr10!`).
- **Now (detected, not fixed):** `diagnostics()` (`apps/workers/src/compile.ts`) reads those lines
  and gives one warning per file, `Characters not shown: 王 小 明 are not in the font (lmroman12-regular);
the PDF leaves them out.` (up to 12 distinct characters; invisible ones as `U+200B`; several
  fonts: "and others"). XeLaTeX writes them while setting the text, so the file is the one being
  read then: title and author characters land on the file with `\maketitle`, not a line number.
  LuaLaTeX writes them when a page is shipped out, so there the warning has no file. The
  submission check makes it a problem (`file` kind, with the file when known) and the build pane
  lists it under "Built, but some things are not in the PDF".
- **The fix is the author's:** a font with those glyphs, e.g. `\setmainfont` via fontspec. No
  fonts were added to the image.
- Cached builds are redone (`TEX_TEXT` is now `utf8-biber-eps-glyphs`).

## An undefined BibTeX/Biber abbreviation dropped a field

- **Before:** `journal = cvpr` (an unquoted abbreviation no `@string` defines) built green and
  the reference was printed without its journal. BibTeX (`plain`) wrote `Warning--string name
"cvpr" is undefined` and, on the next line, `--line 4 of file refs.bib`, then `Warning--empty
journal in he16`; Biber wrote `WARN - BibTeX subsystem: <temp copy>, line 4, warning: undefined
macro "cvpr"`. Both exit 0, the `.bbl` has no journal, and `diagnostics()` matched neither
  (the BibTeX reader wants `---line N` on the same line; the Biber reader took only `ERROR - `).
- **Now (detected, not fixed):** `diagnostics()` gives one warning on the `.bib` and line,
  `Abbreviation not defined: "cvpr" is used in refs.bib but no @string defines it; the reference
is printed without that field.` (once, though latexmk runs BibTeX again). The submission check
  makes it a `file` problem and the build pane lists it under "Built, but some things are not in
  the PDF". An abbreviation defined in another `.bib` of `\bibliography{strings,refs}` is not
  flagged (Biber reads files in order: one listed after its use is, and does lose the field).
  Left unsurfaced as noise: `empty journal`, `entry type ... isn't style-file defined`.
- Cached builds are redone (`TEX_TEXT` is now `utf8-biber-eps-glyphs-strings`).

## `<`, `>` and `|` typed in the visual view printed as `¡`, `¿` and `—`

- **Before:** `escape()` passed `<`, `>`, `|` through bare. pdfLaTeX's default (OT1) encoding
  holds other glyphs in those slots, so "p < 0.05" typed in the text shipped as "p ¡ 0.05":
  exit 0, no warning, ready to submit. (With `[T1]{fontenc}` and in XeLaTeX they were right.)
- **Now:** `escape()` writes `\textless{}`, `\textgreater{}`, `\textbar{}`, which print the
  right glyph in OT1, T1 and XeLaTeX. The parser reads them as one shown character (like
  `\textbackslash{}`), so they show as `<` `>` `|` and Backspace removes each whole. Callers
  (typing, paste, grammar replacements) only ever write into prose.
- **Not fixed, not flagged:** a bare `<`, `>` or `|` already in a source (typed in the source
  view, or imported) still builds wrong under pdfLaTeX without T1. Those bytes are never
  rewritten and still show as themselves. TeX gives no signal, so nothing says so.
- **Recommendation (not built):** a readiness warning for a bare `<`, `>` or `|` in prose
  (the `prose()` segments, so not math, `\verb`, `\url`, code) when the class is pdfLaTeX and
  the preamble loads no `fontenc` with T1 (`\usepackage[T1]{fontenc}`). It is cheap to find but
  not reliable: a class or package may load T1 itself (e.g. through `lmodern`/`fontspec`-like
  packages), so it would warn falsely. Worth doing only as a "may print wrongly" note.

## `"` typed in the visual view changed the next letter under babel

- **Before:** `escape()` passed `"` through bare. Under `babel` with German, Dutch, Spanish
  (and others) `"` is an active shorthand that swallows the next letter, so `"aber"` typed in
  the text shipped as `äber` and `"sehr"` as `ßehr`: exit 0, no warning. Without babel it
  printed a closing quote for both.
- **Now:** `escape()` writes `\symbol{34}`, which prints a plain `"` with no letter eaten in
  body text, headings, captions, tables, `\emph`, `\texttt`, in pdfLaTeX (OT1, T1, babel
  ngerman/dutch/spanish/russian), XeLaTeX and LuaLaTeX. The parser reads it as one shown
  character, so it shows as `"` and Backspace removes it whole. Typing, multi-paragraph paste
  and grammar replacements all go through `escape()`. Other `\symbol{N}` stay raw atoms.
  (`\textquotedbl{}` was not used: it errors under pdfLaTeX's default OT1.)
- **Not fixed:** a bare `"` already in a source is left as it is and still shows as `"`. A
  German author who typed `"a` in the visual view expecting `ä` now gets `"a` literally,
  which is what the view shows; use `\"a` or `ä`.
- **hyperref:** in a `\section` (or anything bookmarked) `\symbol{34}` makes hyperref log
  `Token not allowed in a PDF string (Unicode): removing \char`. It is shown as one warning
  (not an error; the build is ok) and the PDF bookmark just lacks the quote. Not wrapped in
  `\texorpdfstring`: it exists only with hyperref, so it would fail every paper without it.

## Cut and copy from the visual view dropped formulas, citations and emphasis

- **Before:** Ctrl+X then Ctrl+V of a sentence deleted every formula, `\cite`, `\ref`,
  `\footnote` and `\emph` in it. The editor put only the shown words on the clipboard (an atom
  has no text) and paste took `text/plain` as typed words. Seen in Chromium: `...significant
($p < 0.05$) as shown by \cite{smith2020}...` came back as `...significant () as shown by  in
Figure~, ...`, with no warning and `check()` passing.
- **Now:** copy and cut in the visual view also put the selection's source on the clipboard as
  `application/x-paperweave-latex` (`Bridge.sourceOf`: the bytes between the ends, paragraph
  breaks and whole blocks included). The plain text now carries each atom's LaTeX too
  (`renderText`), which helps other programs. Paste of that type, if `pasteable()` accepts it
  (braces, environments, `$`, `\[ \(` balanced; no trailing comment; no preamble or
  `\end{document}`), deletes the selection and inserts the LaTeX through the server's command
  path, in the same queue as other structural edits. The source view takes it too, so `<` arrives
  as `\textless{}` and a formula as its source. Reviewers and viewers can copy.
- **Limits:** a selection that ends inside a group (half of an `\emph`), or whose source would
  not stand alone, puts only plain text on the clipboard and pastes as typed words. Pasting
  over a selection is two undo steps (the delete, then the insert). Custom clipboard types are
  tested only in Chromium. Clipboard contents are never logged.
- **Guarded like typing.** Anything put in through the command path (this paste, the
  several-paragraph paste and drop, and the other inserts from `insertion()`) went into the
  source verbatim, so `[Optional] ` at the start of an item became its label, `so on\ldots`
  before `then` gave `\ldotsthen`, and text after a `% comment` was swallowed. `fillCommand`
  now adds what typing adds (`guard()`): `{}` before or after where a command name would
  run on or take a `[`/`*`, and a line break after a comment. It is built in the queue, against
  the text the earlier commands left. Not covered: the source-view paste (the source is
  raw LaTeX there), and grammar replacements. Proposal replacements are warned about, not
  guarded: see "A proposal that would break as LaTeX says so".
- **Block-level text only goes where LaTeX can take it.** A copy from mid-item to mid-item
  pasted in a paragraph wrote `Before text.alpha\n\item two` (`Lonely \item`), and two
  paragraphs pasted or a heading or list inserted with the caret in a heading or inside
  `\emph{...}` wrote a blank line there (`Paragraph ended before \@sect was complete`): no PDF.
  `Bridge.blockPlace` says whether the caret is at the top level of a paragraph (`'para'`), of a
  list item (`'item'`) or neither (null: in a group, heading, caption or raw block). The
  heading and list inserts need `'para'`; `needs()` sorts pasted LaTeX into `'item'` (an `\item`
  outside any environment), `'block'` (blank line, `\begin`, `\[`, `$$`, sectioning) and
  `'inline'`, and `Bridge.accepts` lets an `'item'` paste into an item only and a `'block'` paste
  into a paragraph or item only. Otherwise the paste falls back to the plain words (a copy
  across items arrives as words), and several pasted paragraphs where the place is null say
  "Several paragraphs cannot be pasted here" and change nothing. Copy across items pasted into
  another item still goes in as LaTeX and splits that item. Not covered: a heading inserted in an
  item is still refused; the source-view paste is raw LaTeX as before.

## How long a large import takes

- An import still runs inside its request. Measured at the most files a paper may hold
  (2,000): eight and a half seconds, nearly all of it storing the files one after another.
- They are now stored sixteen at a time: about three seconds (`docs/benchmarks.md`, which
  now has this row and fails in CI past sixty).
- Size hardly matters: two files of 45 MB added a tenth of a second.
- So a job queue for imports is still not built. It would be needed where something in front
  of the app cuts requests off sooner than a few seconds, or if the limits are raised.

## How often the expensive things can be asked for

- **Papers started: 100 an hour for one person**, whether by hand, from a template or out of
  archives (`LIMITS.papersPerHour`, `mayStartPapers` in `packages/server/src/projects.ts`).
  An archive that would go past the number is refused whole.
- **Chart drawings: 120 an hour for a paper**, the same as builds (`CHART_DRAWS_PER_HOUR`).
  Counted in `chart_requests` (migration 0022), not `chart_draws`: a drawing that gives the
  same files as before is not recorded there again, so it could not be counted from there.
- **Invitations: 30 an hour for one person**, over all their papers
  (`INVITATIONS_PER_HOUR` in `packages/server/src/projects.ts`). Each is an email to an
  address its sender chose; before this, anyone with an account could have the service write
  to any number of strangers. Found by pressing "Send invitation" twice to see what happened.
- **Sign-in links: 10 an hour to one address**, whoever asks (`maySendSignInLink` in
  `packages/server/src/auth.ts`, migration 0024). The sign-in library already limited how
  often one client may ask (five a minute); nothing limited how often one address was written
  to, so a few clients together, or one patient one, could fill someone's inbox. Only a hash
  of the address is kept, for a day. Past the limit the form says the link could not be sent.
  - The trade: for that hour nobody can have a link sent to the address, its owner included,
    so someone can be kept from asking for a link by another person asking in their name.
    The links already sent are in the owner's inbox and each works for 15 minutes, so they
    are slowed, not shut out. Whether ten is the right number was not tested on anyone.
- The numbers are guesses at "far more than anyone means to do". Nothing measured them.
- Not limited: reading pages, checking grammar, typing. See `docs/security-review.md`.

## Saved edits that did not reach the people in the file

Found by the fault suite (`apps/sync/src/faults.sandbox.test.ts`), which failed once in CI and
about once in twenty-five runs on a busy machine.

- **What happened.** Two people leave a file a moment apart. The first has edits the server
  has not yet worked through. The sync library drops the first from the file's list as their
  socket closes, but goes on through their edits. When the second leaves, nobody is listed, so
  the file is unloaded at once. The first person's remaining edits are then saved to the log
  and applied to a copy of the file that nobody is on. Whoever opens the file next reads the
  log before those edits are in it, and is never sent them.
- **For people:** everything was saved, and a reload showed it. But until then the person in
  the file did not see text that was in the paper, and a download or a build could hold words
  they had never been shown.
- **Seen, not guessed.** A trace of the server showed the order of events above, and a
  detector for "an edit arrived on a copy that is not the open one" fired in 11 of 30 replays
  of one seed.
- **Now** (`apps/sync/src/server.ts`): an edit saved from a connection that is no longer on
  the open copy is passed on to the open copy. And the first time someone is let in to a
  freshly read copy, the log is read once more from where the reading began, for anything
  saved while it was being read. Counted as `paperweave_sync_edits_off_the_open_copy_total`.
- **Tests.** A service test makes it happen with a server whose writes are slow: without the
  change the next person never gets the text (two runs of three), with it they do. The seed
  that failed: 0 of 30 after. Fresh seeds on a busy machine: 0 of 26 after.
- **Not changed:** the library still drops the connection early. This works around it. It
  has not been reported to the library's authors. `docs/upstream.md` has it written up ready
  to file, with two other things in the library that this project works around.

A second failure of the fault suite, found while looking, was the suite's own mistake: it
recorded what a saved revision held from the text a moment before saving, and an edit still
on its way in could land between. The revision was right and the record wrong. The suite now
reads what the revision holds from the revision. One seed failed every time before this and
passes now.

When the suite fails with people apart, it now says who lacks what and who alone has what.

Two things about tests, found on the way and not about the product:

- **The fault suite once timed out at its first step in CI**, before any fault: three clients
  connect to a server just started, and one was not confirmed in fifteen seconds. Not
  reproduced in 28 runs on a busy machine. A possible cause, not shown to be the cause: the
  suite's server could be given a port that the other file of sync tests, which runs at the
  same time, was also using for the extra servers added to it lately. The two now use ports
  that cannot meet. That wait also now says which client was stuck and how.
- **`recover.spec`, "a file takes no typing until it has arrived", failed about once in 25
  runs.** It held the connection back by holding the request for a ticket, and now and then
  the editor connected without that request being seen at all. Why is not known. The test now
  holds the connection to the sync server itself, set up before any page loads: 80 passes
  running. The editor's behaviour was not at fault in the failing runs: the file had arrived.

## Saving a revision no longer holds up editing

- **What was wrong.** Cutting a revision (every build does it, and every save, export and
  restore) held every file of the paper while it read them, so that all are captured at one
  moment. While holding them it also sent each edited file's text to the object store. So for
  as long as the store took, nobody could edit the paper: typing was saved late, and a
  structural edit that waited more than eight seconds was reported as failed.
- **Now.** The text is sent to the store first, holding nothing. The cut then only has to
  send again a file that was edited in the moment between (`putEdited` in
  `packages/server/src/revisions.ts`).
- **A test holds it**, with a store that does not answer until let: an edit made meanwhile
  goes through, and the revision has that edit. With the old code the test never finishes.
- **Still holds files while it talks to the store:** a file edited between the two steps;
  the second half of a restore, which stores what it has just put back; and the first time a
  file is opened for editing, which reads its upload. All short or rare, none removed.

## A PDF that stayed "behind the text", and used up the paper's builds

- **What was wrong.** A build is behind when any file's log of edits has moved past where the
  built revision recorded it. Two things move a log without changing the text:
  - opening a file in the editor for the first time, which writes the upload as the log's
    first entry;
  - typing something and taking it back.
- A build asked for after either found the text the same as the latest revision, and used
  that revision again, with the old places in the logs. So it came back behind too. The pane
  beside the editor builds whenever the PDF is behind and typing has paused, so it asked
  again, about every two seconds. Run against the old code, the browser test below saw five
  more builds of the same revision within fifteen seconds of a second file being opened. It
  was not left running to the end: at that rate the paper's 120 builds for the hour are gone
  in about four minutes, and then nobody can build the paper until the hour is up.
- **Whom it reached.** Anyone who opened a second file of a paper that had already been
  built, with "Compile automatically" on, which it is unless turned off.
- **It also kept a paper from being ready to submit.** The checks before submitting call a
  paper that has changed since its build a problem. Run on the old code: after a second file
  was opened, two more builds each came back behind and the checks still said "The paper has
  changed since it was last built." An edit to the paper got out of it, since that makes a new revision.
- **Now**, in three places:
  - a file's first log entry is not counted as an edit (`COLUMNS` in
    `packages/server/src/builds.ts`);
  - a build of the same text tells the revision where the logs now stand (`cut` in
    `packages/server/src/revisions.ts`). If a file was deleted and made again under its name
    the text is the same but the file is another one, and a new revision is cut;
  - the pane asks once for each state of the paper and revision the newest build is of. A
    build that comes back behind, of the same revision, is not asked for again until
    something changes (`BuildPane.tsx`).
- **Tests hold the first two.** A service test (`builds.sandbox.test`) and a browser test
  (`building.spec`), which opens a second file and sees the PDF stay up to date with no build
  asked for. Both failed on the old code. The part of the service test about a file deleted
  and made again was not run against the old code.
- **How it was found.** By the narrow-window test, when it was made to edit a second file and
  then wait for the PDF. No test had opened a second file and looked at the PDF's state.
- **The opposite fault, found by asking what else the rule missed.** A build said "up to
  date" after three changes that are not typing, and so the pane did not build:
  - a file that is not text replaced whole, as a chart is when it is drawn again;
  - a file deleted;
  - another file made the root.
- **The rule now sees all three**, and a compiler changed by a restore.
  - The mark the pane watches to see that the paper is still (`edits` from `latestBuilds`)
    moved only with typing. It now moves with these too, or the pane's once-for-each-state
    rule would have kept it from building after them.
  - A service test holds the three; it failed on each before. The browser test deletes a
    file in another window and sees the pane build; that step was not run against the old
    code.
- **The pane's rule was wrong when first written**, and is now held by a step of the browser
  test. It asked once for each state of the paper, whatever the newest build was of. But a
  person can build the PDF of an older revision (the paper's page offers it for a revision
  that has none). That is then the newest build, the paper has not changed, and the pane
  would not build it again until something was edited: it went on showing the older
  revision's PDF. The revision is now part of the rule. The step failed on the rule as first
  written.
- **Not held by a test:** that a build coming back behind is asked for only once, since
  after the other changes nothing is known that brings one back behind. If the request for a
  build fails, the pane does not try again by itself; the message and "Compile now" are
  there.

## The PDF beside the text could not be made larger, and a resized window left its words off the picture

- **What was wrong.** Every page was drawn at the width of the pane, one of two columns beside
  the file list: about 500 px at a 1280 px window, so 10 pt text was about 8 px. There was no way
  to enlarge it short of opening the PDF by itself, which loses double-click-to-source and
  "Show in PDF". And when the pane's width changed (a window resized, a panel opened) the
  invisible words stayed at the old size and the picture at its old resolution, so a selection
  or a double-click landed beside the words it was made on. Measured at 1280 then 1600 px: the
  picture stayed 502 px wide in a 662 px page, and a word's share of the page's width fell to
  0.76 of what it was.
- **Now** the pane has "Smaller", "Larger" and "Fit the width" (100%, 125%, 150%, 200%, 300%),
  with the size said beside them. The choice is remembered in the browser. An enlarged page
  scrolls sideways inside the pane, not the window, and the middle of what was being read stays
  in the middle. Whenever the pane's width changes the words are put right at once and the
  pictures of the pages near are drawn again at the new width (`PdfView.tsx`). A picture is
  capped at 12 million pixels.
- **Held by** a browser test (`synctex.spec`): larger, the words still on the picture,
  double-click and "Show in PDF" while larger, a wider window, a reload, back to fit, and the
  accessibility audit. It fails without the change at the first step, and a resize alone,
  tried on the old code, showed the fault above.
- **Not done:** no page-number box, no fit-whole-page, the reading place is not kept when the
  window is resized, a page is softer above 12 million pixels, tried in Chromium only.

## A chart whose files have left the paper

- **What was wrong.** A drawn chart is two files of the paper. If one was deleted by hand, or
  the paper was put back to a revision from before the chart was drawn, the chart still said
  "Drawn" on the paper's page, and its own page showed a picture that was not there.
- **Now** it says its files are no longer in the paper and that drawing it again puts them
  back (`missing` in `listCharts`, `packages/server/src/charts.ts`). Drawing again already
  worked; nothing said to do it.
- **Held by** a service test (`charts.sandbox.test`: a file deleted, and a restore) and a step
  in the browser test (`charts.spec`).
- **Found by** trying the second of things after the build fault: restores and renames done
  twice, a file deleted and made again and then restored both ways, restores across a chart's
  drawing and across a change to its data. Only this turned up.
- **Seen there, and since put right.** After a restore to a revision whose data is older than
  the chart's last drawing, the chart used to say "out of date" although the files that came
  back were of that older data. See "A chart is judged by the files in the paper" below.

## An editor whose sign-in has ended

- **What happened before.** An editor that could not get a ticket because the person was
  signed out (their sign-in ran out, or they signed out in another tab) said "You no longer
  have access to this file, or it has been deleted" and stopped. Anything typed and not yet
  saved stayed in a page that could do nothing with it.
- **Now** it says they are signed out, with a link that opens the sign-in page in a new tab.
  The editor stays open for typing, goes on asking for a ticket, and carries on by itself
  once they have signed in: what was typed meanwhile is saved (`token` in `FileEditor.tsx`).
- **Not as the next person.** The ticket's answer says whom it is for. If someone else has
  signed in on the browser, the page stops instead of carrying on as them. Before this, a
  page that reconnected after another person had signed in did carry on as them; see
  `docs/security-review.md`.
- **Two browser tests hold it** (`recover.spec`). The second fails without the check on whom
  the ticket is for: the first person's typing is saved as the second's.
- **Signing out ends the editors opened under that sign-in, at once.** Before, a page kept
  its connection, and went on saving as its person, until the connection happened to drop.
  - A ticket now names the sign-in it was given under. A trigger on the sign-in library's
    session table (migration 0023) tells the sync server when a session is deleted, and the
    server closes the connections made under it.
  - The same person signed in on another browser is not disturbed: a service test holds that
    (`sync.sandbox.test`). The browser tests above sign out without losing the connection.
  - The library's client goes on calling itself connected after the server has closed its
    file this way. The editor has to drop the connection itself to find out where it stands;
    without that it sat at "All edits saved" while nothing it typed was being taken.
- **A sign-in that runs out** is found by a check every minute and when a connection is made;
  its editors are closed as on sign-out. The sync server neither renews nor deletes sign-ins
  (the table is the auth library's). Within that minute an edit is still taken. Held by two
  service tests (`sync.sandbox.test`).

## Someone taken off the paper while a file is open

- **What was right already.** The editor says "You no longer have access to this file, or it
  has been deleted." and stops taking typing. What was typed before is saved and is the
  owner's to see. Loading the page again gives "not found".
- **What was wrong.** The build pane, the comments and the proposed changes went on asking the
  server every two and five seconds for as long as the page stayed open, and were told "not
  found" each time: five requests in six seconds, without end.
- **Now** each asks once more, is told "not found", and stops (`notTheirs` and `STOP` in
  `apps/web/lib/shown.ts`). A signed-out page is not stopped: it carries on once its person
  signs in again, as it did before.
- **Held by** a browser test (`recover.spec`: "someone taken off the paper while a file is
  open"), which failed on the old code.

## A file too changed to compare

- **What was wrong.** Comparing two revisions shows each changed file line by line, up to a
  limit (about 2,000 changed lines on each side). Past it, and for files that are not text,
  the page said "This file changed, but it is not text that can be shown line by line." For
  a large `.tex` file that is untrue, and reads as if the file had been spoiled.
- **Now** the comparison says which it is (`tooLarge` on `FileDiff`, in `diffRevisions`), and
  the page says "Too much of this file changed to show it line by line here", with links to
  download the ZIP of each of the two revisions. Files that are not text keep the old
  sentence.
- **Held by** a service test (`revisions.sandbox.test`: "a text file that changed too much to
  compare line by line is marked too large"), which failed on the old code. The page's new
  sentence was not looked at in a browser; the suite passes with it.
- **Not changed:** the limit itself, and the `shortcut:` note in `textdiff.ts` about how the
  comparison is done.
- **How it was made.** Planned by one agent from reading the code, written by another, and
  checked here: the test run on the old code and the new, and the whole suites.

## What the browser keeps of a paper

- **What was wrong.** A paper's PDF and the like were kept by the browser to be used unasked
  for an hour. After "Sign out", asking for one again at its address gave the browser's own
  copy, with the server never asked. Seen with a probe: the PDF came back whole after
  signing out, while the server itself answered that nobody was signed in. The same would
  go for a sign-in that had run out, and for someone taken off the paper.
- **Now, two things.**
  - The browser keeps these answers and asks before each use; the server says who may have
    them, and says "as you have it" without sending them again (`askedForEachTime` in
    `apps/web/lib/server.ts`, on a build's PDF, log, label numbers and places, a revision's
    PDF, pictures and chart pictures).
  - Signing out tells the browser to forget what it has kept of the site.
- **What it costs.** One short request each time a kept answer is used, where there was
  none within the hour. The server reads the file again to answer it, though it does not
  send it. A picture no longer comes over the wire again each minute.
- **Held by** a browser test (`recover.spec`: "what the browser kept of a paper is not handed
  to whoever uses it after a sign-out"), which failed on the code before each change.
- **Found by** reading how each route tells browsers to keep its answers, after measuring
  what a file of many figures fetched.

## Someone whose role changes while a file is open

- **What was wrong.** The editor's page is made for the role its person had when it loaded.
  The sync server stopped taking a lowered person's edits at once, but nothing told the
  page. Seen on the code before: an editor made a viewer still had an editor that took
  typing, and twelve seconds after typing it still said "Saving your edits…".
- **Now** the sync server tells each editor its person's role when it connects and whenever
  it changes (`tellRole` in `apps/sync/src/server.ts`).
  - Lowered so that they can no longer edit: the editor stops taking typing and says so. If
    something typed had not been saved (typed offline, say), it says that too.
  - Given back the role the page was made for: it carries on.
  - Any other change, such as a viewer made an editor: it says to load the page again, with
    a button. The page cannot offer what it was not made with.
- **Held by** a service test (told on connecting and on change) and a browser test
  (`recover.spec`: lowered, given back, lowered while offline with something typed, raised).
- **Not covered:** the panels beside the editor (comments, proposed changes) are also made
  for the role at load. Their requests are refused by the server with a message; the status
  line is what says why.

## A paper's page with a long history

- **What was wrong.** Every build of changed text cuts a revision, up to 120 an hour, and the
  paper's page listed every one of them, each with its buttons. Measured in a browser: 1.6 MB
  and 0.9 s with 500 revisions; 15.8 MB and 8.4 s with 5,000.
- **Now** the page lists every revision that a person named or that was a restore, and the
  newest fifty made automatically, with a link to the fifty before those and so on
  (`listRevisions` with `autos` and `before`). With 5,000 revisions: 183 KB and a quarter of a
  second.
- **Held by** a service test of the list, and two rows in `docs/benchmarks.md` for a paper
  with 5,000 revisions and 10,000 builds. The link to older revisions was followed once in a
  browser by hand; no browser test is kept for it, since making thousands of revisions from a
  browser test means writing to the database from it.
- **"Changes since"** on a row compares with the row below it. With the list thinned, that
  may be an older revision than the one just before. It says which.

## A file's comments on a paper with many people

- **What was wrong.** Every open thread on a file carries a form for replying, and each form
  listed everyone on the paper who could be mentioned, a box apiece. So the page drew a box for each person under each thread, and typing into the text slowed as they grew: the editor draws its panels again as its saving status changes, which is at every key.
  Measured in a browser, on one machine, once each. The last column is the browser's own
  count of the time from a key going down to the screen showing it:

  | People | Threads | Boxes  | Elements on the page | A key typed, median    |
  | ------ | ------- | ------ | -------------------- | ---------------------- |
  | 1      | 1       | 0      | 174                  | 16 ms or less          |
  | 30     | 100     | 2,900  | 7,758                | 32 ms                  |
  | 200    | 400     | 79,600 | 166,558              | 1.4 s (2.0 s at worst) |

- **Now** a form lists who can be mentioned once someone starts on it: when the keyboard
  first goes into it (`Say` in `Threads.tsx`). The same three papers after the change: 16 ms
  or less, 16 ms, and 24 ms a key (40 ms at worst); 1,758 elements for the middle one and
  about 6,500 for the largest.
- **How the times were taken.** At first with the test's clock around each key: 17 ms, 49 ms
  and 1.8 s before the change, and 17, 17 and 34 ms after. Those went into the pull request
  that made the change. They were taken again with the browser's event timing after another
  figure in these notes turned out to be the test's own work (the large .bib file, below),
  with the old behaviour put back for the purpose. The table has the second set. The first
  was a little high and told the same story.
- **Held by** a step in the thread test: no boxes under a thread until its reply is begun,
  and then the people. It failed on the old code. The measurements came from a probe that
  wrote people and threads straight into the database; it is not kept.
- **Not changed:** the comments still draw every thread again at each key typed, which is
  the 16 ms that became 24 with 400 of them. The list is asked for again every five seconds
  whether or not anything changed (273 KB for 400 threads).
- **The paper's own page with 200 people** was looked at in the same probe: 804 KB, 405
  forms, and there within a third of a second by the test's clock, which can only overstate
  it. Slow to no one, and larger than it need be. Not changed.

## A reply being written when the thread is resolved

- **What was wrong.** A file's comments and proposed changes are read again every five
  seconds. If someone resolved a thread while another person was part-way through a reply to
  it, the thread moved among the resolved ones at that person's next reading and its form
  went, with what they had written. Nothing said so. The same for a proposal that its owner
  accepted, rejected or withdrew while someone was changing it: the form started again from
  the old words, folded out of sight.
- **Now** the thread or proposal stays where it was for the person writing, and says what
  happened (`held` in `Threads.tsx` and in `Proposals.tsx`).
  - A reply can still be sent to a resolved thread; the server always took one. Once sent, or
    rubbed out, the thread goes where resolved threads go.
  - A decided proposal can no longer be changed, and the server refuses. The words written
    stay in the form to be copied, until the form is put away.
- **Held by** a step in each of the thread and proposal browser tests. Both failed on the old
  code.
- **Already right:** a table cell being edited when someone else changes the table says
  "Your text was not put in:" and gives the text back (`tables.spec`).
- **Also right:** someone made a viewer while writing a comment. Tried once with a probe: the form stayed with its words, and sending it said "A viewer cannot do that."

## A file that could not be replaced by a newer copy

- **What was wrong.** Uploading `results.csv` again said "Another file already has that name."
  The only way round was to delete the file and upload it again, which makes a new file ID. The
  dataset's description and every chart are tied to the old ID, so the chart was dead for good
  (no data path, no described dataset, redraw `not_found`, and its name could not be used again).
  The same for a regenerated figure or a re-exported `refs.bib`.
- **Now** an upload can carry "Replace the file of this name" (a checkbox on the upload form,
  `replace` in the post and for a file sent by way of the store). `replaceFile` in `files.ts`
  puts the new bytes in the place of the file at that path and keeps its ID. The paper is cut as
  a revision first, in the same transaction, so the old content is always kept. Text that has
  been opened is changed by the same edits a restore makes, through the edit lock, so connected
  editors see it at once; its newline style and byte order mark are taken from the upload. Other
  files (pictures, PDFs, text never opened) get the new digest, size and kind, and the paper's
  manifest version moves on. A path with no file is added as a new one; a folder at the path, a
  reviewer's or viewer's upload, and editable text replaced by bytes that are not text (which
  would silently make it read-only) are refused. The clash message now says how to replace.
- **What follows.** The dataset says it has changed since it was looked at, and the chart says
  "Out of date: its data has changed"; looking at the data again and drawing the chart again
  gives a fresh chart from the new file.
- **Held by** service tests (`files.sandbox.test`, `charts.sandbox.test` in the workers) and a
  browser test in `charts.spec`.
- **Risks.** Someone typing while a file is replaced is merged in as they would be by a restore:
  their words in untouched lines stay, in changed lines they are lost to the new text (they are
  in the revision). A paper already stranded is not repaired: restoring the revision from before
  the delete brings the old file, and its ID, back.

## A file that said "0 B"

- **What was wrong.** The paper's page lists each file with its size, and the size was the
  one the file was added with. A file started blank and written in the editor said "0 B" for
  good; an imported one said what it was on the day it came. Seen while trying odd names for
  papers and files, which themselves went through everything tried (below).
- **Now** a revision, which works out every edited file's bytes anyway, records how many
  there were (`cut` in `packages/server/src/revisions.ts`). Every build cuts a revision, so
  the page is right as of the last build or save. Text typed since then is not counted until
  the next one.
- **Held by** a service test (`revisions.sandbox.test`: "a file says how large it is now")
  and a line in the browser test that starts a paper from nothing. The service test failed
  on the old code.
- **What a paper may hold** (300 MB) is counted from the same sizes, so it now follows what
  the files have become and not only what they were added as.
- **Odd names, tried once with a probe and not kept:** a paper named with angle brackets,
  quotes, an ampersand, Japanese, an emoji, `%41` and 180 more characters; a file named
  `sec tions/é ü's "x" & 日本 #1 %20.tex`. Created, opened, typed into, built, listed and
  downloaded: the names came back as given, and the ZIP's own name had only plain characters.

## A paper with a large .bib file

People keep one .bib file for all their papers. Two thousand entries is ordinary, and this
paper cites a few dozen of them.

- **What was wrong, in two places.**
  - The paper's page listed every entry in the .bib files, each row with its forms. Measured
    in a browser with a paper that cites one entry: 5.9 MB and 2,012 forms for 2,000 entries,
    loaded in 1.9 s; 22.8 MB and 8,012 forms for 8,000, loaded in 12.1 s.
  - The server found each entry's line by reading the file from its top, once for each
    entry. With 8,000 entries that was 7 s (most of the 12.1), on the paper's page and again
    each time an editor opened.
- **Now**
  - The table lists the entries the paper cites, with `\nocite` counted, and any entry that
    has a check recorded. It says how many more the files hold, with a link that lists them
    too (`?entries=all`). `citationReport` says of each entry whether it is cited.
  - A file's lines are found once (`lineNumbers` in `packages/server/src/labels.ts`), for
    citations and for labels alike.
  - The same papers afterwards: 254 KB and 13 forms at either size, loaded in 0.4 s with
    8,000 entries, and the bibliography read in 0.11 s.
- **A figure that was wrong, and is not above.** This section first said a file took 15.6 s
  to open from the old page, and with 8,000 entries did not open in two minutes. That was
  the test's own looking at a very large page, timed along with the page. Clicked and timed
  from inside the page, a file opened from the full list in 0.5 s (2,000 entries) and 2.4 s
  (8,000), and from the short list in 0.4 s. The sizes and times above were all taken
  inside the page or on the server, and stand. The same mistake was made once before (the
  editor "taking 28 s to open", below); see "For next time".
- **Held by** a service test (which entries count as cited: not one named only in a file
  the paper leaves out), the citations browser test (an entry never cited is counted, not
  listed, and listed when asked for), a unit test of the line numbers against counting from
  the top, and a row in `docs/benchmarks.md` whose ceiling the old code passed twice over.
- **Not changed:** the window for choosing a citation lists every entry, cited or not, as it
  should. With 8,000 it was open within a second and each letter typed took 0.1 s to 0.3 s;
  those times include the test's own looking, so they are the most it could be. A paper that
  itself cites thousands of entries would have the large page back.
- **The files table is the same shape and was left alone.** Each file's row has two or three
  forms. Measured the same way: 81 KB for 20 files, 942 KB and 754 forms for 300, and 6.2 MB
  and 5,004 forms for 2,000, which is as many as a paper may hold. That last page loaded in
  2.4 s and a file opened from it in 1.9 s, timed inside the page.
- **Found by** giving a paper many of something in the browser, as with the comments above.

## A file with many figures

- **What happened.** The visual view fetched every figure's picture as soon as the file
  opened. A file with sixty figures of 200 KB each made sixty requests for 11.9 MB before
  its first page had been read, and again a minute later if opened again (a picture is kept
  by the browser for sixty seconds). Counted with the page's own record of what it fetched.
- **Now** a picture is fetched when it is scrolled near (`loading = 'lazy'` on the picture,
  in `apps/web/lib/visual.ts`). The same file fetched twenty pictures, 4 MB, on opening:
  twenty and not three because a picture not yet fetched takes no room, so more of them
  count as near. Scrolled to the end, the last picture was there, and all sixty after
  going through the file.
- **Held by** one line in the figures browser test, which reads the setting. Nothing kept
  counts the requests.
- **Not changed:** pictures are still fetched whole and at full size, and still kept for a
  minute only.

## Pages fetched before anyone asked for them

- **What was wrong.** The framework fetches the page behind every link in view unless the
  link says not to, and for these pages a fetch draws the whole page on the server. Looking
  at the page of a two-file paper set off sixteen such requests: the editor for each file,
  the checks before submitting, the list of papers, each more than once. Each reads every
  LaTeX file of the paper. Nothing was shown slower for it on a small paper; the server did
  many times the work the person asked for.
- **Now** every link says not to (`prefetch={false}`), and the browser tests fail if any page
  is fetched ahead (`refusals` in `tests/e2e/helpers.ts`). Taking the instruction off one
  link fails a test.
- **Files are read sixteen at a time**, not one after another, wherever a page needs all the
  paper's LaTeX files: labels, citations, macros, the checks (`texFiles` in
  `packages/server/src/labels.ts`). For a paper of 2,000 files that is 4.1 s down to between 1.0 and 1.3 s
  over two runs (`docs/benchmarks.md`), and in a browser the paper's page went from 7.2 s to 4.0 s; with
  300 files, from 1.4 s to 0.8 s.
- **The question every open editor asks every two seconds**, how the paper's builds stand,
  looked the newest build up twice whenever it was also the newest with a PDF, which is
  nearly always. Once now: 113 ms down to 58 ms for a paper of 2,000 files, 10 ms to 6 ms
  for a small paper with 10,000 builds (`docs/benchmarks.md`).
- **A build that is not being built says so.** With the build worker stopped, or far behind,
  a build stays waiting and the pane said "Compiling…" for as long as it did. After two
  minutes it now says the build is still waiting and that the build service may be busy or
  not running. (A build takes a minute at most once started.) A browser test holds it by
  answering the pane as the server would with the worker stopped; the worker itself was not
  stopped.
- **A chart that is not being drawn says so too.** Its page loaded itself again every two
  seconds for as long as the chart waited. After two minutes it now stops, and says the
  service that draws charts may be busy or not running. A chart says since when it has been
  waiting (`waitingSince`, held by a service test). The page was checked once by hand: a
  chart put back to waiting as if asked for five minutes ago, and held so that the worker
  passed it by, showed the message and loaded once in six seconds. No test is kept for it.
- **The page of checks before submitting stops too.** It loaded itself again every two
  seconds while a build was waiting, and each load runs every check. After two minutes it
  says the build has been waiting and stops (`BUILD_STUCK_MS` in
  `packages/server/src/submit.ts`). A service test holds it.
- **An editor nobody is looking at asks for nothing.** Each open editor asked how the builds
  stood every two seconds, and for the threads and the proposals every five, for as long as
  its tab was open, in front or not. They now wait while the tab is hidden and ask at once
  when it is shown again (`whileShown` in `apps/web/lib/shown.ts`). A browser test holds it.
  The connection to the sync server is not affected: someone else's typing still arrives in
  a hidden tab.
- **A measurement that misled for a while.** Clicking through to the editor of a 2,000-file
  paper took 28 s in a browser test. A profile showed the time was the test's own search for
  the link by its name among thousands. Opened directly, that editor shows in 1.6 s.
- **Still slow:** the page of a paper with 2,000 files is 7 MB and takes 4 s, because it
  lists every file with its buttons. Papers that size are rare (the limit is 2,000) and the
  list was left as it is.

## What the browser tests now refuse

Every browser test fails if a page it opens does any of these (`refusals` in
`tests/e2e/helpers.ts`):

- is refused something by its own content policy;
- fetches another page before anyone asks for it;
- throws something nobody catches;
- says in its console that something is wrong with it. A request that failed says so there
  too, and tests make requests fail on purpose, so those are left alone.

The last two were added by first only collecting what the whole suite said. Nothing was
thrown uncaught anywhere. One thing was wrong: the field for a new chart's name had a pattern
that current browsers cannot read (a bare hyphen inside brackets), so they ignored it and any
name was sent to the server, which refused it with a message. The pattern is fixed and a step
of `charts.spec` holds that a bad name is caught in the form.

One warning is refused as well, found the same way: the visual editor's library saying a
caret had been put where no text can go.

- **What was wrong.** After an equation or a figure is inserted on a line of its own, the
  caret was put "just after it", which is between two blocks. No text can go there. The caret
  was not drawn, and what was typed next landed before the equation, not after.
- **Now** the caret takes the nearest place after that can take text, or failing that the
  nearest before (`selectAt` in `apps/web/lib/visual.ts`). In the middle of a paragraph that
  is the rest of the paragraph, so typing carries on after the equation. At the end of a
  paragraph it is the start of the next one: there is no place for text between the equation
  and the blank line, short of starting a new paragraph for the person.
- **Held by** a test in `insert.spec` that reads the source afterwards: an equation in the
  middle of a paragraph, one at the end of a paragraph, and a table that ends up last in the
  paper, where the caret has to go back before it.

## A button pressed twice

(Before the page's script has started: see "Before the page's script has started".)

Tried on the paper's page: "Delete", "Save revision" and "Send invitation", each pressed
twice quickly.

- **Delete:** the file is deleted once and the page says so.
- **Save revision:** two revisions of the same paper under the same name were made. Now a
  save under the name the paper was just saved under, with nothing changed, is that revision
  again (`cut` in `packages/server/src/revisions.ts`). A different name, or a changed paper,
  still makes a new one.
- **Restore** (tried on the server, not in a browser): two restores of the same revision
  made two revisions; now the second is the first again.
- **Send invitation:** two invitations and two emails. That is left as it is, since sending
  one again is something people do, but it is what showed that invitations had no limit: see
  "How often the expensive things can be asked for".

Tried later on the other pages, each button pressed twice two ways: both presses in one
moment, and the second 300 ms after the first. Measured with a probe, counted in the database:

| Button                                   | Both at once                                                       | 300 ms apart                    |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------- |
| Create paper (blank, or from a template) | two papers of the same name                                        | one                             |
| Import ZIP (300 files)                   | one                                                                | two papers of the same name     |
| Add file                                 | one                                                                | one (the page had left already) |
| Join this paper                          | one                                                                | one                             |
| Remove a member                          | removed, then "That person is the owner or is not in the project." | fine                            |
| Propose a change, Start thread           | two of each                                                        | one                             |

Where two were made, the page ended on the paper as usual, so nobody would know of the
second one.

- **Now** those buttons send their form once per press: `Once` in `apps/web/app/Once.tsx`, on
  Create paper, Import ZIP, Add file and Remove/Leave. It drops a second send at the moment the
  form is sent, rather than after the page draws again, which is too late (the probe showed
  it). It is free again when a server action answers, an error included, and when the page
  is come back to with the back button. Propose and Start thread keep the same in a ref in
  `Change` and `Say`, beside their `busy` state, which was what came too late.
- **Held by** `projects.spec` ("a button pressed twice does its work once": Create paper,
  Import ZIP, Remove, and a press stopped by an empty name not leaving the button dead) and a
  step in `threads.spec`. Each of the four checks failed on the old code; Remove had to be
  reached by hand, as the earlier failures stop the test before it.
- **Not changed:** two requests sent without the page still make two; the server does not
  know them apart from two meant presses. Send invitation as above. Propose has no kept test.
- **How it was made.** Planned by one agent, written by another, checked here.
- Going back and forward: see the next section.

## A page come back to

- **What was tried**, with a probe: eight cases of a person pressing Back, and Forward, after
  doing something. Nothing was made twice: a saved revision, a new paper and an imported ZIP
  each stayed one, since every form answers with a redirect. The editor came back live after
  Forward, with what was typed.
- **What was wrong.** The browser's router showed the page it had kept, without asking the
  server. On the paper's page after Back: a comment thread started meanwhile was missing; a
  file deleted meanwhile was still listed, with its Delete button; a member removed meanwhile
  was still listed, and pressing Remove on that row ended on "That person is the owner or is
  not in the project."; and a member just made a viewer was still told "You are an editor",
  with the editing buttons, each of which the server refused.
- **Now** a page come back to is asked for again (`Fresh` in `apps/web/app/Fresh.tsx`, in the
  root layout). The probe again: the thread is listed, the deleted file and the removed member
  are gone, the viewer is told so. Not on a file's editor page, which keeps words not yet saved
  and is kept current by the sync server, and not when the browser says it is offline.
- **A fault the fix brought, and how it was put right.** Asked for again, the layout carries a
  new number for the page's scripts and style sheets, while the page keeps the policy it was
  loaded with. An editor opened afterwards took the new number and its style sheets were
  refused. The page's number is now read once, as the page's scripts start
  (`pageNonce` in `apps/web/lib/nonce.ts`, imported by `Fresh` so that it is read on every
  page). Sending a form does not change the number (checked); only this asking again did.
- **Held by** a browser test (`files.spec`: "a page come back to says what is so now"): the
  thread listed and the deleted file gone after Back, which both failed on the old code; the
  editor keeping words typed offline across Back and Forward; and an editor opened for the
  first time after Back, which fails with the content-policy refusal if the early read is
  taken out.
- **Not changed:** a page left open without navigating still shows what it showed, a role
  included (only the editor's panels ask again). The offline check knows only the network
  interface: with the server down, asking again fails and the browser loads the page afresh,
  which on these pages loses nothing. After Back and Forward the editor opens in the view last
  chosen (see "The view a file opens in").
- **How it was made.** Planned and its fault judged by one agent, written by another, checked
  here.

## Something pasted into the visual view

- **What was tried**, with a probe: ten kinds of paste into running text in the visual view,
  each as the browser hands it over (plain text, and the HTML a web page or Word puts beside
  it), then the source read and, for three, the paper built.

| Pasted                                      | Before                        | Now                  |
| ------------------------------------------- | ----------------------------- | -------------------- |
| One plain sentence                          | its words                     | the same             |
| `50% of R&D cost $5 for item_1 #2`          | escaped, as typed; built      | the same             |
| Two paragraphs                              | **nothing, and no word said** | two paragraphs       |
| Bold, italic and a link from a web page     | the words, without formatting | the same             |
| A list (`<ul>`)                             | **nothing, and no word said** | `a b`                |
| A table                                     | **`1234`**                    | `1 2 3 4`            |
| A paragraph from Word                       | the words                     | the same             |
| `\section{Pasted} and \cite{x}`             | escaped, as typed; built      | the same             |
| A picture alone                             | **nothing, and no word said** | said it cannot go in |
| Into a table cell or a caption being edited | see below                     | not changed          |

- **What was wrong.** The paste was left to the editor's own handling. Whatever made a new
  paragraph or a list item never reached the source, and the view showed nothing of it; a
  table's cells were joined with nothing between them.
- **Now** the visual view pastes the plain text and nothing else (`handlePaste` in
  `apps/web/lib/visual.ts`). A blank line starts a new paragraph; a single line break or a
  tab is a space. One paragraph goes in as typing does. Several go in as one edit through the
  server, as an inserted formula does, escaped by the same rule as typing (`escape` in
  `packages/bridge/src/translate.ts`). Several paragraphs over a selection, or where the caret
  is not in running text, are refused with a sentence that says what to do. A picture is
  refused with a sentence saying where pictures are added.
- **Held by** a browser test (`visual.spec`: "something pasted into the visual view goes in
  as its words"): two paragraphs, a list, a table, a picture, and the escaping of one
  paragraph and of several. It failed on the old code at the first step.
- **Into a table cell or a caption.** The probe's paste left the field unchanged, which is how
  a paste made by a script behaves in a text field, not a fault found. A warning in the
  browser's console after pressing Enter there was looked for again, by opening a cell and a
  caption and pressing Enter without a change, then typing: it did not come back. Not changed.
- **Not changed:** formatting is not carried over (bold, italic, links, lists, tables); the
  words come in and the LaTeX for the rest is written in the source. A picture is not added
  to the paper by pasting. The source view pastes as before, exactly what was copied.
- **How it was made.** Probed and planned by one agent, written by another, checked here.

## Something dropped onto a page

- **What was tried**, with a probe: a picture, a `.bib` file, and text dropped onto the visual
  view, the source view, the paper's page, the list of papers, the editor's other panes, the
  field for choosing a file, and a table cell being edited. A test cannot make a real drag
  from the desktop, and a drop made by a script never opens anything; what decides whether
  the browser opens a dropped file in place of the page is whether the page cancels the drop,
  and that is what was read.

| Dropped                | Onto                                 | Before                                  | Now                   |
| ---------------------- | ------------------------------------ | --------------------------------------- | --------------------- |
| A picture, or a `.bib` | the visual view                      | **left to the browser**, no word        | refused, and said     |
| A picture              | the source view                      | refused without a word                  | refused, and said     |
| A `.bib`               | the source view                      | **its text put into the file, no word** | refused, and said     |
| A picture              | the paper's page, the list of papers | **left to the browser**                 | refused               |
| A picture              | the editor's PDF and comment panes   | **left to the browser**                 | refused               |
| A picture              | a table cell being edited            | **left to the browser**                 | refused               |
| A picture              | the field for choosing a file        | taken by the field                      | the same              |
| Two paragraphs; a list | the visual view                      | **refused** as an edit across LaTeX     | put in as for a paste |
| `50% of R&D`           | the visual view                      | escaped, as typed                       | the same              |

- **What was wrong.** No page said what to do with a dropped file, so the browser did its
  own thing: open the file in the tab, the paper's page or the editor gone. Text dropped on
  the visual view took the editor's own way in, which could not write paragraphs or a list.
- **Now** a file dropped anywhere but on a field for choosing one is refused (`DROPPED`, a
  script run as the page is read, first in the body of `apps/web/app/layout.tsx`); the visual and source views say where
  files are added. Text dropped on the visual view goes in where it was dropped, by the same
  rule as a paste (`take` and `handleDrop` in `apps/web/lib/visual.ts`). Text dropped on the
  source view goes in as before.
- **A caret that was not drawn**, found while looking at this. With the caret where the visual
  view has no text (after `\end{document}`, on `\begin{document}`, in a formula or a table's
  source), switching to the visual view put the caret there anyway, not drawn, with a warning
  from the editor's library. All five places warned; none does now: the switch takes the
  nearest place that holds text, as clicking does (`select` in `visual.ts`).
- **Held by** browser tests: `visual.spec` "something dropped on the visual view goes in as
  its words, and the source view takes no file" (a picture, two paragraphs, a list, escaping,
  a `.bib` on the source); `visual.spec` "a caret at the end of the source is kept in the
  visual view"; and `files.spec`, a picture dropped on the paper's page, and the field for
  choosing a file still taking one. Each failed on the old code, with its part of the fix
  taken out.
- **Not changed:** a dropped file is refused, not added to the paper; adding it would be a
  new feature. A word dragged within the visual view was tried with the mouse and nothing
  changed, but whether the browser began a drag at all was not seen.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## Before the page's script has started

- **What was tried.** The page's scripts held back (`scriptsHeld` in `tests/e2e/helpers.ts`
  holds every `/_next/static/*.js` request until told to go; the page is gone to with
  `waitUntil: 'domcontentloaded'`), and then each thing below done as a person would, with
  the scripts let through afterwards where that mattered. A production build, one machine.

| Before                                                                                   | Now                                                                                                            |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A file dropped on a page opened in its place (the handler was put on in `useEffect`)     | refused from the first byte: an inline script with the request's nonce                                         |
| Sign-in: Enter or the button sent a plain GET to `/sign-in?email=...`; no link sent      | the button is disabled until the script has started, so Enter does nothing                                     |
| Sign-in: the field was controlled, so text typed or filled early might not be sent       | the form reads the field itself (`FormData`) and sends that                                                    |
| Two presses 50 ms apart of Create paper made two papers (`Once` attaches in `useEffect`) | a form the browser posts itself is posted once: `SENT`, an inline script beside `DROPPED`, for every POST form |

- **Probe**, scripts held, one run each:

| Tried                                | What happened                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Create paper, pressed once           | Works: posted natively, the paper's page comes back. One paper.                                |
| Create paper, two clicks in one task | One paper (the browser drops the first post).                                                  |
| Create paper, two clicks 50 ms apart | One paper now (two, with the same name, before `SENT`).                                        |
| Add file, a small file               | Works: "Added early.tex."                                                                      |
| Add file, 4.6 MB `.tex`              | Posted whole and accepted. Locally nothing refuses it; a function on Vercel would at 4.5 MB.   |
| Sign out                             | Does nothing until the script has started; works after.                                        |
| A link to a file                     | Works (a plain link).                                                                          |
| Typing where the editor will be      | Nothing takes the keys (no editor yet, nothing in the page); they are not in the editor after. |
| Rename a file (open the row, Rename) | Works: the confirming page comes.                                                              |
| Join a paper from an invitation      | Works.                                                                                         |

- **Found, not changed:** typed keys before the editor exists are lost, but there was nothing
  yet to type into.
- **Held by** browser tests: `projects.spec` "the sign-in form works for someone quicker than
  the page's script" and `files.spec` "a file dropped before the page's script has started is
  not opened in its place". Each failed on the old code. `files.spec` slowed four times: 50 of
  50 pass (10 of each test), with the plain `expect` back in "a paper is started from nothing".
  `projects.spec` "a button pressed twice before the page's script has started does its work
  once" (Create paper, 50 ms apart, the answer held 300 ms): failed on the old code, 10 of 10,
  with two posts; passes 10 of 10 now.
- **How `SENT` works.** Before hydration a server-action form is a plain POST form; after it,
  React always calls `preventDefault` on its submit. A submit that reaches `window` unprevented
  is the browser posting the form itself, and the form is remembered; its next submit is
  prevented and stopped in the capture phase, before React or `Once` hear it. Only a
  back/forward-cache restore (`pageshow` with `persisted`) forgets them. `Once` is unchanged.
  Every form that can be posted this way (`DirectUpload`'s small-file path, Add file, Import
  ZIP, the server-action forms before hydration) is answered by a redirect or a page, so the
  page is replaced; the downloads (`/export`, the build PDF and log) are links, not forms,
  and none posts to a new tab.
- **Not changed:** only the pages made by `person` are slowed (`E2E_CPU_THROTTLE`); a second
  page a test opens itself runs at full speed.
- **Not changed:** a press that is stopped (the browser's Stop, or a post that never answers)
  leaves that form unusable until the page is reloaded, as `Once` already does for Import ZIP
  and Add file. With no script at all there is no guard. Two requests sent without the page
  still make two. A first press before the script starts and a second after is covered by the
  capture listener and has no test of its own.

## The view a file opens in

- **What was wrong.** A .tex file always opened in the visual view. Someone who works in the
  source chose it again for every file opened, every reload, and every Back and Forward.
- **Now** the view last chosen with the View buttons is kept in the browser, and a file opens
  in it (`chosenView` and `rememberView` in `FileEditor.tsx`, key `paperweave.view`). It is
  read after the page is first drawn, since the server draws the page without knowing it: the
  visual view may show for a moment first. A switch the page makes itself ("Edit in source"
  on a block, a jump to a line) is not kept. A file with no visual view opens in the source as
  before and leaves the choice as it was. It holds no text of any paper.
- **Held by** a browser test (`editing.spec`: "a file opens in the view its person last
  chose"): the source kept across a reload and onto another file, which failed on the old code
  at the reload; the visual view kept likewise; a switch made by "Edit in source" not kept; a
  `.bib` file leaving the choice alone; and someone else's browser starting in the visual view.
- **Tests changed.** Two tests used two tabs of one browser, one of which chose the source,
  and then expected the other to open a file in the visual view: `maths.spec` ("a formula is
  edited in place…") and `tables.spec` ("a table cell and a caption…"). Each now chooses the
  visual view where it needs it (`showVisual` in `tests/e2e/helpers.ts`).
- **Not changed:** the choice is the browser's, not the person's: shared by everyone who signs
  in on that browser, and not carried to another. With the browser's storage shut, nothing is
  kept and files open in the visual view. A jump to a line (`?line=`) in a file opened in the
  source has no test of its own.
- **How it was made.** Planned by one agent, written by another, checked here.

## At each limit, and one past it

- **What was tried**, with a probe: every limit the app states, one under it, exactly at it,
  and one over, through the pages a person uses (with a field's own length limit taken off in
  the browser for "one over"). Files were read back through the app and compared byte for
  byte.

| Limit                                         | At it                        | One over                                 |
| --------------------------------------------- | ---------------------------- | ---------------------------------------- |
| A file added on the paper's page, 50 MB       | **refused above 10 MB**      | **refused with the wrong sentence**      |
| A ZIP imported, 100 MB; a file in it, 50 MB   | imported whole (95 MB)       | refused, the file named                  |
| Files in a paper, 2,000 (ZIP, and by hand)    | taken                        | refused                                  |
| Paper name, revision name, 200                | saved (also 100 emoji)       | refused                                  |
| File path, on adding and renaming, 255        | saved                        | refused                                  |
| A claim checked, its note, 2,000              | saved, line breaks included  | refused                                  |
| Where a dataset came from, 2,000              | **refused with line breaks** | refused                                  |
| Chart title 120, caption 500, description 300 | saved                        | **caption, description: wrong sentence** |
| A comment, 5,000; mentions, 20                | saved                        | refused beside the field, text kept      |
| A proposed change 20,000, its reason 1,000    | saved                        | refused beside the field, text kept      |

- **What was wrong.**
  - **A file over 10 MB could not be added.** The upload passed through the proxy that sets
    each page's script policy, and the framework keeps only the first 10 MB of what passes
    through it. The rest was dropped, the form arrived without its name or its file, and the
    person read "Give the file a name, or choose a file to upload." Nothing was stored, cut
    short or otherwise. ZIP import never passed through the proxy and was not affected.
  - **Line breaks counted twice.** A browser counts a line break as one character in a field
    and sends it as two, so a note on where a dataset came from was refused at a length its
    field had allowed. The claim was not affected: it is stored as one line.
  - **Two sentences for one check.** A caption or a description one character too long was
    told it held the wrong characters.
- **Now** an upload does not pass through the proxy (`apps/web/proxy.ts`): the route draws no
  page and needs no script policy. A file of exactly 50 MB is added whole; one byte more is
  told "That file is too large." Line breaks sent by a form are read as one character
  (`text` in `apps/web/app/projects/actions.ts`). A caption or description too long is told
  so (`saveChart` in `packages/server/src/charts.ts`).
- **Held by** browser tests, each failed on the old code: `files.spec` "a file larger than the
  proxy keeps can be added" (11 MB, read back byte for byte from the export); `data.spec`, a
  note of 2,000 characters with ten line breaks approved and read back; `charts.spec`, a
  caption and a description one over, each told it is too long.
- **Not changed:** after a refusal, a form sent to the server comes back empty, as before; the
  comment and proposal forms keep what was typed. The hourly limits are held by their own
  tests ("How often the expensive things can be asked for"). A 49 MB file was added by the
  probe, not by a kept test.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## From far away

- **What was tried**, with a probe: every message between the browser and the sync server
  held back one second each way, as on a slow line far from the server (a delay of the
  browser's own frames, on one machine, not a real network); and once ten seconds, past the
  editor's limit. In each case the person did something, then at once clicked elsewhere and
  went on typing, or waited.

| Done over the slow line                                          | Before                                                                         | Now                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| A citation, reference or formula inserted, then typing elsewhere | **the rest of the typing pulled back beside the insertion**                    | typing stays where it was put     |
| Two paragraphs pasted, then typing elsewhere                     | the same, less often                                                           | the same as above                 |
| A table cell or caption changed, then typing elsewhere           | **letters lost, and a full stop of the person's own deleted**                  | typing kept, the full stop too    |
| An edit whose answer takes ten seconds                           | **"could not be made" said of an edit that was made; tried again, made twice** | "Still trying", then "made", once |
| Typing steadily, in either view                                  | in order                                                                       | the same                          |
| A proposal accepted, then typing at once                         | both kept                                                                      | the same                          |
| A comment posted, then another thread shown                      | both                                                                           | the same                          |
| Compile asked for                                                | waiting, then up to date                                                       | the same                          |
| Typing while the file is opening                                 | not taken; the status says "Opening…"                                          | the same, by design               |

- **What was wrong.**
  - **The caret put back.** Once an insertion's answer came, the editor put the caret just
    after it, wherever the person had gone since.
  - **A character taken.** A table cell or caption, once changed, selected its table again
    at the place it had been when the field was opened. Text typed above it since had moved
    the table on, so that place was now a character of the person's own, which the next key
    replaced; and the keyboard was taken back from where they were typing.
  - **Failed, then made.** After eight seconds without an answer the editor gave up and said
    the edit could not be made. The edit was still on its way; the server made it, and a
    person who did as they were told made it again, under a new name the server could not
    know for the same edit.
- **Now** the caret and the keyboard are moved after an answer only if the person has not
  moved them, or typed, meanwhile (`moves` in `apps/web/lib/visual.ts`), and a table or
  figure is found where it is now. An edit not answered is asked for again every three seconds
  under the same name, which the server makes once, and is never said to have failed while
  it may still be made: after eight seconds the note says "No answer yet to that change.
  Still trying: it will be made once, so do not make it again.", then "That change has now
  been made." (`run` in `FileEditor.tsx`). The insert windows cannot be sent again while
  their answer is awaited (`Tools.tsx`).
- **Found afterwards, by the browser tests on another change.** A window closed with Escape is
  hidden, and the keyboard given back to the text, by the browser at once; the page puts the
  caret back where it was when the window was asked for only when the window's close event
  reaches it. On a busy machine the person had clicked elsewhere and typed a letter by then,
  and the rest of their typing went back beside the insertion. The caret is now put back only
  if the person has not pressed the mouse or a key in the text since the window was asked for
  (`acted` in `apps/web/lib/visual.ts`). The test holds the close event back 400 ms, so it
  failed on the old code every time (5 of 5).
- **Held by** browser tests, each failed on the old code: `insert.spec` "an insertion slow to
  arrive leaves the caret where its person put it"; `tables.spec` "a cell slow to be changed
  does not take the keyboard back"; `recover.spec` "a change whose answer is late is made
  once" (steady three runs in a row). The slow line is `slowLine` in `tests/e2e/helpers.ts`.
- **Not changed:** emphasis given to a selected word and then typed straight after, before
  its answer, puts the letters before the word, or some before it and some inside
  (`abc\emph{bravoend}`, `abcd\emph{bravoendefgh}`): nothing is lost, and it is not
  understood. An insert window waiting for its answer stays open, and says nothing until
  eight seconds have passed. Closing an insert window with Escape puts the keyboard back in
  the text where it was, which a click made at the same instant can lose to.
- **How it was made.** Planned and its faults explained by one agent, probed and written by
  others, checked here.

## When the line to Postgres or the store goes quiet

- **What was tried**, with a probe, on one machine: a proxy between the web app and Postgres (or
  the store) that holds or drops the bytes of live connections for a while, and the same with
  `iptables` dropping packets (the kernel runs), with Playwright driving the browser. Not tried:
  Vercel, pgbouncer (none on the machine), and kernel keepalive probing of a dead peer.
- **Found (before any change).** Nothing in the stack timed out: no statement, query or connect
  limit, `idle_in_transaction_session_timeout` and `tcp_keepalives_idle` at 0, no abort on the
  browser's `fetch` calls.
  - A save, restore or rename made while the line went quiet right after its `select … for
update` held the paper's file rows for **189.6 s** (until the proxy was cut; it did not end
    by itself, and the lock was still held 70 s after the line returned). Another person's
    typing into the paper went unsaved for that time; the owner's page said nothing.
  - The build worker's claim transaction waited on that lock for 66 s: builds of every paper
    stayed queued, and built within 3 s of the cut.
  - A request in flight when the line went quiet was still pending at +95 s, and a build poll
    stayed in flight at +130 s.
  - After one failed first call to the store, every later `put` in that process failed at once
    (0 ms) with the same error, though the store was back.
  - With the kernel dropping the store's port, the ZIP failed after 12.2 s as a blank 500.
  - A cut connection (as opposed to a quiet one) was fine, except that a connection held by the
    sign-in library was an uncaught `Connection terminated unexpectedly`; the process survived.
- **Now** (`packages/server/src/db.ts`, `blobs.ts`): the limits in `docs/settings.md`, "Fixed in
  the code". A connection released with a timed-out query still waiting is closed, and one
  whose rollback does not answer within 5 s is thrown away. A connection lost while checked out
  is heard. A failed first call to the store is not remembered.
- **Held by** tests, each failed on the old code: `db.sandbox.test.ts` (a quiet transaction is
  ended in 0.5 s and frees its row; the default is `15s`; a statement times out and its
  connection is dropped; a lost checked-out connection is heard), `db.test.ts` (the pool's
  limits), `blobs.test.ts` (a failed first call is asked again; a store that never answers
  fails with `unavailable` after 10 s, tried with fake timers).
- **Not tried or not measured.**
  - The probe was re-run once with both halves in (below); not again after the build-pane fix.
  - Vercel and pgbouncer. How the 15-second limit passes through a pooler was not tried.
  - Kernel keepalive: that a dead peer is noticed in about 20 s (Node's libuv probes) is from
    memory, not confirmed. Only a kernel drop could test it.
  - A timed-out write may still have been made (an invitation row without its email); not
    changed, but the error page now says that a change may or may not have been made.
  - Transactions that read many files from the store while holding no statement, such as the
    proposal's apply, can idle for as long as the reads take; none was measured near 15 s.
- **How it was made.** Planned from the probe by one agent, written and checked here.
- **Re-run with both halves in** (server limits and the browser's), the same cases, proxy drop
  except the store case:
  - Save, restore and rename while the line went quiet: another person's letters went unsaved
    for **14.2, 14.5 and 14.1 s** (were 189.6 s), and the transaction was gone at +18 s. The
    owner's page showed "This page could not be shown… What was already saved is still saved"
    at +36 s (was nothing for 190 s).
  - Builds queued behind that: another paper's waited 7.7 s (was still queued at +76 s).
  - Editor whose ticket hung: "Offline. Your edits are waiting to be saved." from +4 to +28 s
    (was "Saving your edits…" to +142 s); the letters reached the database by +32 s (was +144 s).
  - Store port dropped by the kernel: the add said "The file store did not answer. Try again in
    a moment." at 11.8 s, the ZIP was a 503 at 11.7 s; 65 s after the line returned both worked
    (before: both still failed).
  - A page load lost with a warm pool: the error page at 30.2 s (was pending at +95 s).
  - An invitation whose line went quiet after its row was written: the error page at +31 s;
    the row is there and no email was sent. Pressing again sends one email and ends the first.
  - **Found and fixed after:** the build pane never warned, because a poll the server answered
    with a 500 (its own database did not answer) reset the count of polls without an answer.
    A 5xx now counts as no answer; `building.spec.ts` "a server that answers with errors is said
    so as well" failed on the old code.
  - **Since then:** while a form or a link waits, the page says "Working…" after 1 s and "No
    answer from the server yet" after 8 s, and the error page says a change may or may not
    have been made (see "What the browser says when the server does not answer"). The error
    page itself still comes at 30 to 36 s.

## Undoing each thing

- **What was tried**, with a probe, three times over: twenty cases of undo and redo, by the
  keys and by the buttons, with a second person on the paper, reading both people's copies of
  the source and where the caret was after each step.

| Undone and redone                                                      | What happened                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A word typed; 30 characters typed fast, then five undos                | taken back whole, and put back                                             |
| A formula, citation, reference, figure, table inserted                 | each one step, whole; no `$` or brace left                                 |
| A cell, a row, a column, a caption, a description changed              | each one step; every row of the table well formed throughout               |
| Emphasis; a paste of two paragraphs; a drop of two paragraphs          | each one step, whole                                                       |
| Typed in one view, undone in the other                                 | the right change undone                                                    |
| **Enter, then a letter, then undo; then typing**                       | **the caret left beside the table, and what was typed next lost**          |
| **Enter, then undo at once**                                           | **the thing typed before Enter taken back; the empty paragraph left**      |
| A proposal accepted, then Ctrl+Z                                       | nothing: an accept is not in the person's history. "Undo the accept" works |
| Another person deletes the paragraph typed in, or restores a revision  | the owner's undo changes nothing; nothing comes back                       |
| Another person edits inside a formula the owner inserted; owner undoes | their text left, without the formula around it (below)                     |
| Ctrl+Z in a table cell's field, or in the formula window               | the field's own text undone; the paper untouched                           |
| Nothing to undo; a viewer pressing the keys                            | nothing changes; a viewer is offered no Undo or Redo                       |

- **What was wrong.** A paragraph begun with Enter is not in the source until something is
  typed in it. Undoing what was typed takes the paragraph away again, and the caret, which was
  in it, was left on the table after it: the next key was a change to the table, refused, and
  what was typed went nowhere. And undo in such a paragraph before anything was typed took back
  the person's previous change instead, leaving the empty paragraph.
- **Now** a caret whose paragraph is taken away goes to the nearest place text can go (`sync`
  in `packages/bridge/src/bridge.ts`), whoever took it away. Undo in an empty paragraph just
  opened closes it and puts the caret at the end of the paragraph before (`Mod-z` in
  `apps/web/lib/visual.ts`).
- **Held by** a bridge test ("a caret whose paragraph is removed by another origin stays where
  text can go") and a browser test (`visual.spec`: "undo leaves a caret that can be typed at"),
  each failed on the old code.
- **Looked at and not a fault:** after undoing a table edit the caret seemed to go to the start
  of the file. It had been there all along: changing a cell in its field does not move the
  text's caret, and undo did not move it.
- **Not changed:**
  - Undoing a formula that another person has since edited inside takes away only what the
    owner put there: `bravoend$RRR$.` becomes `bravoendRRR.`, and a numbered equation becomes
    `bravoendRRR.` too. Nothing is lost and redo puts it back, but the words left are outside
    any formula, and a command meant for a formula among them would stop the build.
  - On a slow line, undo takes things back in the order they reached the paper: a formula
    whose answer came after later typing is undone first.
  - After an undo elsewhere, the caret stays where it was, rather than going to the change.
  - Ctrl+Z just after accepting a proposal does nothing; "Undo the accept" is the way.
  - The history of undo does not survive a reload.
- **How it was made.** Planned and judged by one agent, probed and written by others, checked
  here. The cause first given for the caret at the start of the file was looked for and not
  found, which is how it was seen not to be a fault.

## A paper that does not compile

- **What was tried**, with a probe: eighteen mistakes authors make, each compiled for real in
  the sandbox and four of them through the page, reading what the build listed and what the
  page said.

| Mistake                                                          | Before                                                             | Now                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| An unknown command; `R&D` bare; a file named `my intro (v2).tex` | its file and line                                                  | the same                                                       |
| A `.bib` entry without its closing brace, or its comma           | **"The latest build failed.", nothing listed**                     | `refs.bib:11 BibTeX: Illegal end of database file.`, and so on |
| `\end{document}` taken out                                       | **only "Emergency stop" and "Fatal error occurred"**               | "The paper ends without \end{document}."                       |
| A package or an `\input` file that does not exist                | **the stop first, then the cause, with no file**                   | the cause alone, with its file                                 |
| 150 unknown commands                                             | a hundred errors, **then "Fatal error occurred" as one more**      | the hundred                                                    |
| A bare `&` in a `.bib` title                                     | **`main.bbl:29`, a file the paper does not have**                  | "In the bibliography (an entry of a .bib file, …)"             |
| `fontspec` under pdfLaTeX                                        | **a path inside TeX's own installation, then the stop**            | "In fontspec.sty: …"                                           |
| A `\textbf{` never closed                                        | the `\input` line of the file it was in                            | the same, and "It began: “{never closed”."                     |
| A `\cite` or `\ref` to nothing                                   | **"up to date", nothing in the editor** (the paper's page said it) | "Built, but the PDF shows ?? for:" and each, with its line     |
| A loop that never ends                                           | "The latest build ran out of time."                                | the same                                                       |
| A list begun and never ended                                     | at `\end{document}`, saying "on input line 15"                     | the same                                                       |
| A mistake inside a command defined in the preamble               | where the command is used                                          | the same                                                       |

- **What was wrong.** The build's list was read from TeX's log alone. BibTeX writes its
  complaints elsewhere, so a broken `.bib` failed the build with nothing to say why. The lines
  in which TeX announces that it has stopped were listed as errors of their own, before the
  cause they followed. An error in a file the build makes for itself (the bibliography as LaTeX
  reads it) or in TeX's own packages was placed in that file. And a build that worked was
  "up to date" even with question marks in the PDF where citations and references should be.
- **Now** (`diagnostics` in `apps/workers/src/compile.ts`, the build pane in `BuildPane.tsx`):
  errors are listed in the order the log has them, without TeX's announcements of stopping;
  BibTeX's own errors are read from what the build printed, with their line of the `.bib`; a
  missing `\end{document}` is said in words; an error in a file not the author's is described,
  not placed. A failed build with nothing listed says so, and a built paper with ?? in it lists
  what is missing, the first ten, the rest on the paper's page.
- **Held by** unit tests on real excerpts of the logs (`diagnostics.test.ts`), two real
  compiles (`compile.sandbox.test.ts`: a `.bib` missing a comma; a `&` in a `.bib` title) and a
  browser test (`building.spec`), each failed on the old code.
- **Not changed:** a list left open is reported at the end of the paper, with the line but not
  the file it was opened in. A mistake inside a command is placed where the command is used. A
  missing package or file is given its file but not its line. A package of TeX's own is named
  without the line that loads it. Biber's errors are read from latexmk's output, with the .bib and its line (a .bib that
  is not there has no line); biber's own log, main.blg, is still not the build log shown. BibTeX's own words are not in the build log a person can open. A bare `_`, `^`, `&` or `#` in a `.bib` entry is now placed in the `.bib`; see "A bare character in a .bib entry".
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## A paper taken out and brought back

- **What was tried**, with a probe: sixteen kinds of paper exported as "ZIP with review data"
  and imported again, comparing threads, proposals and the import report; and one paper with
  everything a paper can have taken out and brought back through the pages, its page read
  beside the original's, section by section, and both built.

| Taken out and brought back                                           | Before                                                | Now                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| A model-made proposal with one quote of 501 characters               | **no thread or proposal at all**: "could not be read" | everything; the quote cut to 500      |
| A thread of 501 comments; a starter's address of 321 characters      | **nothing**                                           | everything; the address cut to 320    |
| 2,001 threads, or proposals                                          | **nothing**                                           | everything (up to 20,000 each)        |
| One unreadable item among good ones                                  | **nothing**                                           | the rest, and one line saying so      |
| A paper whose root file is not the one the importer would pick       | **the other root, building another document**         | the same root, and the report says so |
| A thread on words edited since ("40 ms" made "45 ms")                | **detached**                                          | on the words as they read             |
| A detached thread whose words were later typed again elsewhere       | **attached to them**                                  | detached                              |
| An accepted proposal whose words were changed since                  | **fresh, its undo allowed**                           | stale, as it was                      |
| A deleted stretch; the middle of three; the first and last word      | as it was                                             | the same                              |
| Long, multi-line and odd-charactered comments; CRLF; folders; spaces | identical                                             | the same                              |
| Exported twice; imported twice                                       | the same file; two whole papers                       | the same                              |
| Who accepted or rejected a proposal                                  | **"someone who has left"**                            | their address, as it was              |
| Revisions, citation checks, data descriptions, charts, language      | **gone, without a word**                              | gone, and the page says so            |

- **What was wrong.** The importer read the review file whole, against limits the app itself
  does not keep: one quote too long from the reviewing model, one thread with many replies, one
  long address, and nothing came at all. The root file was not in the archive, so the importer
  chose its own, and the paper built something else. A thread was written out by the words it
  began on, not those it now covered. And what a paper has besides its files and its review
  stayed behind without the page saying so.
- **Now** (`packages/server/src/reviewdata.ts`, `import.ts`, `critique.ts`): each thread and
  proposal is read on its own, and one that cannot be read is named and left out; names and
  quotes too long are cut, not refused; the counts it reads go to 20,000. The root file goes
  with the review and is made the root on the way in. A thread goes by how it reads now, and one
  already detached stays so; an accepted proposal gone stale stays stale, and who decided it
  comes with it (`imported_decider`, as `imported_author` does for its author; a file from before
  this says "Accepted." without a name rather than "someone who has left", which was not true). The reviewing model's
  quotes are cut to 500 where they are kept. The paper's page says, by the export and in the
  import's report, what does not go with a paper.
- **Held by** service tests (`reviewdata.sandbox.test`, `import.sandbox.test`,
  `critique.sandbox.test`), each failed on the old code, and one that a file exported before this
  still comes in whole.
- **Not changed:** (a thread on more than 500
  characters now comes back whole; see the last section). The compiler is the one the importer read from the
  files, which the root may not decide. A review file at the top of an archive of several papers
  is given to none. There is no limit on how many comments a thread may have, and sign-in takes
  an address longer than the 320 characters an export keeps. No browser test makes the round
  trip; the page's sentences are not under test.
- **Found later, in CI:** an imported thread's comments came back in an order of their own
  when two were made within one millisecond, since the file keeps times to the millisecond
  and the database then put ties in a random order. Each imported comment is now stored after
  the one before it, so the file's order holds. A service test with twenty comments of one
  time held it, and failed on the old code three times in three.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## A paper whose root file is in a folder

- **What was wrong.** A paper whose root file was in a folder (`paper/main.tex`) never built,
  and the build said only that it had failed without saying where. The compiler was run from the
  top of the paper, so it wrote its PDF and log beside the top and looked for them beside the root
  file; and TeX read the paper's paths from the top, while every other part of the app (the
  include graph, renames, pictures) reads them from the root file's folder. A root gets into a
  folder by "Make … the root file", by a rename, or carried by an archive. Found by the probe of
  renames, which moved a root.
- **Now** the compiler runs in the root file's folder (`latexmk -cd`, `apps/workers/src/compile.ts`):
  paths are read from there, as the rest of the app reads them, and the PDF, log and SyncTeX land
  where they are looked for. The places in the log, written from that folder, are given back as
  the paper's paths (`../shared/macros.tex` from `paper/` is `shared/macros.tex`); one that climbs
  out of the paper is given no file. SyncTeX's paths are read the same way. The command a saved
  revision records is the one that runs.
- **Held by** a real build of a paper under `paper/` that reads a file above it, with an error
  placed in `paper/sections/intro.tex` (`compile.sandbox.test`); unit tests of the places in the log
  and of SyncTeX's paths; and a browser test that makes a file in a folder the root and builds it.
  Each failed on the old code. The builds of papers whose root is at the top are unchanged.
- **The convention**, for anyone writing a paper here: its paths are read from the folder of its
  root file, as when LaTeX is run in that folder.

## Something renamed

- **What was tried**, with a probe: files and labels renamed in a paper that names them in
  every way it can (a class, a package and a bibliography style of its own, `\graphicspath`, a
  listing, an included PDF, a table of data read by a plot, quoted and brace-less names, and
  mentions in comments and `verbatim`), each paper built before and after; four of them through
  the pages.

| Renamed                                                                           | Before                                                                                                             | Now                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| A section; a `.bib` in a list; a picture there as `.pdf` and `.png`               | the lines that name it follow; it builds                                                                           | the same                                                      |
| The paper's own `.sty`, `.cls` or `.bst`; a listing; an included PDF; a data file | **renamed at once, nothing said; the build broke**                                                                 | the lines that name it follow, and it builds                  |
| A picture found through `\graphicspath{{figures/}}`                               | **not followed; the build broke**; called "not in the project" before any rename, and not shown in the visual view | followed; found; shown                                        |
| The root file into a folder                                                       | **never built, nothing said why**                                                                                  | builds ("A paper whose root file is in a folder")             |
| A picture named `"my plot"`; `\input {a}`; `\input a`                             | **not followed; the build broke**                                                                                  | followed                                                      |
| A label used by `\ref`, `\cref` (lists, spaces, line breaks), `\ref*`             | followed; `sec:ab` untouched; labels in comments and listings untouched                                            | the same                                                      |
| A label used by `\hyperref[…]`, `\fref`, `\Fref`, `\zcref`                        | **left behind; "up to date", with ?? in the PDF**                                                                  | followed; and a reference to nothing by `\hyperref` is listed |

- **What was wrong.** A rename that found no line went through at once: the page asked only when
  it had lines to show, and a file named in a way it does not read was renamed without a word.
  The folders `\graphicspath` names were not looked in. Four ways of referring to a label were not
  read, and the build pane's list of what shows as ?? did not know the warning hyperref gives.
- **Now** every rename of a file shows what would change first, and when it sees no line naming
  the file it says that a package, class, bibliography style, listing or data file can be named
  in ways it does not read, and to check the paper still builds (`renameAction`, the rename
  page). `\graphicspath` is read wherever pictures are found and named, wherever the paper sets
  it: in the root, in a preamble file it `\input`s or in a project `.sty` or `.cls` it loads, the
  last setting in TeX's order winning (`projectGraphicsPaths`, `resolveVia` in `packages/latex/src/graph.ts`; `renamePlan`, `picture` in
  `packages/server/src/files.ts`). `\hyperref[…]`, `\fref`, `\Fref`, `\zcref` and `\zcpageref` are
  read as references, by the rename and by the paper's list of references.
  The ways a paper names its own packages, class, bibliography style, listings, included PDFs,
  SVGs and plotted or tabled data (`\usepackage`, `\documentclass`, `\bibliographystyle`,
  `\lstinputlisting`, `\includepdf`, `\addplot table`, `\csvreader` and the like) are read too,
  for renames only: a system package is not reported missing, and the build's order of files is
  unchanged. A name in quotes, `\input {a}` and `\input a` are read. A rename no longer changes
  lines inside `verbatim` or a listing, nor what follows `\\%` (`uncomment` in `graph.ts`). Each held by a unit test of the
  form read, and a service test renaming a `.sty`, a listing and a data file, then building.
- **Held by** unit tests (`graph.test.ts`, `labels.test.ts`), service tests (a picture renamed
  under `\graphicspath`, then built; a label renamed through each new form) and browser tests
  (the sentence shown before renaming a style file; a `\hyperref` to nothing listed), each failed
  on the old code.
- **Not changed:** what the paper's own `.sty` and `.cls` files name in turn. A label made by a
  command of the paper's own with a parameter is not seen, so a reference to it is listed as to
  nothing, and renaming another label to its name is not refused. The list of pictures offered
  for insertion still names them from the root's folder, which builds. The page's warning before
  a rename that sees no line stays, for whatever is still not read.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## Someone coming onto a paper, and leaving it

- **What was tried**, with a probe: fifteen cases of one person invited, joining, removed,
  leaving and invited again, reading the page and the rows of invitations and members after
  every step.

| Case                                                            | Before                                                         | Now                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Invited twice, joined on one link, removed; the other link used | **joined again, with the role it named**                       | "not valid any more"                                         |
| The same after leaving                                          | **joined again**                                               | "not valid any more"                                         |
| Removed, then invited again on purpose                          | joined, with the new role                                      | the same                                                     |
| An invitation to a mistyped address                             | **not to be seen or cancelled; its owner joined as an editor** | listed under "Invited, not yet joined", and can be cancelled |
| Invited as editor, then again as viewer; the first link used    | **an editor**; the second link still live                      | the first link is ended; the later role stands               |
| A viewer invited as editor                                      | **"You were invited as an editor"**, then still a viewer       | "You are already on this paper as a viewer…", no Join        |
| A link opened by another account                                | **Join, then refused, with no way on**                         | who it is for, who is signed in, and a way to sign out       |
| Signed out: the link, sign-in, back to the link                 | back on the link                                               | the same                                                     |
| A link used twice; a link fifteen days old                      | "not valid any more"                                           | the same                                                     |
| A role lowered while a spare invitation of a higher one is held | the lower role stays                                           | the same                                                     |
| The owner's own address invited; the owner leaving or removed   | still the owner; refused                                       | the same                                                     |
| A viewer or reviewer sending an invitation                      | not offered; refused                                           | the same                                                     |
| A removed person's comments and proposals                       | kept, with their name                                          | the same                                                     |

- **What was wrong.** Removing a person deleted their place in the paper and nothing else, and
  an invitation could be used by its address until it was used or fourteen days old. So a
  spare one let the person back in without the owner. Nothing showed the invitations an owner
  had sent, so one to a mistyped address could not be stopped. The invitation's page did not
  look at who was reading it beyond their address.
- **Now** (`packages/server/src/projects.ts`; the paper's page; the invitation's page):
  removing or leaving ends the person's unused invitations to that paper, in the same statement
  as their place in it. The owner sees "Invited, not yet joined", each with its role and the
  day it ends, and can cancel each. A new invitation to an address ends its earlier one. Ended
  invitations are kept, so that they still count against the hourly limit on sending. The
  invitation's page says when the reader is already on the paper, or is signed in as someone
  else, and does not offer to join.
- **Held by** service tests (`projects.sandbox.test`: removed and left, each unable to come
  back on a spare link; pending invitations listed and cancelled, by the owner only; a second
  invitation leaving one), which failed on the old code; two that pass on both and keep what
  was right (invited again after removal; a spare invitation not raising a lowered role); and
  browser tests of the list and its cancelling, and of the invitation's page for a member and
  for another account.
- **Not changed:** an invitation lasts fourteen days. Everyone on a paper sees the others'
  addresses.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

### The owner hands the paper to another member

- **Before:** a paper could not change owner. Its importer was the sole owner for ever, and
  `removeMember` refuses to let the owner leave.
- **Now** (`transferOwnership` in `packages/server/src/projects.ts`; the page at
  `/projects/<id>/owner`, linked from the owner's paper after People): the owner may hand the
  paper to anyone else on it, of any role, and becomes an editor. Only the owner may
  (`members.manage`, which only the owner holds). Others on the paper get `permission_denied`,
  non-members `not_found`; handing it to oneself, to someone not on the paper, to a malformed
  id, or to someone who only has an invitation gives `invalid_input`. It is one transaction:
  the old owner is lowered first (the one-owner index allows no other order, and a second
  handover at once finds nobody to lower and is refused), then the person is raised; if they
  have left in between, all of it is taken back. Open editors are told through `acl`.
- **The old owner** can then leave like any editor. Invitations not yet taken up stay.
  The page says the person handing over cannot take it back, and that the new owner may remove
  them or delete the paper.
- **Open editors:** an editor open under the old role is told "You are now an editor on this
  paper" and is not locked, as write access stays. The lock is only for losing it.
- **Papers per hour:** `mayStartPapers` counts papers by who owns them now, not by who made
  them. A handover moves a paper started in the last hour from the old owner's count to the new
  owner's, so the limit on starting papers can be passed by giving papers away, and a new owner
  can be held back by papers they were given. Accepted: the limit bounds what one account can
  hold, and it is the owner who holds it.
- **Held by** service tests (`projects.sandbox.test`: who may hand over and to whom, with the
  rows unchanged; one owner after a handover, the old owner an editor who can leave and cannot
  invite or delete; two at once, and a person who has left) and a browser test.

## What "ready to send" is worth

- **What was tried**, with a probe: papers that build cleanly and papers whose PDF shows ?? or
  [?], each checked with "Check before submitting" after a fresh build, and the verdict read
  against the PDF.

| Case                                                                      | Before                                          | Now                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| A hand-written `thebibliography`, every key present                       | **every citation "a key no entry has"**         | ready; a missing key is the one problem                |
| `\bibliography{IEEEabrv,refs}`, `\input{glyphtounicode}`, `example-image` | **"The paper has no file …"**, not ready        | a warning: not among the paper's files, LaTeX found it |
| `\pageref{LastPage}`; a label made by a macro; a label in a `.sty`        | **"refers to a label the paper does not have"** | a warning: LaTeX resolved it                           |
| `\see{nolabel}`, a macro wrapping `\ref`                                  | **ready**, with ?? in the PDF                   | a problem, from TeX's own warning, with its line       |
| A key only in a `.bib` that `\bibliography` does not name                 | **ready**, with [?] in the PDF                  | a problem, the same way                                |
| `\input{nosuchfile}`                                                      | a problem                                       | the same                                               |
| biblatex `\parencite` and natbib `\citeauthor*` of missing keys           | problems                                        | the same, each once                                    |
| `\hyperref[nolabel]`; a label given twice                                 | problems                                        | the same                                               |
| A build older than the text; the ZIP and PDF                              | not ready; of one revision                      | the same                                               |
| An overfull box or a font warning alone                                   | ready                                           | the same                                               |

- **What was wrong.** The verdict rested on reading the source. What the reading could not
  follow (a package's file, a macro's label, a hand-written bibliography) was called missing,
  so a correct paper was never ready. What TeX could not resolve was only a warning in the
  build, so a paper with ?? in its PDF could be.
- **Now** (`packages/server/src/submit.ts`, `bibItems` in `packages/latex/src/bib.ts`): when the
  newest build is of the paper as it stands and succeeded, TeX's per-key "undefined" and
  "multiply defined" warnings are problems, once each beside what the reading found. A file,
  label or citation the reading calls missing stays a problem only if TeX also complained of
  it; otherwise it is a warning that says LaTeX found or resolved it. Without such a build the
  reading's findings are problems, as before, and the build being out of date is one too.
  Each `\bibitem` of a `thebibliography` is an entry of the paper's bibliography: offered by
  the citation picker, listed on the paper's page (with no DOI to look up), and open to
  evidence checks. The import report says a file it cannot find may come with the TeX
  installation.
- **Held by** five real-build service tests (`submit.sandbox.test`), four of which failed on
  the old code and one that holds an overfull box still ready; unit tests of `bibItems`; a
  service test of the entries; and a browser step in which a `thebibliography` paper is ready
  and offers its downloads, which failed on the old code.
- **Not changed:** the paper page's bibliography section still reports a key no `.bib` entry
  or `\bibitem` has from the reading alone. A `\bibitem` in a file the root does not reach is
  not in the bibliography, though evidence checks can still be recorded on it. The summary
  line "There were undefined references" stays a warning, since a per-key line comes with it.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## Taking up a suggestion

- **What was tried**, with a probe: fifteen cases of spelling and grammar findings on LaTeX
  that escapes characters, uses its own typography, or holds a long file, taken up by an owner
  and by a reviewer, with the source and the built PDF read after each.

| Case                                                                          | Before                                               | Now                                        |
| ----------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| The repeat in `R\&D R\&D` taken, as the checker offers it                     | **a bare `&` in the source**                         | `R\&D`                                     |
| A suggestion holding `%` taken (`50\% of`)                                    | **a bare `%`: the PDF reads "We spent 50"**          | `\%`; the line is whole                    |
| The same proposed by a reviewer and accepted                                  | **the same**, with only "The units differ" said      | the same as an owner's                     |
| "It is a word of this paper" on `R\&D`                                        | **offered, then "One of the words cannot be used."** | not offered; the rule can still be ignored |
| ` ``quotes'' `, `--`, `---`, `e.g.\ `, `\ldots`, `\LaTeX`, `Schr\"odinger`    | no findings                                          | the same                                   |
| A word wrapped onto the next line; a heading, a caption, an `\emph`           | found, within the word                               | the same                                   |
| A file of 300,000 characters                                                  | checked, in 9 seconds                                | the same                                   |
| A suggestion taken after its word was edited, or after text was put before it | refused with a sentence; or made on the right word   | the same                                   |
| Every rule id the checker gave                                                | can be switched off                                  | the same                                   |

- **What was wrong.** The checker reads `R\&D` as "R&D" and answers in plain text. What it
  offered was put into the source as it came, so a suggestion holding `%`, `&`, `#`, `_`, `$`
  or a brace became LaTeX of another meaning: a comment, a table column, a subscript.
- **Now** (`checkGrammar` in `packages/server/src/grammar.ts`): every suggestion is escaped
  as the visual view escapes typing (`escape`, now in `packages/latex/src/escape.ts`) before it
  leaves the server, so an owner's change and a reviewer's proposal are both source. A finding
  says whether its words can be one of the paper's words, and the page offers that only then.
- **Held by** a service test with the real checker on `R\&D R\&D` and a fake one for the other
  characters, and a browser test that takes the suggestion, builds, and reads the PDF's text.
  Both failed on the old code; the browser test's check on the paper's words failed on the old
  page alone.
- **Not changed:** words in a footnote or a table cell are not checked. Coarse or missed
  findings are not a fault of this kind and were not looked into.
- **Also fixed on the way:** `files.spec` pressed "Rename" on the confirming page before it
  had come, and pressed the paper page's own button instead, which only asked again. It
  failed twice in three runs on one machine, and passed in CI. The test now waits for the page.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## Is the entry right?

- **What was tried**, with a probe: "Look up DOI" and evidence checks on the entries real
  bibliographies hold, against a stand-in for the registry that answered as Crossref does.

| Case                                                                         | Before                                        | Now                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| `doi = {10.1007/978-3-540-74958-5\_1}`                                       | **sent with its backslash: "no record"**      | looked up as `…5_1`; matches              |
| `doi:10.1000/x`, `DOI 10.1000/x`; a DOI only in `url`                        | **"no DOI that can be looked up"**            | looked up                                 |
| `10.1000/x.`                                                                 | **looked up with the full stop**              | without it                                |
| An arXiv DOI, which Crossref does not hold                                   | **"The registry has no record of this DOI."** | says it may be registered with DataCite   |
| Two different titles in Chinese, or in Russian                               | **"Matches the registry"**                    | differs                                   |
| `Growth of <i>E. coli</i> &amp; others`; `H<sub>2</sub>O`, from the registry | **differs**                                   | matches                                   |
| `Johannes van der Waals`; `Martin Luther King, Jr.`; an organisation         | **the first author differs**                  | the same                                  |
| A title with a subtitle the registry gives apart                             | **differs**                                   | matches                                   |
| The print year, where the registry's first date is a year earlier            | **differs**                                   | matches                                   |
| `Phys. Rev. Lett.`, given by the registry as its short title                 | **differs**                                   | matches                                   |
| A claim in Chinese, deleted from the paper, or never in it                   | **"still said"**                              | not                                       |
| A claim copied from the PDF, with `[3]` or `Figure 2` in it                  | **"no longer said"** while the sentence stood | still said; a changed number still is not |
| The registry answering with a page, 429, 500, or too slowly                  | "did not answer", nothing recorded            | the same                                  |

- **What was wrong.** The DOI was taken from the entry as written, with BibTeX's escapes in
  it. Text was compared after keeping only `a` to `z` and digits, so every other script
  compared as nothing, and nothing equals nothing. The registry's own markup was compared as
  words. Names, subtitles, dates and venues were read one way only.
- **Now** (`cleanDoi` in `packages/latex/src/bib.ts`; `packages/server/src/evidence.ts`): the
  DOI is cleaned of escapes, prefixes and trailing marks, and found in `url` when there is no
  `doi`. Text keeps the letters and digits of every script, and nothing with no letters is
  ever the same as anything. The registry's tags and entities are taken out. An author is the
  same when the entry's name ends with the registry's family name, or the organisation's name;
  a title with or without its subtitle, any of the registry's dates, and its full or short
  venue all count. Whether a claim is still said is read without citation and reference
  commands, and without the numbers the paper's own numbering puts in a copied sentence.
  `plainText` reads `\o`, `\ae`, `\ss` and their kin as letters.
- **Held by** service tests, one for each rule, with guards for what was right; unit tests of
  `cleanDoi` and `squash`; and a browser step for the escaped DOI and the DataCite sentence.
  Each failed on the old code, but the one that holds an arXiv DOI's outcome, which was right.
- **Not changed:** only Crossref is asked. "Fig. 2" in a claim is not "Figure" in the
  paper. An entry whose DOI was written as an address reads as changed since its last
  lookup, once, because what is compared is now the cleaned DOI. "Check before submitting"
  does not list lookups or evidence checks.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## From the PDF to the line, and back

- **What was tried**, with a probe: a two-column paper in three files, built, then clicked in the
  PDF and asked to "show in the PDF", fresh and after edits made since the build, at several
  sizes and on several pages; and the raw SyncTeX of it and of the IEEE fixture read record by
  record.

| Case                                                                | Before                                                   | Now                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| A double-click at the start of a wrapped line, fresh build          | **the line the paragraph ended on; once, the next file** | the line the word is on                                    |
| "Show in the PDF" on a heading that begins an `\input` file         | **the previous file's last paragraph**                   | the heading                                                |
| A click after ten lines were added above, the PDF not yet rebuilt   | **ten lines early, as if right**                         | the word's line now                                        |
| A click on a paragraph deleted since the build                      | **another paragraph's line, as if right**                | the nearest line, said to be the nearest place             |
| "Show in the PDF" for a line added since the build                  | **the build's line of that number**                      | the nearest place in the PDF, said to be so                |
| The same after a failed build, from the older PDF                   | **as above**                                             | as above                                                   |
| A click in a file renamed since the build                           | the right file, **named by its old name**                | its name now                                               |
| A click in a file deleted since the build                           | **an answer for a file that is gone**                    | "That part of the PDF came from a file that is no longer…" |
| A white margin, far from any text                                   | **a distant line**                                       | "The PDF does not say where that is."                      |
| "Go to the text for the middle of the pages shown" over white space | the nearest line                                         | the same                                                   |
| A click mid-line; at 800 and 1400 pixels, zoomed; on page 3         | the right line                                           | the same                                                   |
| A click on a marker in another file                                 | that file opens at the line                              | the same                                                   |
| The bibliography                                                    | "The PDF does not say where that is."                    | the same                                                   |

- **What was wrong.** TeX tags a paragraph's line boxes, and what it puts at their start and end,
  with the line it was on when it ended the paragraph: the blank line after it, or the first
  line of the next file. A click took the record nearest along the line, which at the line's
  start is one of those. The other way, a heading at the top of an included file shares its
  line with the end of the paragraph before it, and the first record of that line was taken.
  Separately, both directions used line numbers as they were when the PDF was built, and said
  nothing when the text had moved on since.
- **Now** (`packages/latex/src/synctex.ts`; `pdfToSource`, `sourceToPdf` in
  `packages/server/src/builds.ts`; `carryLine` in `textdiff.ts`): a box holding records of
  other lines is known to be tagged with its paragraph's end, and its records tagged so are
  left out, in both directions. A click takes the last record at or before it on its line. A
  line is carried between the built text and the text now through the same comparison that
  shows revisions, and the page says "The PDF is from before your latest edits, so this is the
  nearest place." when a line was not kept. A file is named as it is now, or refused when gone.
- **Held by** unit tests of the reading (a wrapped paragraph clicked at its edge, a heading
  after a paragraph, a margin) and of `carryLine`; a service test on a real build of edits,
  a deletion, a rename and a heading; and two browser tests, a click at a wrapped line's edge
  and a click after typing above. Each failed on the old code. The round trip over the IEEE
  fixture is 39 of 41 lines, against 49 of 52 before: blank lines that only end a paragraph no
  longer count as making something.
- **Not changed:** `\begin{tabular}` and `\end{tabular}` point at the table's first row. A
  place inside a line is known to the nearest space (the clicked word and the caret's share of
  the line now narrow that: see "Between the PDF and the text, to the word"). A line kept exactly
  is not said to be approximate, though the PDF is behind.
- **How it was made.** Planned by one agent, probed and written by others, and the cause of
  the first fix's regression found by the planner from the records themselves; checked here.

## The keys a person presses without thinking

- **What was tried**, with a probe: Enter, Backspace, Delete, select-and-type, Ctrl+A, cut and
  paste, Tab and Shift+Enter in the visual view, in paragraphs, a heading, a list, emphasised
  text and next to formulas, a citation, an equation and a figure, each on a fresh copy of a
  paper and with the source read after every key; and once more with a second person in the
  file. Then the same keys pressed with no pause between them, and with pauses of 10 to 150 ms.

| Case                                                                                         | Before                                                                                   | Now                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Delete at the end of the paragraph before a list, then typing                                | **the whole list selected; typing went nowhere**                                         | nothing happens; the caret stays                |
| Backspace at the start of the first list item, then typing                                   | **a new paragraph in front of the one before the list**                                  | nothing happens; typing goes in the item        |
| Select from one paragraph into the next; Delete, or type over it                             | refused, "Make it in the source editor"; **still selected, so typing was refused again** | the paragraphs are joined, or the typing put in |
| The same across three paragraphs, or with a second person in between                         | the same                                                                                 | the same as above                               |
| Select a word, Enter                                                                         | refused                                                                                  | a paragraph break in its place                  |
| Backspace or Delete next to a heading, list, equation or figure                              | refused, eight ways                                                                      | nothing happens, and nothing is said            |
| A note about a refused key, after the next key that worked                                   | **still shown**                                                                          | gone                                            |
| Shift+Enter                                                                                  | **nothing, and nothing said**                                                            | says a line break is made in the source         |
| Ctrl+A, then Delete or typing                                                                | refused                                                                                  | the same: it would take the preamble too        |
| Triple-click a paragraph, then Delete or typing; a formula or citation deleted or typed over | made                                                                                     | the same                                        |
| Enter, Backspace, Delete pressed under 5 ms after Home, End or an arrow                      | **made where the caret had been**                                                        | made where the caret is                         |
| Characters, accented and not, typed in                                                       | put in as typed                                                                          | the same                                        |

- **What was wrong.** The visual view took a fixed set of shapes of edit and sent the rest to
  the source. A key that moved only the selection could leave it where no text can go: between
  blocks, or around a whole list, so that the next key did nothing. A refused selection stayed
  as it was, so that every key after it was refused too. And the editor learns of a caret moved
  by the browser a few milliseconds late, so Enter pressed at once acted at the old place.
- **Now** (`translate` in `packages/bridge/src/translate.ts`; `Bridge.filter`;
  `apps/web/lib/visual.ts`): a selection between paragraphs, with only whole paragraphs in it, is
  deleted or typed over in one change to the source, and Enter over a selection in one paragraph
  breaks it there. A key that would leave the caret where nothing can be typed, or a container
  selected, does nothing. Backspace or Delete with nothing to join does nothing and says
  nothing. The note goes when an edit goes through. Enter, Backspace and Delete first catch up
  with where the caret is. The random-operation test makes the new kinds of edit too.
- **Held by** bridge tests of each new edit and of what is still refused, a filter test, the
  random-operation and convergence tests with the new edits among them, and a browser test of the
  keys. Each failed on the old code. One older bridge test deleted across two paragraphs to show
  a refusal; it now starts inside emphasised text, which is still refused.
- **Not changed:**
  - Enter inside emphasised text or in the middle of a heading, and Ctrl+A, are still sent to the source. Ctrl+X across paragraphs, refused before, was
    not tried again.
  - Enter at the start of a paragraph does nothing: an extra blank line means nothing in LaTeX.
  - Tab leaves the editor, so that the keyboard is never caught in it.
  - Characters pdfLaTeX cannot print (你好, 😀) are put in as typed. The build then names each
    one, its file and line; XeLaTeX and LuaLaTeX papers need them.
  - A space left where a formula or a word was deleted is left: LaTeX ignores it.
- **How it was made.** Planned by one agent, probed and written by others, and the fast-key
  case timed by the planner; checked here.

## What a restore does to what is attached to the text

- **What was tried**, with a probe: a file of five paragraphs with a thread and a proposed change
  on the middle one, a revision, then edits above, below, and on the same line, and a restore;
  restores back again; renames and deletions; and in the browser, a second person typing in the
  middle paragraph, or with a reply or a changed proposal half written, as the restore landed.

| Case                                                                    | Before                                                                        | Now                                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Edits above and below a paragraph with a thread and a proposal; restore | **thread detached; proposal out of date and refused, though its words stood** | both as they were                                                                                       |
| The same with a proposal accepted before the revision                   | **"Undo the accept" refused for good**                                        | can be undone                                                                                           |
| A word changed on the same line as a proposal; restore                  | **the proposal out of date**                                                  | as it was                                                                                               |
| Restore, then restore what that restore kept                            | the text back; **the thread and proposal not**                                | both back                                                                                               |
| A second person typing in a paragraph the restore left alone            | **half lost, half glued to the start of the first paragraph**                 | in that paragraph, in order                                                                             |
| A proposal whose words are gone, changed and saved                      | **turned into an insertion at another place, with Accept offered**            | refused: "The words this was about are no longer in the file. Find them again, or make a new proposal." |
| "Show in the text" on such a proposal                                   | **said nothing, and put the caret elsewhere**                                 | "Those words are no longer in the file."                                                                |
| Such a proposal, its words still in the file once                       | **nothing to do but reject it**                                               | "Find these words again"                                                                                |
| A thread on a word the edit changed, after the restore brings it back   | detached, with "Attach to the same words again"                               | the same                                                                                                |
| A file the restore did not change; a rename; a delete and re-add        | untouched; threads and proposals kept                                         | the same                                                                                                |
| Fifteen cases at the edges of a file, with and without a final newline  | the bytes restored exactly                                                    | the same                                                                                                |
| A reply or a changed proposal half written as the restore lands         | kept                                                                          | the same                                                                                                |

- **What was wrong.** A restore found the first and the last place the file differed from the
  revision, widened both to whole lines, and replaced everything between them. Text between two
  changes was deleted and written again as new characters, and what was attached to the old ones
  (a thread, a proposal, someone's caret) had nothing left to stand on. Proposals, unlike threads,
  had no way to be found again, and one whose place had closed up could be saved as an insertion.
- **Now** (`restoreEdits` in `packages/server/src/revisions.ts`; `reviseProposal` and
  `reattachProposal` in `proposals.ts`; `Proposals.tsx`): each changed stretch is replaced on
  its own, from the last to the first, and a line changed in place is replaced word by word. A
  file too large to compare is replaced as before. A proposal whose words are gone cannot be
  changed into an insertion, says so when shown, and can be found again where its words stand
  once in the file.
- **Held by** service tests of each case above, a random check outside the repository that the
  edits rebuild the revision byte for byte in 20,000 cases, and browser tests of a proposal whose
  words are gone and of a second person typing through a restore. Each failed on the old code,
  except the one that holds a file too large to compare, which behaves as before.
- **Not changed:** letters typed into a paragraph before the restore reaches it are an edit like
  any other, and the restore takes them back. A thread or proposal on text that really changed
  still has to be found again, and only where its words stand once.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## A proposed change that alters the claim

- **What was tried**, with a probe: 69 rewrites of a sentence, each as an author or reviewer would
  write it in LaTeX, through the check behind "This changes more than the wording. Check before
  accepting": the order of what is compared, opposites, units, names, formulas, number words,
  references, scope, and rewordings that change nothing. And through the product: a reviewer's
  proposal on one word, and on a swapped comparison.

| Kind of rewrite                                                                       | Missed before   | Missed now                |
| ------------------------------------------------------------------------------------- | --------------- | ------------------------- |
| Order: "A outperforms B" → "B outperforms A", "from 3 to 5" → "from 5 to 3"           | **7 of 7**      | none                      |
| Opposites: high/low, stable/unstable, before/after and the like                       | **12 of 18**    | none                      |
| A change on the line before a `%` comment                                             | **1**           | none                      |
| Units in `\SI` and `\qty`, megabytes → gigabytes                                      | 3 of 7          | none                      |
| A name opening a sentence; a lower-case tool name                                     | 3 of 5          | 1: a lower-case tool name |
| Formulas: `\max`→`\min`, `+`→`-`, `\alpha`→`\beta`                                    | 12 of 13        | none                      |
| Number words past twelve; `\hyperref[…]` keys                                         | 3               | none                      |
| A limiting phrase removed ("on synthetic data"); "a few" → "few"                      | 4               | 3, written down as such   |
| Rewordings flagged though nothing changed (`1\,000`, `.5`, "percent", "demonstrates") | **4**           | none                      |
| A reviewer's proposal of one word, "high" → "low", in the product                     | **not flagged** | flagged                   |

- **What was wrong.** The check was given only the words a person selected and what they put
  instead, so one word against one word had almost nothing to compare. It compared what was
  named and counted, never in what order, so a swapped comparison read as the same claim. It
  knew "higher" and "lower" but not "high" and "low".
- **Now** (`packages/server/src/claims.ts`, rules `claims-2`; `listProposals`): an open proposal
  whose words still stand is judged in its sentence, before against after, widened to sentence
  ends or a blank line and at most 600 characters each way. Each number is read with the word
  before it, and each word of direction with what it is about, so swapping them is a change.
  Plain opposites, and words negated by a prefix the other version has without it, count. Digit
  grouping, a leading-dot decimal and "percent" are read as what they are, and a hedge or a
  booster is compared by kind, not by word. A unit is not a name.
- **Held by** the challenge set, now 43 pairs larger: every miss fixed here as a pair that
  failed on the old rules, the noise and the rewordings as pairs that must stay quiet (the
  floor for those raised to 25), and the phrases still missed marked as such. A service test of a
  one-word proposal in its sentence, and a browser test of the owner seeing the warning. One
  older assertion, that "A and B took 3 ms and 4 ms" with the numbers swapped is the same claim,
  now expects a flag: which took which is the claim.
- **Then** (rules `claims-3`): operators that carry direction in a formula (`\max`, `\min`,
  `\sup`, `\inf`) and its signs (`+`, `-`, `\times`, `\cdot`, `/`) are compared, and Greek
  letters and one-letter subscripts are names. Units are read from `\SI`, `\qty`, `\si` and
  `\unit`, and written out with their prefixes ("milliseconds" is `ms`). A name opening a
  sentence counts when the other version does not have it and it is not a common opening word.
  Number words to the millions, and `\hyperref`'s key, are read. Of the 69 probe pairs, 4 are
  now missed and none flags a rewording.
- **Not changed:** a lower-case tool name (`pdflatex` → `xelatex`), and a limiting phrase removed
  ("on synthetic data"; "a few" → "few"), are not seen by rules of this kind; they are in the set,
  marked so. The set is still written by hand, not taken from real manuscripts.
- **How it was made.** Planned by one agent, the order rule prototyped by it against the set;
  probed and written by others, checked here.

## A real paper brought in

- **What was tried**, with a probe: archives in the shapes papers really come in, imported and
  then built: a root in a folder, two papers sharing a folder, an arXiv source, the file types
  real papers use, the `.tar.gz` arXiv gives, two documents side by side, a split root, other
  encodings and names, an Overleaf export and a macOS ZIP; three of them also through the page.

| Archive                                                                                  | Before                                                           | Now                                                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/main.tex`, with `figures/` and `refs.bib` beside `src/`                             | **only `main.tex` kept; never built**                            | imported whole, root `src/main.tex`; builds                                |
| Two papers sharing `figures/` and `refs.bib`                                             | **each without them, "outside every paper"**                     | a reader keeps its layout and a copy, noted                                |
| An arXiv source: `main.bbl`, no `.bib`                                                   | **the `.bbl` dropped as build output; failed with no reason**    | kept, and said to be ready-made; builds                                    |
| `.tikz`, `.pgf`, `.pdf_tex`, `.dat`, `.lua`, a font                                      | **dropped as "not a file type a paper uses"; never built**       | kept; builds                                                               |
| `.svg`, `.gif`                                                                           | dropped as not a type a paper uses                               | dropped: convert it to PDF or PNG                                          |
| The `.tar.gz` arXiv gives; a gzipped `.tex`                                              | **"not a readable ZIP file"**                                    | said what it is (the `.tar.gz` is read since: see "A tar archive imports") |
| `\documentclass` in a file the root reads                                                | **refused, with no way on**                                      | refused: put `\documentclass` in the main file                             |
| A Latin-1 root                                                                           | **refused as having no main file**                               | refused: it is not UTF-8, and how to make it so                            |
| A root named `my paper.tex` or `résumé (v2).tex`                                         | **imported, then "could not run this build. Try again", always** | builds                                                                     |
| `paper.tex` with its sections beside `cover-letter.tex`                                  | **the cover letter taken as the root**                           | `paper.tex`                                                                |
| BibTeX finding no `.bib`, style or `\bibliography`                                       | **"failed without saying where"**                                | says which                                                                 |
| One paper in a folder, as a Git host gives it                                            | named after the folder ("src")                                   | named after the ZIP                                                        |
| A Git host's wrapping folder; an Overleaf export; a macOS ZIP; BOM, CRLF, accented names | built                                                            | the same                                                                   |

- **What was wrong.** The importer took the folder holding a root as the paper and left the rest
  out, though LaTeX reads `../` freely. It treated every `.bbl` as something a build makes again,
  though arXiv ships one in place of the `.bib`. Its list of wanted file types stopped at the
  common ones. It read only ZIPs and said nothing useful of anything else. The build refused any
  root name that was not plain letters, digits and dashes, and said to try again. And BibTeX's
  own sentences were never read.
- **Now** (`packages/server/src/archive.ts`, `import.ts`; `apps/workers/src/compile.ts`): a paper
  whose root is in a folder, with usable files beside it, is imported whole. A `.bbl` is kept when
  the archive has no `.bib`, and latexmk runs BibTeX only where a `.bib` exists (`-bibtex-cond`,
  in the downloaded manifest too). The types TeX reads are wanted; pictures it cannot use are
  dropped with what to do. Gzip and tar are known by their first bytes. The root goes to latexmk
  as `./name`, with no shell anywhere; a name that begins with `-` is built from its folder. Of
  two roots, the one that brings in more files is taken. BibTeX's missing file, style, data and
  citations are said. A one-paper archive is named after the ZIP.
- **Held by** service tests of each archive above and a unit test of the three layouts; real
  builds of the root in a folder, the arXiv source, a `.tikz` paper, and the two awkward names;
  unit tests of each BibTeX sentence; and a browser test of the root in a folder. Each failed on
  the old code.
- **Not changed:**
  - A `.tar.gz` was refused with a sentence, not read. It is read since (see "A tar archive
    imports"); a gzipped single file is still refused.
  - Files shared between papers are copied only into a paper that reads them (`../`,
    `\graphicspath`, a `.sty`, `\bibliography`); a paper that reads none is as before. A copy is its
    own: a change to it does not reach the other papers. A paper reading a file inside another
    paper's folder is as before, a `paperweave-review.json` in a reading paper's folder has
    folder-relative paths and does not match, and a shared file is not linked between papers.
  - A root whose name begins with `-` and that has a bibliography does not build: BibTeX takes
    the name for an option.
  - A kept `.bbl` is shown as a file that cannot be edited, and cannot be renamed by hand.
  - An `output.pdf` of the paper itself is kept as one of its files.
  - In an archive of several papers, a `.bbl` is dropped if any of them has a `.bib`.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## What a download holds

- **What was tried**, with a probe: each of the three ZIPs (plain, with review data, with a
  toolchain manifest) unpacked outside the app and built there, beside the app's own build and
  "Check before submitting"; the manifest's command run as written; the names inside the ZIP read
  by other tools; and the names the browser saves downloads under.

| Case                                                                  | Before                                                              | Now                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A paper that reads a data file kept back from downloads               | **"Nothing stands in the way"; every ZIP fails to build elsewhere** | a problem: it reads the file, and what to do                      |
| The same, at the download links                                       | **nothing said**                                                    | "Not in these downloads: data.csv (marked as data to keep back)." |
| The review-data ZIP of that paper imported again                      | **a paper that cannot build, with nothing said missing**            | the same, but said at the download                                |
| An older revision, the data kept back after it was saved              | **its ZIP without the file, with nothing said**                     | the held file named beside that revision's ZIP                    |
| The manifest of a chart whose data is kept back                       | **names the data file, which is not in the ZIP**                    | marks it held, and lists what is held                             |
| "Étude sur les réseaux", "机器学习综述"                               | **`_tude sur les r_seaux.zip`, `_.zip`**                            | the name as it is, with an ASCII one beside it                    |
| Any PDF downloaded                                                    | **`pdf.pdf`**                                                       | named after the paper, and the revision                           |
| The data file included; a CSV never described; an arXiv `.bbl`        | in every ZIP; builds                                                | the same                                                          |
| A root with a space, an accent or in a folder: the manifest's command | builds                                                              | the same                                                          |
| Accented and Chinese names inside the ZIP                             | marked UTF-8; read right by Python                                  | the same                                                          |
| A cover letter, an old draft, an unused 5 MB PDF                      | in every ZIP                                                        | the same                                                          |

- **What was wrong.** A data file can be kept back from downloads, and is by default: the ZIP
  leaves it out. Nothing checked whether the paper reads it, so a paper could be called ready to
  send while its ZIP would not build anywhere else, and nothing at the download said what was
  missing. The manifest named the file without saying it was absent. Download names kept only
  ASCII letters, and PDFs were sent with no name at all.
- **Now** (`submissionChecks`; `packages/server/src/download.ts`; `revisions.ts`; the export
  routes and pages): a paper that reads a held data file is not ready, and says which and what to
  do; the same sentence is beside the dataset. Every place that offers a ZIP names what it leaves
  out, the revisions table for each revision. The manifest marks held chart data and lists the
  held files. Every download is named after the paper, with the name as written and an ASCII one
  for older clients; a PDF shown in the page is sent inline, under the same name.
- **Held by** service tests of each command that reads a data file and of the manifest; a unit
  test of the names; and browser tests of the held file named at the download and of the names
  given to a ZIP and a PDF. Each failed on the old code. The test browser saves any non-ASCII
  name as "download", so for those papers the test reads the header the server sent.
- **Not changed:**
  - Data kept back never leaves, in any download, of any revision, and stays unticked by default:
    a backup ZIP is then not the whole paper, and says so.
  - Every file of the paper goes in, used or not, in the plain ZIP and the review ZIP, which are
    byte for byte as before.
  - `unzip` (Info-ZIP 6.00) on a system whose locale is not UTF-8 shows the accented and Chinese
    names wrongly, though the ZIP marks them UTF-8.
  - A finding about held data names the file that reads it, not the line.
- **The ZIP of only the files the paper uses** (`/revisions/<id>/zip?used`, a third link on
  "Check before submitting", shown when the paper is ready and something is unused). Each build
  that makes a PDF records the project paths TeX opened (`builds.read`, from latexmk's `.fls`;
  `readFiles` in `compile.ts`). The ZIP leaves out a file only when the revision's newest
  succeeded build has `read`, the file is not in it and is not the root, and it is a `.tex`,
  `.ltx`, `.pdf`, `.png`, `.jpg`, `.jpeg` or `.eps` file. `.bib`, `.bst`, `.cls`, `.sty`, fonts
  and data always stay; held data stays out, as in every ZIP, and is not named as unused. With
  `?manifest`, `files` lists only what is in the archive and `unused` lists what was left out.
  "Check before submitting" gives a warning that names the first ten unused files and how many
  more; the paper stays ready. Same permissions as every ZIP (`project.export`).
  - **Limits.** A revision with no succeeded build answers `not_found`; one whose build did not
    record `read` (built before this, or a build that ran no TeX) leaves nothing out. `read` is
    taken only from a TeX run of that build: a warm build starts with the `.fls` the last one
    left, so it is ignored unless latexmk ran TeX (`passes` above zero). A cache hit copies
    `read`; builds cached before this are not reused (the cache tag changed). It is what TeX
    opened in that build, so a file read only under another condition (a changed
    `\includeonly`, another compiler, a date) may be missing from the ZIP. A file named by a
    macro and opened by a program other than TeX (a shell-escape tool) is not seen.
- **The build's `.bbl` in that ZIP.** A venue such as arXiv runs neither BibTeX nor Biber, so
  the ZIP of only the files the paper uses (`?used`, and only it: the plain ZIP, the review ZIP
  and their manifests are byte for byte as before) also holds the `.bbl` the build read.
  Migration 0035 adds `builds.bbl_digest`. The worker stores the blob only when a PDF was made,
  `<root minus .tex>.bbl` is in `read`, and the file is not empty and under 5 MB; so the empty
  stand-in `pw_bbl` writes for a missing `.bbl` (`compile()` does not return it) and a `.bbl` a
  warm build kept that TeX no longer reads are never stored. A cache hit copies `bbl_digest`
  (the cache tag is now `...-madebbl`, so older builds are rebuilt). It is the revision's newest
  `succeeded` build, the row that decides `unused`, that is asked, for that revision and that
  paper; any other build is ignored. Reading the `.bbl` is as for the ZIP: `project.export`.
  - **Name and place.** Beside the root: `paper/main.tex` gives `paper/main.bbl`. When the
    revision already has a file of that name, that file is kept and nothing is added (one entry,
    its bytes); the same when a folder of that name stands in the way. With `?used&manifest` the
    manifest gains `bbl: {path, sha256, format}` when the archive adds one. `format` is the
    biblatex `.bbl` version read from its header (`bblFormat` in `bib.ts`), null for a BibTeX
    `thebibliography`. Biber's header, seen in a sandbox build (biber from the image), is
    `% $ biblatex bbl format version 3.2 $` under `% $ biblatex auxiliary file $`.
  - **Check before submitting** gives two more warnings. For a Biber `.bbl` it says a venue with
    another biblatex version will refuse the file. If the revision's own `.bbl` differs from the
    one the build read (BibTeX had made a new one from the `.bib` files), it says the PDF was
    built from another bibliography; the ZIP keeps the paper's own file. The link to the ZIP is
    shown when the paper is ready and a file is unused or the build has a `.bbl`.
  - **Measured.** A BibTeX paper gives `\bibitem`; a Biber paper the header above; a paper with
    no bibliography, or one that names a `.bib` it lacks, none; a ready-made project `.bbl` with
    no `.bib` comes out as the project's bytes. A paper built from that ZIP with its `.bib`
    deleted shows its references and no `[?]`. `checkBlobs` counts `bbl_digest` as referenced.
  - **Limits.** A ZIP that holds a `.bib` and this `.bbl` is read by our own import with the
    `.bbl` set aside (it is build output there), as for any paper with a `.bib`. A `.bbl`
    that only some other condition makes TeX read (another date) may differ from the venue's.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## The emails

- **What was tried**, with a probe: every email the product sends, with the mail service
  running and paused (so that it takes the connection and says nothing), a page closed in the
  middle, one person mentioning another again and again, the link in each email followed signed
  in and signed out, and odd paper names.

| Email or case                                                      | Before                                                    | Now                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A sign-in link while the mail service hangs                        | **30 s with nothing said; then blamed the address**       | under 20 s: "the email service did not answer"                                                     |
| An invitation while it hangs                                       | **30 s, the button still live**                           | the button waits once; ends within seconds, taken back                                             |
| A comment mentioning two people while it hangs                     | **60 s busy, though the comment was saved: posted twice** | answers at once; the emails go after                                                               |
| One reviewer mentioning the owner in 50 comments                   | **52 emails**                                             | 60 an hour, then "Your comment is saved. No more emails will be sent for your mentions this hour." |
| The link in a mention or reply email                               | **the file; signed out, not even the comments**           | the comment itself, in view and marked, resolved or not                                            |
| The link to a comment that has gone                                | the file, with nothing said                               | "The comment this link was about is no longer here."                                               |
| A paper name with line breaks                                      | **accepted, and its lines in other people's emails**      | refused; names already there are put on one line                                                   |
| A sign-in link used twice, or expired                              | **"INVALID_TOKEN" on the page, or nothing**               | "That sign-in link has been used or has expired."                                                  |
| The same person mentioned twice; oneself; someone not on the paper | one email; none; refused                                  | the same                                                                                           |
| A link to a file since renamed                                     | opens it                                                  | the same                                                                                           |

- **What was wrong.** The mail library was given no time limits, so a mail service that
  accepted the connection and then said nothing held each request for 30 seconds, and a comment
  with mentions waited for each email in turn before it answered, though it was already saved.
  Nothing limited mention emails. Their link named the file, and the part that named the
  comments was lost through sign-in. A paper's name could hold line breaks, and an email
  carried them.
- **Now** (`sendEmail` in `apps/web/lib/server.ts`; `threads/mentions.ts`; `threads.ts`;
  `Threads.tsx`; the sign-in page and form; `paperName` in `projects.ts`): the mail connection
  gives up within 10 to 15 seconds. A comment answers first, and its emails go after
  (`after()`), all at once. A person's mention emails are counted over the last hour from what
  their comments mention, and past 60 the comment is saved and no email sent. The link names the
  thread, sign-in keeps it, and the panel opens to it and marks it. A paper's name is one line.
  A sign-in that fails says whether the service or the limit refused it.
- **Held by** browser tests of the link signed out and in, resolved and gone; tests with the
  mail service paused, where a comment answers within 5 seconds and exists once and a sign-in
  fails within 20 with its sentence (three runs each); a browser test of a used link; service
  tests of the limit; and a unit test of the name. Each failed on the old code.
- **Not changed:**
  - An email that fails while the service stays down is lost, not sent again later.
  - A link to a file since deleted shows "Nothing here".
  - Nobody is emailed when a thread they started gets a reply without a mention, their proposal
    is decided, their role changes, they are removed, or their invitation is accepted.
  - The invitation email does not name the paper (see "Someone coming onto a paper").
  - Mentions past the limit still count, so a person who keeps on stays limited until an hour
    after their last comment.
  - Links emailed before this change land on the old error for the 15 minutes they last.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

## Large files past a hosting limit

- **Why.** On Vercel a function takes and gives at most 4.5 MB, except a streamed answer
  (`docs/deploy.md`). A ZIP to import, a file to add, a revision's PDF or ZIP: any of them can be
  larger, and each went through the web app whole.
- **Now:**
  - **Uploads over 4 MB go to the store.** The browser asks `POST /api/uploads` for a link
    (`startUpload`), which checks who is asking and the size, and gives a signed PUT that lasts ten
    minutes and takes only that many bytes. The file goes to the store under
    `tmp/<person>/<id>`; the import or the add then names the key, and the server checks its size
    before reading it, runs the import or the add as before, and deletes it. Only the person who
    asked can use a key. What is left is swept after a day by the workers. A smaller file, or a
    form sent without scripts, goes the old way. The PUT is an `XMLHttpRequest`, which reports
    progress; it sets no header, so the store's CORS needs are those of the `fetch` it replaced.
  - **Downloads.** A revision's ZIP and the paper's ZIP are streamed, with the same bytes as
    before. A PDF over 4 MB is answered, after the check of who may see it, with a redirect to a
    signed link that lasts five minutes and carries the file's name. A picture in the visual
    editor and a chart's PNG over 4 MB are answered the same way (`pictureDigest` and
    `chartPngDigest` give the digest after the permission check; `sendBlob` decides), with the
    type signed as `image/png` or `image/jpeg`. The page's policy names the store in `img-src`.
  - The store's address as browsers reach it is `S3_PUBLIC_ENDPOINT`, and the page's content
    policy allows it. The store must allow the web app's origin (CORS); `infra/compose.yaml`
    sets that for local work.
- **Held by** service tests (a link, then an add or an import, through the store; a size over the
  limit refused unread; the object deleted after success and after failure; an outsider, a viewer
  and another person refused; the sweep; streamed bytes equal written bytes; signing tried against
  a store that checks signatures) and a browser test that imports a 6 MB ZIP and adds a 5 MB file
  with no request to the app over 4.5 MB, and downloads each large thing. For pictures it
  redirects a 6 MB picture and a 5 MB chart PNG to the store with a signed address (5 minutes,
  `image/png`, equal bytes), checks the page policy's `img-src`, shows both in a browser (the
  editor's picture and the chart page's, each `naturalWidth` 8), and keeps a small picture sent
  from the app with its `etag` and a 304. An outsider gets 404 and no `Location` for both. A
  PNG followed by 6 MB of padding decodes in Chromium. Without the `img-src` change the browser
  blocks the redirected image; without the routes' change the answer is a 200.
- **Cost of the picture change:** each picture request asks the store for the size first (one
  `HEAD`), as a PDF does. A picture over 4 MB is downloaded again on each page load, because
  the redirect is `no-store` and each load gets a new address; within a page the browser reuses
  it by the app's address. The route's `nosniff` header is not on the large
  answer; the store answers with the signed type. (The sandbox policy was not on the small
  one either until the entry "What the picture routes answer with".)
- **Not changed:** the streamed ZIP still reads its files into memory first. Nothing here was
  tried on Vercel itself, pictures included.
- **How it was made.** Written by an agent from a plan made with the Vercel documentation;
  checked here.

## With the database a long way off

- **What was tried**, with a probe: a second copy of the web app whose every message to Postgres
  and to the store went through a proxy that held it 25 or 75 ms each way (a round trip of 50 or
  150 ms), as when the web app runs on Vercel and the database on the owner's machine. The sync
  server and the workers stayed beside the database, as they would. The proxy read each query, so
  the counts below are measured.

| Case, at 50 ms (150 ms)                                | Measured                                                 |
| ------------------------------------------------------ | -------------------------------------------------------- |
| The list of papers                                     | 0.34 s (0.94 s) to the first byte; 6 round trips         |
| A paper's page, 3 files; 31 files, all edited          | 1.26 s (3.26 s); 1.70 s (5.08 s): 75 and 182 round trips |
| An editor left open and shown, a minute                | about 290 round trips, whatever the distance             |
| A hidden editor, a minute                              | none                                                     |
| Checks before submitting, 31 edited files              | 1.69 s (4.81 s)                                          |
| Save a revision; download the ZIP; 31 edited files     | 6.1 s (17.6 s); 6.6 s (17.9 s), one file after another   |
| Post a comment; accept a proposal                      | 0.59 s (1.70 s); 0.80 s (2.31 s)                         |
| **A restore of 31 edited files: typing held, longest** | **12.8 s (37.3 s)**; the restore 19.7 s (54.8 s)         |

- **First change: a restore holds typing only while it writes.** It read each file's history,
  worked out its edit and appended it one file at a time with every file of the paper held. Now
  (`restoreRevision`, `appendUpdates` and `notifyEdits` in `packages/server/src`) it reads the
  revision and every history first, holding nothing, and works out the edits. Holding the files,
  it checks that each is still as it read it, appends every edit in one statement and tells the
  sync server in one more; a file someone typed in meanwhile is worked out again on its own.
  Typing is now held at most 0.8 s (3.9 s), and the restore takes 7.9 s (22.4 s); 23 statements
  are made while the files are held, where there were 171.
- **Held by** service tests: an edit to another file during a restore, with a store slowed to
  50 ms a call, returns within 1.5 s; the statements made while the files are held stay under 40;
  and a letter typed in the moment between the reading and the holding is kept in the revision
  saved just before, and only that file is worked out again. Each failed on the old code. The
  existing tests of restoring, the fault suite and the attached threads and proposals are
  unchanged and pass.
- **Second change: a page reads each file once.** A paper's page asked fifteen things at once,
  and each that needed the files read every file's history again: four times over, through the
  labels, the citations, the citation checks and the held data, besides the threads and the
  proposals. Now a page, and the read-only answers its panels ask for, run in one scope
  (`withScope` in `packages/server/src/scope.ts`) in which the paper's files, their histories and
  the reader's role are read once and shared. The role is shared, not the permission: each action
  is still checked against it, and nothing done inside a transaction or with a lock uses the
  shared copy. The histories of all the edited files are read in one statement. The checks
  before submitting run their parts side by side.
  - A paper's page, 31 edited files: 0.63 s (1.78 s) to the first byte, and 27 round trips,
    where it was 1.58 s (4.65 s) and 180. With 3 files: 1.07 s (2.04 s).
  - Checks before submitting, 31 edited files: 0.40 s (1.10 s), and 14 round trips, where it was
    1.63 s (4.95 s) and 113.
  - **Held by** service tests that count the statements of the page's reads (25 for 30 edited
    files, where there were 168) and of the checks (11, where there were 106); that a viewer is
    still refused a change once their role is shared; and that nothing is shared between two
    requests or into a transaction. Each failed on the old code.
- **Third change: an open editor asks for little.** Shown, it asked for the latest build every
  2 seconds and for the comments and the proposals every 5, each answer starting with the
  sign-in, the reader's role and the file's history. Now (`latestBuilds` in
  `packages/server/src/builds.ts`; `apps/web/lib/builds.ts`; `BuildPane.tsx`): the build pane asks
  every 5 seconds, and every 2 only while a build is waited for. Its answer checks who is asking
  in the same statement and carries two marks, one that moves when any file changes and one when
  any thread or proposal does; the comments and proposals panels read their lists only when a
  mark has moved, and at once after their own actions. A change by someone else still shows
  within one poll.
  - One editor left open and shown, a minute: 60 round trips, where it was 273; three: 180, where
    it was 781. Hidden: none, as before.
  - **Held by** a service test that a poll is two statements (it was four) and that the mark moves
    for every kind of change to a thread or a proposal and not otherwise; and a browser test of an
    idle editor's requests over 30 seconds. Each failed on the old code. Three browser tests that
    waited for the panels' own polling now wait for what replaced it.
- **Fourth change: many files at once.** Saving a revision read each edited file's history and
  wrote it to the store one file after another; a ZIP read each file from the store one after
  another, and so did a comparison of two revisions. Now (`mapLimit` and `readAhead` in
  `packages/server/src/batch.ts`; `revisions.ts`; `archive.ts`) the histories are read in one
  statement and the store is asked sixteen at a time, with the ZIP still written in the same
  order and to the same bytes, and streamed as its files arrive.
  - At 50 ms, 31 edited files: saving a revision 1.75 s, where it was 5.4 s; the ZIP 1.49 s,
    where it was 6.79 s. A comparison of 10 changed files: 0.57 s, where it was 1.56 s.
  - **Held by** service tests with a store slowed to 30 ms a call: saving a revision makes 3
    statements (it made 32) within 0.6 s; a revision's ZIP, the paper's ZIP and a comparison
    each within a bound the old code missed by three times or more; never more than sixteen reads
    at once; and the ZIP's bytes the same as before, streamed or not. Each failed on the old code.
    One older test of a restore waited for the first read of the files' histories, which saving a
    revision now makes too; it waits for the second.
  - **Not changed:** a file missing from the store part way through a streamed ZIP now ends the
    download where it is, where it used to fail before anything was sent.
- **Fifth change: the sign-in is kept in the browser for a minute, and the pool is a setting.**
  Every request looked the sign-in up in the database, two round trips before anything else.
  Now Better Auth keeps it in a cookie for 60 seconds (`auth.ts`), renewed wherever an answer can
  set a cookie (`currentSession` in `apps/web/lib/server.ts`), which an open editor's poll does
  every few seconds. A sync ticket is always looked up afresh, and signing out clears the cookie
  at once. `DATABASE_POOL_MAX` and `DATABASE_POOL_IDLE_MS` size the pool (`docs/deploy.md`
  suggests 3 and 5000 on Vercel behind a pooler).
  - One idle editor, a minute at 50 ms: 35 round trips and no sign-in lookups, where it was 59
    with 24. Three: 98, where they were 180.
  - **The cost:** a session ended from another device keeps working in this browser, for pages
    and actions, for up to a minute. Editing stops at once: the sync server hears of the ended
    session from the database. Taking someone off a paper, or changing their role, is immediate.
  - **Held by** service tests that a second request inside the minute makes no sign-in
    statements, that the cookie is renewed after the minute, that signing out clears both
    cookies, and that the pool takes its settings and refuses bad ones; and a browser test that
    after signing out the next page asks for sign-in. Each new one failed on the old code.
- **Left:** a person who only reads pages, never opening an editor, still looks the sign-in up
  again once the minute is up, since a page cannot set a cookie. Nothing here was run on Vercel.
- **How it was made.** Probed and planned by agents, written by another, checked here.

## When an email cannot be sent

- **An invitation** whose email could not be sent ended in an error page, and left an
  invitation behind that nobody could use (its link is only in the email) and that counted
  against how many its sender may send in an hour. It is now taken back, and the paper's page
  says the invitation could not be emailed (`withdrawInvitation`; `inviteAction`).
- **A sign-in link** that could not be sent was still counted against the ten an hour for
  its address, so someone trying again while the mail was down could find themselves shut
  out for an hour once it was back. It is no longer counted (`forgetSignInLink`).
- **A mention** already went through whether or not its email did.
- Service tests hold what the server does in both cases. The pages were checked once by
  hand with the tests' mail catcher stopped: the paper's page said the invitation could not
  be emailed, the sign-in form said the link could not be sent, and with the mail back the
  same person could invite. No test is kept for that: it means stopping a service that the
  other tests are using.

## When a page cannot be made

Found by stopping the object store under a running service, by hand.

- **The framework's own error page was refused by the pages' content policy**, as its
  "not found" page had been: it brings a style sheet of its own. The service now has its own
  page for this (`apps/web/app/error.tsx`, and `global-error.tsx` for a failure in the frame
  every page shares). It says the page could not be shown, that the fault is the service's,
  and that what was saved is still saved.
- **"Try again" asks the server again.** The framework's own way of trying again draws the
  same failure without asking; the button loads the page afresh.
- **What a person sees with the object store stopped:**
  - typing into a file that is already open is still saved (edits go to the database);
  - the paper's page, and any page that reads the paper's files, fails at once (a tenth of a
    second) with the page above; so does opening the editor, since it reads the paper's
    macros;
  - the question about builds every two seconds is still answered.
  - With the store back, "Try again" shows the paper.
- **Checked once by hand**, the audit and the narrow-window check included. No test is kept:
  nothing in the product fails on request, and stopping a service under the other tests is
  not something a kept test should do.
- **The sync server killed and started again under an open editor**, by hand: "Offline.
  Nothing is waiting to be saved", then with something typed "Offline. Your edits are waiting
  to be saved", and "All edits saved" 2.8 seconds after the server was back, with nothing
  lost. Nothing needed changing. The database stopped is the next section.

## When the database is lost for a while

Found by restarting the database under a running service, by hand. This was the worst of the
faults found by taking a service away.

- **What was wrong.** The sync server and the build worker each keep one connection open to
  the database to be told things at once. Neither had anything listening for that connection
  failing, and in Node a failure nobody listens for ends the process. So a restart of the
  database, or anything between that cut a quiet connection, **ended the sync server**. Every
  open editor then said "Offline" until someone started it again. The same went for a pooled
  connection lost while idle, in every process.
- **Now** (`listen` and `connect` in `packages/server/src/db.ts`):
  - a lost connection is logged, not fatal; the pool makes a new one when next needed;
  - the connection that listens is made again, and then the sync server looks up everything
    it could have been told meanwhile: what each person on each open file may do, which
    sign-ins have ended, and what each open file's log now holds.
- **And a third way to the same end.** A connection lost while it was out of the pool, in the
  middle of a transaction, was heard by nobody either: the pool listens only to the
  connections it is holding. A build keeps one out for up to a minute. The stop-and-start by
  hand did not hit this, by luck: nothing was in a transaction at that moment. `transaction`
  now hears it, fails the work that was running, and throws the connection away. Two tests
  hold this and the listening connection (`db.sandbox.test`).
- **A second fault behind the first.** An editor that reconnected while the database was away
  was told it could not connect, and an editor takes that as final: "You no longer have
  access". The server now tells it to try again (`TRY_AGAIN`), and the editor does.
- **What a person sees now**, from a database stopped and started by hand: while it is away,
  "Saving your edits…" and the editor still takes typing; once it is back, "All edits saved"
  with nothing lost (after half a minute at first, now within seconds: see below); a role changed afterwards reaches the open
  editor as before.
- **Held by** a sync test that drops every connection to the database at once, makes an edit
  on the server and lowers a role before the server can be listening again, and sees both
  arrive, nobody disconnected and typing saved. The stop-and-start by hand is not kept.
- **Half a minute was the sync library's waiting between attempts**, which grows each time
  one fails, up to thirty seconds. The editor now caps it at five (`maxDelay` in
  `FileEditor.tsx`). After a 45-second outage, by hand: typing was saved within the few
  seconds the database took to say it was ready again.
- **Not looked at:** the web app's pages fail with the service's error page while the
  database is away, as they should; whether every one of them recovers was not gone through.
  While it is away the server's log fills with one line for every question it could not
  answer, about one a second for each open editor.

## Two sync servers on one database

- **What would have happened.** Nothing stopped a second sync server being started against
  the same database, to carry more people, say. A probe did it: what was typed through one
  server was saved and never reached the person on the other, in either direction. Both saw
  "All edits saved". They would have gone on seeing different text until one loaded the page
  again.
- **Now** a sync server takes a lock in the database before it serves (`onlyOne` in
  `packages/server/src/db.ts`). A second one waits and says so. If the connection holding the
  lock is lost, the server asks for the lock again; if another server got it first, this one
  stops.
- **Held by** a test of the lock itself (`db.sandbox.test`), and tried twice by hand with two
  servers. The second said it was waiting, and began to serve when the first stopped. Done
  again on one port with an editor open, as a new version would replace an old one: the
  editor said "All edits saved" throughout the wait, and was saving again 1.4 seconds after
  the old server was stopped, with what was typed either side of that kept.
- **Not built:** two sync servers serving together. The notes said only that structural edits
  would need work for that. Ordinary typing and presence would too.

## Two web apps behind a proxy

- **How it was tried.** Two copies of the web app were started on two ports, with a small
  proxy in front that gave each request to the other copy in turn and passed every header as
  it came. The whole browser suite was run through the proxy.
- **What was wrong.** Importing a ZIP and adding a file to a paper are forms posted to a
  route. Each answered by sending the browser on to an address made from the request's own,
  and behind a proxy that is the address the copy listens on, not the one people use. The
  ZIP was imported and the file was added, but the browser was sent to
  `http://localhost:3102/…`, which the pages' own policy refuses a form to lead to. The
  person saw nothing happen. Thirty-six of the suite's tests failed on it. It had not shown
  before because with one copy and no proxy the two addresses are the same. Any deployment
  has a proxy.
- **Now** those routes send the path alone (`seeOther` in `apps/web/lib/server.ts`), which is
  right wherever the service is reached from.
- **Held by** a browser test that posts to both routes and reads where it is sent
  (`projects.spec`: "a form posted to the site is answered with a path"). It failed on the old code through the proxy, and would have without it: the old answer was a whole address either way.
- **With that fixed, the whole browser suite passed through the proxy**, once: 52 tests and
  some two thousand requests, shared evenly between the copies. So signing in on one copy and carrying on at the other,
  a form drawn by one and posted to the other, and a build asked of one and shown by the
  other all work. The proxy is not in the repository and no test runs this way.
- **A proxy that does not pass the host on breaks every button.** Tried with the same proxy
  changed to put the copy's own address in `Host`, as some do unless told otherwise: each button tried gave the service's "This page could not be shown", and the web app's log
  said "`x-forwarded-host` header … does not match `origin` header … Aborting the action".
  That is the framework refusing a form it cannot tell came from its own page, and it is
  right to. With the outer host passed in `X-Forwarded-Host` the same eight tests passed (signing in, starting and importing a paper, adding files).
  `docs/settings.md` says what the proxy must do.

## What a paper keeps for ever

Nothing is ever removed. That was the plan's promise for what people write, and it also
holds, undecided, for what the service makes.

- **Each build of changed text keeps** a revision, a row for each file in it, the text of
  each file edited since the last one, and the build's PDF, log and SyncTeX file. For the two
  small fixtures that is 100 to 140 KB a build, nearly all of it the PDF. A real paper's PDF
  is ten or more times that.
- **A paper can be built 120 times an hour.** Someone typing with "Compile automatically" on
  builds at every pause. So an hour's writing can keep 17 MB for a paper the size of the
  fixtures, and hundreds of megabytes for a long one with pictures.
- **The same bytes are stored once**, so a build that changes nothing keeps nothing new. But
  nearly every edit changes the PDF.
- A PDF can be made again from its revision: the same inputs give the same bytes with the
  same toolchain image. So the PDFs of old automatic revisions could be dropped and built
  again when asked for, without losing anything a person wrote. Whether to, and after how
  long, is the owner's to decide: it is in the list at the end of this file.
- Not measured: a real paper over real weeks of writing.

## A paper's size, and what a sync ticket opens

Two more of the security review's items.

- **A paper's added files** are held to what an imported paper already was: 2,000 files and
  300 MB in all (`LIMITS` in `packages/server/src/archive.ts`). The count was already checked
  when a file was added; the total was not. A file's size is what it was added with or, for
  text edited since, what it came to at the paper's newest revision (below).
- **A sync ticket names its file.** `/api/sync-ticket` must be asked with `?file=`, and the
  sync server refuses the ticket for any other file.

## Which scripts may run on a page

Built after the security review, which had it as its first open item.

- **Where.** `apps/web/proxy.ts` makes a number for each request for a page and sends the
  policy with it. Next.js reads the number from the policy and puts it on its own scripts.
  The root layout waits for the request, so no page is made ahead of time: one made ahead of
  time could not carry a request's number.
- **A deployment must set `SYNC_URL` for the web app** to the sync server's address. It
  already had to, for the editor to connect; now the policy is built from it too, and an
  editor pointed anywhere else is refused by the browser.
- **A new page that loads something from elsewhere will be refused it.** The browser tests
  fail when that happens (`tests/e2e/helpers.ts`), and the message names what was refused.
  Add it to the policy only if the page needs it.
- **Style sheets are held to the number as well.** The editors add style sheets as they
  start, so each is given the number (`apps/web/lib/nonce.ts`, read from a `meta` element the
  layout writes). A new library that adds a style sheet of its own will be refused until it is
  given the number too; the browser tests fail when that happens, the workbench's included.
- Styles set on a single element are still allowed, and PDFs and ZIPs asked for by address
  keep the plain policy in `next.config.ts`. `docs/security-review.md` says why. A file being
  uploaded skips the proxy too ("At each limit, and one past it"): the proxy would cut it at
  10 MB, and the route draws no page.
- `apps/web/app/not-found.tsx` is the app's own page for an address that leads nowhere or a
  paper that is not the person's to see. The framework's own page brings an inline style sheet.
- In development the policy also allows `eval`, which React uses there to show server errors,
  and style sheets without the number, which the framework's own tools add there.

## What the picture routes answer with

- **What was wrong.** `picture` and `charts/[chartId]/png` set `default-src 'none'; sandbox`
  themselves, but the answers carried the page policy. The first header on an answer wins over a
  route handler's: `next.config.ts` sets one on every answer, and `proxy.ts` replaces it for
  every address its matcher takes. Measured on the built app before the change: both routes
  answered `default-src 'self'; script-src 'self' 'nonce-…' …`.
- **The change.** `next.config.ts` sets `default-src 'none'; sandbox` for those two addresses
  (the last matching entry wins), and the matcher in `proxy.ts` leaves them out. The chart's
  page and `/projects` keep the page policy. The routes keep their own header line, same value.
- **Held by** `projects.spec.ts` ("every answer says how it may be used…": both routes, even
  unsigned-in, and the chart page's policy) and `large.spec.ts` (the small picture's answer).
  Both fail on the old files; with only the matcher changed they still fail, the answer then
  having the plain policy.
- **Not tried on Vercel.** Firefox may show a picture opened in its own tab without its viewer
  styling; `<img>` is not affected.

## Where the others are, in the visual view

- **Why.** A `.tex` file opens in the visual view, where nobody could see anyone else's caret.
  The source editor publishes its caret to awareness only while it has focus, so a person in
  the visual view showed none (or a stale one) to everyone.
- **What is published and drawn.** The visual view writes the same awareness `cursor` field
  (Yjs relative positions in the file's text) whenever its selection or text changes while it
  has focus, and does not write it when unchanged. It draws each other person's caret as an
  empty `aria-hidden` span with their name in CSS (`data-name`), and their selection as
  `.remote-selection`. Nothing is added to the sync protocol or the server. Names and colours
  come from the other person's browser: the colour must be `#rrggbb` (else the first presence
  colour), the name is cut to 80 characters, and neither goes into HTML.
- **Held by** `visual.spec.ts` ("each person sees where the other is, in either view"): the
  caret is drawn after the right word in the visual view, stays there when someone types
  before it, follows arrow keys, is not in the text, a selection across it or `getSelection`,
  shows in the source view, shows the source view's caret and selection in the visual view,
  reaches a reviewer, passes axe, and goes when the person leaves. On the old files the test
  fails at its first check (no caret element).
- **Not done.** A caret in the preamble or inside a formula's source is not drawn. A caret is
  kept at its last place after focus leaves, as in the source view. Names and colours are
  unverified.

## A comment changed or taken back

- **What was wrong.** A typo, a comment on the wrong thread or something pasted by mistake stayed
  for ever, showed to every member and went out in the review-data export.
- **Now.** A comment's author (owner, editor or reviewer) can change its words ("Change", then
  "Save"); the comment then shows "(changed)". Its author or the paper's owner can delete it,
  after a question ("Delete this comment for everyone?"). The owner's right covers imported
  comments and those of people who have left. Migration 0026 adds `edited_at` and `deleted_at`
  to `thread_comments`. A deleted comment keeps its row and `mentions` with `body = ''`, and
  `listThreads` leaves it out, so the paper's page, the marks in the text and the export do not
  carry it. A thread with no comment left is not listed and is not counted by the checks before
  submitting. The review mark in `builds.ts` also holds the latest change or deletion time, so
  other people's panels read again.
  - `editComment` and `deleteComment` in `threads.ts` check that the person is on the paper
    (else `not_found`), may comment, and that the comment is in that thread of that paper and
    not deleted (else `not_found`). Changing is for the author alone, even for the owner.
    `yours` and `removable` on a listed comment only decide which buttons show.
  - An edit form open when its thread is resolved stays, with its words, and says so. The
    note for a reply being written is unchanged. If the comment is deleted meanwhile, the form
    goes and the person is told.
- **Held by** `threads.sandbox.test.ts` (author, owner, other reviewer, viewer, outsider, another
  paper, wrong thread, deleted comment, last comment, mention limit not reset by deleting),
  `poll.sandbox.test.ts` (the review mark), `reviewdata.sandbox.test.ts` (the export) and
  `threads.spec.ts` ("a comment is changed by its author and deleted by its author or the
  owner…": two people, the keyboard alone, axe with the edit form and the question open). On the
  old files each fails: the functions do not exist, and the browser test finds no "Change"
  button. With only `submit.ts` or only `builds.ts` as before, the test of the checks or of the
  mark still fails.
- **Not done.** An edit keeps the comment's mentions and sends no email. The export does not
  carry `editedAt`. No history of an edit is kept. Words in an edit form are lost if the owner
  deletes that comment meanwhile. The emptied row is kept so the mention-email limit cannot be
  reset by deleting.

## A proposal marks only the words it changes

- **What was wrong.** A proposal showed the whole old text struck and the whole new text added.
  Someone deciding on a passage of a few sentences with one word changed had to compare by eye.
- **Now.** `diffWords` in `packages/server/src/textdiff.ts` compares the two texts word by word
  (a word with its `\command`, `0.05` or `thirty-five` is one unit, a run of white space is one,
  any other character is one), with the same algorithm as `diffLines` (both now use one private
  `diffSeq`). White space kept between two changes is marked changed too, so a changed phrase is
  one piece. `Proposals.tsx` strikes only the changed pieces of "Now:" and underlines only the
  changed pieces of "Proposed:". If only spacing or line breaks differ it says so in a note. The
  client imports the file through the new `@paperweave/server/textdiff` export, which has no
  imports, so `pg` stays out of the browser bundle.
- **Held by** `textdiff.test.ts` (one word changed; a phrase as one piece; `0.05`, `\cite` and
  `thirty-five` whole; spacing only; an addition only; too large gives null; random texts join
  back to both inputs) and `proposals.spec.ts` ("a proposal marks only the words it changes",
  axe included). On the old files the unit tests fail (no `diffWords`) and the browser test finds
  the whole sentence in `del`.
- **Not changed.** The paper's page still says "proposes changing X to Y" in short. The revision
  comparison is still line by line. "It now reads" on an out-of-date proposal is shown whole. A
  rewrite that keeps few words is marked in many small pieces. Past about a million cells
  (about a thousand changed words and spaces on each side) the old whole-text display is used.

## Browser tests that failed once in a while

Four browser tests failed once or twice in a full run and passed when run again. Two faults
in the editor were behind them. Both are fixed, and each has a test that fails without its fix.
A fifth, later, was a third fault: the menu below.

### An editor dropped its first connection a second after making it

- **What happened, on every file opened.** The editor connected, loaded the file, and one
  second later dropped that connection and made another. Whatever the server answered in
  that moment went to the connection that was gone.
- **Why.** The sync library says "connecting" while it is still being set up. The editor's
  handler for that reached for the library's own object, which did not exist yet, and failed.
  The library took the failure for a failed attempt to connect, and a second later tried
  again, replacing the connection that was working.
- **Now.** The handler is added once the object exists (`FileEditor.tsx`). A browser test
  opens a file, types across the first second, and checks there was one connection and it is
  still open. It fails with the old code.
- **What it explains, and how surely.** Three of the failures were a step that needs an
  answer from the sync server, made about a second after an editor opened:
  - `figures.spec` (twice, once in CI): a figure was inserted and the window said the edit
    could not be made. The editor waits eight seconds for the answer to a structural edit.
  - `revisions.spec` and `editing.spec` (once each): the editor said "Saving your edits…"
    for five seconds, though in one case the text was already on another person's screen.
- **Shown, by aiming at the moment.** With the old editor code put back and a throwaway test
  that acts at a chosen time after the connection is made:

  | Old code                                                                    | Result                                                    |
  | --------------------------------------------------------------------------- | --------------------------------------------------------- |
  | "Emphasise" pressed 970 to 990 ms after connecting                          | said "could not be made" 6 times in 12 (4 of 4 at 980 ms) |
  | "Emphasise" pressed at any of eight other moments from 600 to 1400 ms       | 0 of 32                                                   |
  | A key typed so that "is it saved?" is asked 978 to 1004 ms after connecting | "Saving" stuck 6 times in 60, all asked at 978 to 982 ms  |

  | Current code, same moments                           | Result  |
  | ---------------------------------------------------- | ------- |
  | "Emphasise" pressed 960 to 1000 ms after connecting  | 0 of 20 |
  | "Is it saved?" asked 978 to 1004 ms after connecting | 0 of 60 |

  So both kinds of failure come from the dropped connection, and both are gone. What is still
  an inference is that the particular runs that failed were hit by it: their output shows the
  same symptoms at about the same moment, and nothing else was found.

- **For a person** it was a structural edit that now and then said it failed in the first
  second after opening a file (and may have been made all the same), or a "Saving…" that
  stayed until the next keystroke.

Changed on the way, and worth keeping:

- The editor asked the server once whether it had the latest edits, and asked again only if
  told no. It now keeps asking, less and less often, until the answer is yes (`watchSaved` in
  `packages/bridge/src/saved.ts`, unit-tested on a fake clock). A lost answer costs a second.
- A structural edit whose answer has not come in three seconds is asked for once more, under
  the same key. The server makes the edit if it has not and says so if it has, never twice.
  Before, a lost answer was reported as a failed edit though the edit might have been made,
  and trying again could make it a second time. A browser test loses the answer on purpose.
- The sync server logs `the sync server did not run for <n> ms` when kept from running for
  over a second, and `command on <file> took <n> ms` for a structural edit over two.
- The browser says `edit not made: <why>` in its console, and the tests print it.

### An editor took typing before its file had arrived

- **What happened.** `charts.spec` opened the data file and typed a row at once. The editor
  was still empty, so the caret was at the top: the row landed above the heading row and
  became the heading row. No column was a number any more, and the chart could not be drawn.
- **Seen in the test's own output:** the columns read "2024-03-05 (text), 44 (text), Field
  (text)".
- **Now.** Both editors take no typing until the file has arrived. A browser test holds the
  connection back and checks that nothing typed early gets in. `charts.spec` and `data.spec`
  wait for the file before they type.

### A menu that went back to its first item

- **What happened.** In the visual view, the menu that opens on a right click can be worked
  with the arrow keys. Whenever the editor drew itself again while the menu was open, the
  first item took the keyboard back. From the code, the editor draws itself again when
  anyone in the file arrives, leaves or moves their caret, so with a second person at work
  it could happen at any moment. Seen when the same person opened the file a second time and closed it. With the fix in, the menu was worked with the arrow keys while a second tab typed steadily, three times, and kept its place.
- **Why.** The menu took the keyboard in an effect that ran again each time it was handed a
  new function for closing, and the editor hands it a new one every time it draws.
- **How it showed.** The browser test of the menu presses the down arrow and looks at the
  second item. Once, in a full run on 19 November, the editor drew itself again in between.
- **Now** the menu takes the keyboard when it opens and at no other time (`EditorMenu` in
  `Tools.tsx`). The test opens the file a second time while the menu is open, which failed on the old code.

### Looked at and ruled out

- The machine running short: 11 GB of 16 free, load under 2 on 4 cores; little CPU taken by
  the host and no I/O stall of note in a sampled run.
- The database: no lock wait of over a second and no slow statement in the runs that failed
  after logging was turned on.
- The object store and the grammar server: answered in milliseconds straight after the
  service tests.
- Pages left open by earlier tests. They were left open, about a dozen extra connections by
  the fourteenth test, and are now closed when the next test starts. A test failed after that
  change, so it was not the cause.
- Saving a revision holding every file while it talked to the object store (below). Real, and
  removed. The database logged no wait in the later failing runs; the earlier ones were
  before the logging.

### For next time

- **Time a page from inside the page.** A click or a wait made by the test, on a page with
  thousands of elements, can take the test tool many seconds by itself. Twice that was
  written down as the page being slow: an editor "taking 28 s to open" and a file "taking
  15.6 s to open". Read the page's own clock (`performance`), or click and wait inside one
  `page.evaluate`, and profile before believing a large number.

- When a browser test fails in CI, the run now keeps `test-results/` for a week as an
  artifact named `browser-test-results`: for each failed test, what its page showed.
- **Keep the whole output of a full run.** One failure was lost to a filter that kept only the
  line saying it had failed. The explanation came from the first failure whose output was kept.
- Failures only in full runs, never alone, were a matter of timing: a step landing in one
  particular instant. More runs of the test alone would not have found it; tracing what the
  page did on the wire did.
- Locally, the database logs lock waits and statements over 150 ms. That is a setting of the
  local container (`alter system`), not of the repository.
- **Stop the build worker too before a local browser run.** Outside CI the tests reuse the
  servers already running, the build worker among them. Killing only the web server leaves a
  worker running the code from before: a change to how builds are read is then not tried at
  all. Stop `next start`, the sync server and the worker (`pkill -f '@paperweave/workers'`).

### A sync test that failed now and then: a port WebSocket clients refuse

- "What someone typed as they left reaches whoever opens the file next" failed twice, on 19
  November and on 20 November, with its client "connecting" and never closing. The second time
  the message said the server accepted connections on 127.0.0.1:5060.
- **Cause.** The file picked a base port from 4200 to 4699, and this test starts a server 700
  above it (another, 600). Bases 4360, 4361, 4460 and 4461 put that server on 5060 or 5061, the
  SIP ports, which are on the web's list of ports a WebSocket client will not connect to. Node's
  `WebSocket` follows it: it sends nothing, and the client waits for ever. About one run in 125.
  A server on 5060 with a plain WebSocket and the editor's own provider pointed at it: no
  connection arrived, and the provider stayed "connecting"; on 5059 both connected. Forcing the
  base to 4360 failed the test every time, and 4450 passed.
- **Now** the base is 4200 to 4349, so no server any test starts is on a refused port; the
  failure message says when a port is one of them; and `docs/settings.md` warns against such a
  `SYNC_PORT`. It had nothing to do with the database connection work of 19 November.

### A service test that ended other tests' connections

- **What happened.** On 19 November, in one run of the whole service suite, two test files
  failed before any of their tests ran: "Connection terminated unexpectedly" while each was
  setting up its database. Every run before it that day had passed.
- **Why.** The test of only one server doing a job (`db.sandbox.test`, added that day) ends
  the connection that holds the job's lock, to see the job taken back. It picked its victims
  as every connection holding a lock of that kind, on the whole database server. Setting up
  a test database holds one too. Test files run side by side, so now and then another file
  was setting up at that moment.
- **Now** it ends only connections in its own database. Shown directly: a connection holding
  such a lock in another database is matched by the old query and not by the new one, and
  lived. Three whole runs then passed, which says little by itself, since most runs passed
  before.
- **It would also have reached past the tests.** Run on a machine where the real services
  were up, the old query would have ended the sync server's hold on its job. Not seen
  happening.
- **It does not explain the two failures below.** The sync test's came before this test
  existed, and the browser test's was in a run of the browser suite, where no service test
  runs alongside.

### A browser test that failed once and is not explained

- On 19 November, in one of four runs of the whole browser suite on the branch that made a
  second sync server wait, "an editor whose sign-in has ended says so…" failed where its
  person signs in again: the form said the link could not be sent. Four runs of that test
  alone and two more of the whole suite passed.
- The server logged nothing, which rules out the mail and the database: both are logged. It
  leaves a refusal for asking too often, by the sign-in library (five a minute for a client)
  or by the limit of ten an hour for an address. That person had asked twice.
- In two whole runs with every refused sign-in request printed, the only ones were the two
  that the test of the hourly limit expects.
- The sign-in step of the browser tests now fails with the server's own answer, status and
  words, if a link is not sent. The page says only that it could not be sent.

### A browser test that depended on a triple click

- **What happened.** On 21 November, in a whole run, `insert.spec` "after an equation is put on a
  line of its own, typing carries on after it" found the table inserted in the middle of the
  last paragraph (the line before it read `NEXTSecond`), not after the paragraph. The same test
  passed 9 of 9 on its own.
- **Why.** The table goes in where the caret is, as an equation does. The test clicks after
  "Second" and expected the table after the paragraph. The test's third click in a few seconds
  lands within 10 pixels of the second, because each insertion leaves the line in nearly the
  same place. ProseMirror counts clicks that are under 500 ms apart and near each other as a
  double and then a triple click, and a triple click selects the paragraph; the table then goes
  after the selection. When the clicks are further apart in time, the click is a caret
  mid-paragraph and the table goes there. Logged at the moment of the insert: caret 39 to 39
  (mid-paragraph) in every failure, selection 29 to 50 (the paragraph) in every pass, with 560
  and 360 ms between the clicks in a failing run.
- **Measured** (`--repeat-each 30`, one worker): 0 of 30 failed unthrottled;
  with `E2E_CPU_THROTTLE=4`, 24 of 30 failed on `origin/main` and 22 of 30 on the commit before
  PR 133. With the CPU busy on all cores (8 loops on 4) none failed. The caret drawing added in
  PR 133 is not involved: its redraws are not selection changes, and the selection at the insert
  was the click's.
- **Now** the test presses End after the click, so that the caret is at the end of the paragraph
  however fast the clicks are. With `E2E_CPU_THROTTLE=4`, 40 of 40 pass. `E2E_CPU_THROTTLE=<n>`
  slows every page the tests open by that factor (`person` in `tests/e2e/helpers.ts`).

### The whole browser suite with the pages slowed down

- **What was tried.** On 21 November, every browser test with `E2E_CPU_THROTTLE=4`: 102 ran,
  101 passed, in 20 minutes. Only the first page made by `person` was slowed; a second page a
  test opens itself ran at full speed.
- **Found.** `files.spec` "a paper is started from nothing…" failed 7 of 10 slowed, 0 of 10 at
  full speed. Just after adding a file, the page comes back from the form's post with its words
  already drawn, and the test dropped a file on it at once. The handler that stops a dropped
  file from being opened in place of the app (then `Dropped.tsx`) was put on once the page's script
  has started, so the drop came before it: neither `dragover` nor `drop` was taken. Waiting
  five seconds first, it passed 10 of 10.
- **Now** the drop is taken from the first byte of the page, not once its script has started
  (see "Before the page's script has started"), and the test drops at once, with a plain
  `expect`. Slowed, 10 of 10 pass (7 of 10 failed before). (First fixed by asking again until
  the drop was taken.)
- Not changed: the editor, which does what its tests say (an insert goes at the caret, or after
  the selection).
- **Every page slowed.** Now every page of a person's context is slowed, the first and any a
  test opens with `context.newPage()` (about 15 places in 11 specs), and a popup the app opens.
  `newPage` returns only once the page's rate is set, while it is still blank, so the test never
  drives an unslowed page. Unset, nothing changes.
- **Result with every page slowed (4 times).** 104 ran, 104 passed, in 20 minutes; nothing new
  failed. At full speed, 104 of 104 pass (14 minutes).

### A keyboard test that never went to the start of the text

- **What happened.** On PR 145, `keys.spec` "a comment is changed, replied to and deleted, and a
  proposal changed…" failed with "Tab never reached Start thread"; with `E2E_CPU_THROTTLE=4`
  and `--repeat-each 10 --workers 1`, 6 of 10 failed (focus was on "Text to add at the caret",
  the proposal made from an empty selection). 8 of 8 passed at full speed.
- **Why.** The test's `select()` went to the start of the text with Ctrl+Home. In the headless
  Chromium the tests run in, Ctrl+Home does nothing in the editor (Home alone, and ArrowUp, do).
  The first `select(1)` worked only because the caret was already at the start; `select(3)`
  began where the last selection ended (the end of "Latency"), and three ArrowDowns from there
  reached the closing `\end{document}` block or the end, where seven Shift+ArrowRight keys select
  nothing or something else depending on how far the page had got. Logged per key: after Ctrl+Home
  the selection was unchanged, at either speed. Line 3 was also not the line wanted: with the
  start reached, the sentence for the proposal is line 2.
- **Not the product.** Home, ArrowUp and ArrowDown moved the caret, and the editor's selection
  followed, as expected; nothing a person at a keyboard does was lost.
- **Now** `selectLine` in `tests/e2e/keys.spec.ts` (used by both tests that select) goes up a line
  and to the start of the line until the caret is at the start of the text, selects line 1 or 2,
  and waits for the selected words to be "Latency" or "The sen". With `E2E_CPU_THROTTLE=4`,
  `--repeat-each 10 --workers 1`: 10 of 10 pass (4 of 10 before). Full speed: 8 of 8.

### What the browser says when the server does not answer

- Sync ticket: the request is given up after 10 seconds and asked again. The editor says
  "Offline." until the sync server has accepted the ticket (`authenticated`); the library's
  "connected" comes when the socket opens, before the ticket is fetched, and no longer counts.
- Build pane: each poll and the compile request are given up after 15 seconds. After two polls
  in a row with no answer, or with a server error, it shows "The server is not answering. What is shown here may be out
  of date." and removes it at the next answer.
- Spelling and grammar: given up after 25 seconds, and says "The spelling and grammar checker
  did not answer." (also shown when the browser has no network).
- Sign-in form: given up after 40 seconds, with the existing "the email service did not answer"
  message, which may then be the database. Browser tests: `recover.spec.ts`, `building.spec.ts`,
  `projects.spec.ts`.
- Forms and links: a submit button in a server-action form (`Once`) and an in-app link (`Go`,
  over `next/link` with `useLinkStatus`) hold the page "waiting" from the press until the answer
  has been drawn. `Waiting` (in the layout) shows "Working…" after 1 second and "No answer from
  the server yet. Still waiting: there is no need to press again." after 8, at the foot of the
  page, and clears at the answer. It is not `role="status"`, which the pages already have. The
  error page now also says that a change may or may not have been made. Browser tests:
  `waiting.spec.ts` (a form held 9.5 s; a page held 2.5 s); unit test `lib/waiting.test.ts`. Not changed: the error page still comes after
  the server's own limits (30 to 36 s); the GET form to "See what would change" relies on the
  browser's own loading sign; the editor's panels keep their own busy states; `Fresh`'s refresh
  says nothing.
- Uploads (Import ZIP, Add file; `DirectUpload`). A file over 4 MB is put in the store with an
  `XMLHttpRequest`, and the page shows "Uploading <name> (n MB). Keep this page open." with a
  progress bar, then "<name> is uploaded. Waiting for the server to take it." The request for an
  address is given up after 15 s; the put after 30 s in which no byte has left. A failure says
  "The server did not answer, so nothing was uploaded", "The file did not reach the store" or
  the server's own words (for example, too large), not the browser's "Failed to fetch". A file of
  4 MB or less is posted by the browser and holds the waiting line from the press. The waiting
  line is not used while bytes go, since "No answer from the server yet" would be untrue. Browser
  tests: `uploading.spec.ts` (progress shown; a put and an address request that fail; a put
  that stops), `waiting.spec.ts` (a small file added). Not changed: after the upload an import
  still runs inside one request (a job queue for imports is not built; see "So a job queue for imports is still not built"), and the page says only
  "Working…" or "No answer from the server yet" during it.

### Five small faults from a review, and a teardown

Found by a code review on 21 November; each fixed with a test that fails on the old code, except
the last two items.

- **A comment deleted while it was being changed.** `editComment` now skips deleted rows, and
  rechecks when the update changes nothing (same words: fine; deleted: `not_found`).
- **Raw HTML row of `docs/security-review.md`.** It now names the one `dangerouslySetInnerHTML`, in
  `app/layout.tsx` (a constant script with the nonce). No test.
- **Grammar checker that does not answer.** The note is shown and the findings and marks are
  kept; a 503 still clears them.
- **The file store's body timer.** A HEAD arms none, readers clear it once the body is read, and a
  body with no content-length gets ten minutes, not 10 s.
- **An upload form restored after Back.** `pageshow` also clears the "uploaded, waiting" state,
  enables the file field and removes the `key` and `name` fields. Tested by dispatching `pageshow`
  after a large upload; a real bfcache restore is not exercised.
- **Editor teardown.** `live.current` is cleared before the views are destroyed, so the awareness
  listener has nothing to redraw. No new test.
- **Run.** Unit 155, sandbox 248 (1 skipped, not new), browser 106 of 106.
- **Measured, not changed: a wait for a free connection.** The review asked whether the 10-second
  limit on waiting for one of the pool's 10 connections turns a burst into errors. Bursts of
  transactions each holding a connection (local Postgres, one process): 50 × 0.1 s, 100 × 0.3 s
  and 200 × 0.5 s all succeeded, the last in 10.07 s; 250 × 0.5 s, 50 failed with "timeout
  exceeded when trying to connect". So a process fails requests only once more than about ten
  seconds of database work is queued in it. A sync save holds a connection for milliseconds, and
  on Vercel each instance serves few requests at once; before the limit, such a request waited
  until the platform cut it off.

## A long PDF read through

**What was wrong.** The PDF pane drew a page when it first came near the window and never let go
of it: after reading a paper to its end, every page still held its canvas. Measured in a
Chromium window of 1440 x 900 at a pixel ratio of 2, reading each page in turn (a canvas is
1164 x 1646 pixels there, 7.7 MB):

| Pages       | Canvases holding a picture | Bytes in them | Last page painted | PDF workers after 5 rebuilds | Elements under `.pdf` |
| ----------- | -------------------------- | ------------- | ----------------- | ---------------------------- | --------------------- |
| 30, before  | 30                         | 230 MB        | yes               | 1                            | 181                   |
| 120, before | 120                        | 920 MB        | yes               | 1                            | 721                   |
| 30, now     | 2                          | 15 MB         | yes               | 1                            | 181                   |
| 120, now    | 2                          | 15 MB         | yes               | 1                            | 721                   |

The tab did not crash and no page went blank, at 920 MB on this machine; the cost is memory
for as long as the pane is open, and a build swaps in new pages. A rebuilt PDF starts with
every page empty and draws the ones near the window (two of them, in each paper). The probe
(a throwaway script, not kept) also showed that a rebuild leaves one PDF worker, not more, and
that 120 pages are 721 elements, so the words were left alone.

**Now.** `PdfView.tsx` follows pages in and out of the window. A page that leaves it gets
a canvas of size zero and loses `data-drawn`; one that comes back is drawn again. A page is
drawn or released by one call at a time, because PDF.js throws if a canvas is given a second
`render()` while the first is running (checked in the installed pdfjs-dist 6.5.438). After
a render the page's operator list is freed with `page.cleanup()`. The words of a page are made
once and kept, so they can still be selected and read aloud.

**Held by.** `synctex.spec.ts`, "a long PDF read to its end keeps pictures only of the pages
near the window": a 30-page paper is read page by page; at most 8 canvases hold a picture, the
last page's is one of them, and page 1, scrolled back to, is drawn again with its words once.
On the old code it fails with 30. Ten runs, and ten with `E2E_CPU_THROTTLE=4`, all passed. Run: unit 155, browser 108 of 108.

**Not changed.** A page scrolled back to is blank for the time of one render. The words of
pages already read stay in the page. Safari's canvas limit is untested.

## Five parser and graph faults found by running real-world LaTeX through it

Found by running `parse`, `coverage` and `includeGraph` on snippets of the kind real papers hold.
All five were confirmed on the old code, and each has a unit test that fails on it. Nothing here
changed a fixture, `docs/import-matrix.md` or the build image.

- **`%` in a link.** `See \url{https://ex.org/a%20b} for data.` was an `error` block that ran to
  the next `\section`: `group()` read the `%` as a comment and never found the brace. The first
  group of `\url`, `\href`, `\nolinkurl` and `\path` is now read as it is (balanced braces, no
  comments, never across a blank line) wherever the parser scans over a command. The label index
  skips these arguments too: `\url{a%20b} \ref{x}` on one line used to hide the `\ref`, so
  renaming the label left it behind.
- **`$` inside braces in inline math.** `$x \text{ if $y$ holds}$` was two math atoms with `y`
  as prose between them. `mathEnd` skips brace groups; braces that do not balance before the
  paragraph ends are plain characters, as before.
- **`\lstinline|x % y|`.** Only `\verb` had delimiter handling. `\lstinline` and `\mintinline`
  now end at their closing delimiter or brace, in `parse.ts` and in the label index.
- **`\import`, `\subimport`, `\includefrom`** (and `\inputfrom`, `\subinputfrom`,
  `\subincludefrom`) were not in the include graph, so the files they name had no report and were
  not part of the paper. They are now, as `input` edges. A file rename rewrites such a line group
  by group (`nameSplices` in `files.ts`). (Sub-imports were first resolved from the root's
  folder; see "Import folders" below.)
- **One list of reference commands.** `REFS` and `CITES` are exported from `labels.ts` and used
  by `parse.ts`. `\crefrange`, `\nameref`, `\vref`, `\citealp`, `\citealt`, `\citeyearpar`
  and the capitalised forms are now `ref` and `cite` atoms. `\crefrange` takes two groups.
  `\hyperref` stays raw (its key is in brackets, its braces hold prose). The visual view shows both
  labels of a range, and `\nameref` as its key, since it prints a title.
- **Fuzz.** `FRAGMENTS` gained `\url{`, `%20`, `\href{`, `\text{`, `\lstinline|` and `\crefrange{`.
  It found a real fault in the first version of the link fix, and the fix was changed: a verbatim
  argument scanned inside a block search for `\end{..}` ran past the end of the block, so the
  incremental reparse reused a block the full parse no longer gave. It now stops at the end of the
  line there.
- **Assumptions checked.** `escape.ts` only escapes text and does not read the parse. `prose.ts`
  gives every atom a stand-in, whatever it holds. The bridge and the visual view take an atom's
  source whole, so a `%` or a `$` inside one is no trouble; the only reader of an atom's insides
  is the reference view, which is the change above.
- **Run:** unit 165 (29 files), sandbox 249 passed and 1 skipped (as before), the browser specs
  visual, maths, insert, import, labels and citations 16 of 16. The seeded tests passed at
  `FUZZ=20000` on the old code, and at `FUZZ=20000` and `FUZZ=30000` on the new.
- **Not changed.** `includes()` in `graph.ts` blanks everything after a `%` before it matches, so
  `\url{a%20b} \input{x}` on one line still hides the `\input`.

## Five papers written the way real ones are

`fixtures/real-natbib`, `real-biblatex-subfiles`, `real-tikz`, `real-acm` and `real-xelatex` (invented
prose, 2 to 6 files each) were imported, built with the real sandbox, and walked through Chromium:
import and report, the visual view of each `.tex` file, a word typed into the first editable
paragraph and one just after the first raw atom, a formula opened, a citation and a reference tried,
the build, the downloaded ZIP compared file by file with what went in, and the ZIP with build
details rebuilt outside the app with the command in `paperweave-toolchain.json`. The walk script
is not in the repository. The five fixtures are in `docs/import-matrix.md`.

| Fixture                  | Root, compiler                              | Editable visually, by file                                             | Build (sandbox)            | Walk                                          |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- | --------------------------------------------- |
| `real-natbib`            | `main.tex`, pdflatex                        | `main.tex` 38%, `sections/method.tex` 36%                              | ok, 2.3 s, no warnings     | typed words only differ                       |
| `real-biblatex-subfiles` | `main.tex`, pdflatex                        | `main.tex` 0% (only commands), the other five files 100%               | ok, 3.5 s, biber ran       | typed words only differ                       |
| `real-tikz`              | `main.tex`, pdflatex                        | `main.tex` 24%; the standalone `aaa-icon.tex` is not part of the paper | ok, 1.9 s                  | typed words only differ (after the fix below) |
| `real-acm`               | `main.tex`, pdflatex                        | `main.tex` 38%                                                         | ok, 2.6 s, 3 font warnings | typed words only differ                       |
| `real-xelatex`           | `main.tex`, xelatex (from `% !TEX program`) | `main.tex` 48%, `chapters/gaps.tex` 100%                               | ok, 2.6 s                  | typed words only differ                       |

The root, the compiler, every file in the report and the include graph were right for all five.
No `error` block appeared in any file. `real-biblatex-subfiles` lists `intro.tex` and
`sections/model.tex` as other files that could be the root (they are subfiles with their own
`\documentclass`), and `real-tikz` lists `aaa-icon.tex`; the root chosen was `main.tex` each time.
The build panel said "The PDF is up to date." for every file of every paper; no build in the walk
had an error or a warning shown.

**Faults found, by the plan's classes, and fixed** (each with a test that fails on the old code):

- **Diff touches bytes other than the typed word** (the data-loss class; found by the walk, first
  of all). In `real-tikz`, typing just after `\lstinline|push(q, x % 8)|` put a line break into
  the file before the typed word, and the space after the atom was lost. `guard()` in
  `packages/bridge/src/translate.ts` takes any unescaped `%` earlier on the line for a comment and
  starts a new line so that typing is not swallowed by it; here the `%` is inside code. `\verb`,
  `\url{..%20..}` and `\href` were the same. It now skips the arguments of `\verb`, `\lstinline`,
  `\mintinline`, `\url`, `\href`, `\nolinkurl` and `\path`. Test in `bridge.test.ts` (types after
  each, and after a real comment): the old code gives `Call \lstinline|push(q, x % 8)|\n z keeps on.`.
  Nothing was lost beyond a line break and a space; it would have changed the paragraph's
  spacing in the PDF and, before a blank line, split it.
- **Reproducibility fault, ours.** A revision saved with the text of one already built is not built
  again: its build takes the earlier build's PDF, stamped with the earlier revision's time. The
  manifest gave the new revision's own time as `SOURCE_DATE_EPOCH`, so the outside rebuild differed
  in its dates for pdflatex (64 bytes) and in most of its bytes for xelatex (17,282 of 18,477). The
  manifest now follows the cached build back to the build that made the PDF
  (`revisionEntries` in `revisions.ts`). Sandbox test in `revisions.sandbox.test.ts` saves a second
  revision of the same text 1.5 s later and rebuilds from its ZIP; on the old code the SHA-256
  differs. All five fixtures rebuilt outside the app to the same bytes after the fix; before it,
  all five differed.
- **Toolchain gap.** `real-acm` did not build: "pdfTeX error (font expansion): auto expansion is
  only possible with scalable fonts." `acmart` falls back to Computer Modern when `libertine` is
  missing; `\ccsdesc` prints `\textbullet`, a TS1 symbol; `cm-super-minimal` holds T1 only, so TeX
  made a bitmap of `tcrm0900` and `microtype` cannot expand a bitmap. The image now has the full
  `cm-super` (`infra/tex/Dockerfile`; 52 MB installed instead of 6 MB). Image size 1.61 GB to
  1.72 GB, compressed 448 MB to 502 MB. **The toolchain image ID changes, so builds cached before
  are not reused; the owner should know the image grew.** It is its own commit, so it can be
  dropped; then `real-acm` fails to build and its sandbox test with it. Sandbox test: T1 text
  symbols under `microtype` (finds `mktexpk` in the log on the old image).
- Not faults: the five parser and graph faults listed above did not recur on the new papers.
  The predictions in the plan about the image (lmodern, T1, acmart, fontspec, polyglossia,
  unicode-math, biber, tikz, pgfplots, listings, minted, algorithm2e, siunitx, cleveref, subfiles,
  natbib and biblatex missing) were measured and are wrong: all are installed. Not installed:
  `newtxtext`, `newtxmath`, `libertine`, `inconsolata`; `acmart` warns and builds without them.

**Design limits measured** (valid, stored correctly, build; shown raw and edited in the source
view; recorded in `docs/import-matrix.md`, nothing built for them): `\footnote{}`, `{\sc ..}`,
`\textsc{}`, `\SI`, `\qty`, `\num`, `\url`, `\href` and `\foreignlanguage` are one raw atom each
(`\textbf` and `\emph` are editable); `description`, a list with `\item[label]`, and a list with a
list inside it are one raw block each; `tikzpicture`, pgfplots, `lstlisting`, `algorithm`,
`CCSXML`, `\ccsdesc`, `\keywords`, `teaserfigure` and the `acmart` title block are raw blocks; a
`figure` with `subfigure`s offers the first caption for editing. A citation or a reference is
shown in place with its source as its title; a double click opens a formula but does nothing on a
citation or a reference (the visual view inserts them through the menu). Pressing Enter with one
selected splits the paragraph there, as it does for any selected thing. Prose editable visually:
`real-natbib` 38%, `real-biblatex-subfiles` 81%, `real-tikz` 24%, `real-acm` 38%,
`real-xelatex` 72%, against 66% to 82% for the three older fixtures.

- **Run:** unit 166 (29 files), sandbox 261 passed and 1 skipped (33 files), lint and typecheck
  clean, browser suite 119 of 119 (16 minutes), including the new import test.
- `acmart` with the fonts it asks for (`libertine`, `newtxmath`, `inconsolata`) was left without
  them then, for size; `texlive-fonts-extra` was added later, see "`texlive-fonts-extra` added to the
  image".

## Inline atoms opened from the visual view

A citation, a reference, a footnote, `\url`, `\href`, `\textsc`, `{\sc ..}`, `\SI` or any other
raw inline LaTeX is opened by a double click, by Enter when it is selected, or from the context menu
("Edit citation…", "Edit reference…", "Edit footnote…", "Edit LaTeX…"). The formula box opens on its
source with no preview; Apply replaces exactly that atom's bytes through the server's command path
(`Bridge.atomCommand`, then `Bridge.rewriteCommand`, a compare-and-swap on the atom's text). The
picker for citations is not changed. A macro definition (`\newcommand`, `\def`, ...) is refused at
open with "edit it in the source".

- **What is refused.** `rewriteCommand` splices the new text into the source and parses it, both
  incrementally and in full; `contained` (`packages/bridge/src/translate.ts`) then requires every
  piece and block outside the atom to be the same, shifted by the change in length, and the new
  pieces to cover exactly the replacement, in the same block and list item. If not, the answer is
  `'spills'`, nothing is sent, and the box stays open with the reason. This refuses an unclosed `{`,
  a blank line, a trailing `%`, a command run into the next word, `\begin{..}`, `$$` and `\item`.
  It also refuses a replacement, or an atom, with half of a surrogate pair in it: the shared text
  turns that into U+FFFD. A found case: `\` followed by an emoji is parsed as an atom that ends
  inside the emoji.
- **Formulas** keep their own path (`openMath`), without this check.
- **Enter on a selected inline atom opens it.** It split the paragraph there before (see "Five
  papers written the way real ones are"). A selected block atom is as it was.
- **Fuzz.** `FUZZ=N` generated rewrites (`soup` or a mutated copy of the atom, on a random inline
  atom of a random fixture): a refused one leaves the source as it was; an accepted one changes
  the bytes of that atom and no others, and the visual document is the projection of the source.
  100000 ran with 28203 accepted and 71797 refused; 300000 with 85320 and 214680. Before the check
  of a full parse was added, one run of 300000 found a rewrite of `$\delta$` that the incremental
  parse read differently from a full parse (seed 25218).
- **Run:** unit 169 (29 files), sandbox 261 passed and 1 skipped (33 files), lint and typecheck
  clean, browser suite 120 of 120 (16 minutes), including `atoms.spec`.

## Two parser faults found by the atom-rewrite fuzz

- **Reparse after an edit that balances an earlier `$`.** Inline math with a `{` that never closes
  is first read with braces counted, scanning ahead to the next blank line or heading, which can
  be past the end of its own paragraph, and then again without them. An edit later in that region
  that supplied the `}` changed the paragraph before it, but `reparse` backed up only three
  blocks and kept the old one, so it differed from `parse` (`Let $a\text{b$ so`, a display
  environment, then `c d` becoming `c} d`; and `$\delta$` rewritten to `$\d}\(lta$` after such a
  paragraph). `reparse` now also restarts at the last blank line or heading before the edit
  (with 24 characters of margin, so a boundary the edit touches does not count).
- **A backslash before a character outside the BMP.** `\` + one UTF-16 unit made the atom end
  between the halves of a surrogate pair, and a `\verb` delimiter that was an emoji was matched by
  its first half. Both now take the whole character; `assertLossless` also checks that no block
  or piece boundary falls inside a pair.
- **Bridge.** A visual transaction whose source edit starts or ends between the halves of an
  emoji, or inserts half of one, was accepted and the shared text wrote U+FFFD (inserting at, or
  deleting up to, the middle of a pair). `Bridge.filter` now refuses it. The `HALF` guard in
  `rewriteCommand` is no longer reached by `\` + emoji but is kept.
- **Fuzz.** The fragments `$\d`, `$\d}`, `\(lta$`, `$\delta$`, `\` + emoji and `\` + emoji + ` x`
  were added. With the old `reparse`, `FUZZ=300000` of the incremental test failed at seed 2079.
  `FUZZ=500000` of the latex tests passes (5000 seeds of 100 edits each); `FUZZ=100000` of the
  bridge tests passes. The reparse fault is not reached by the atom-rewrite fuzz as it stands (it
  compares a full parse too); seed 25218 at `FUZZ=210000` passes.
- **Run:** unit 174 (29 files), sandbox 261 passed and 1 skipped, lint and typecheck clean,
  browser `visual`, `maths`, `insert`, `atoms`, `keys` 21 of 21.

## Import folders

`includeGraph` now follows the `import` package's folder. `\import`, `\inputfrom` and
`\includefrom` set it to their folder argument (a trailing slash is not needed); `\subimport`,
`\subinputfrom` and `\subincludefrom` add their folder to the one in force; plain `\input` and
`\include` keep it. Every include except a bibliography is looked for there first, then from the
root's folder as before; a picture tries the import folder before `\graphicspath`. `\bibliography`
and `\addbibresource` stay root-relative. `..` folds, and a root in a folder gives folders
relative to it. The first visit of a file still wins, and cycles are still reported. Files in a
nested sub-import are now in `graph.order`, so labels, citations and import see them.

- **TeX checked.** `import.sty` (v6.2) puts the import folder first on `\input@path` and
  `\Ginput@path`, with the folder TeX started in as the fallback, and a sub-import appends to the
  folder in force. The sandbox test builds `\import{sections/}{intro}` with a `\subimport`, an
  `\input` and a picture inside it: it builds, the nested text is in the PDF, a `detail.tex` in
  both folders gives the import folder's, and a file only at the root is still found.
- **Tests:** `graph.test.ts` (7 new, all fail on the old code); one sandbox test.
- **Renames follow the import folder.** `Graph.base` gives each visited file's import folder, and
  `renamePlan` resolves every include the way `includeGraph` does. A name found in the import
  folder is written from there: a `\subimport` folder group is relative to it (and may use `..`),
  and a plain `\input` or picture stays relative to it. A plain include whose file moves out of
  the import folder is written from the root, which TeX falls back to. Limit: a file of the same
  name inside the import folder would shadow it, and that is not checked. `\subfile` was
  not checked. Starred forms (`\import*`) are treated as unstarred.

## The compiler can be changed, and is guessed better

- Before, `projects.compiler` was set by import and by restoring a revision, and nothing else:
  a paper whose engine was guessed wrong could never build. `setCompiler` (packages/server/src/projects.ts)
  now sets it. It needs `file.write` (a viewer or reviewer gets `permission_denied`, a non-member
  `not_found`), accepts only `pdflatex`, `xelatex` and `lualatex` (`invalid_input` otherwise), does
  nothing for an unchanged value, and bumps `manifest_version`. The revision's content key and the
  stale-build check already included the compiler, so the next revision is a new one and an old
  build shows as behind. The paper's page has a "Change compiler" select and a "Save compiler"
  button, shown to writers.
- The guess (`compilerFor` in import.ts) still obeys `% !TEX program = ...` first. Otherwise it reads
  `\usepackage`, `\RequirePackage`, `\documentclass` and `\LoadClass` (option lists and comma
  lists included), with comments blanked, in the root's preamble, in the files the root reads
  before `\begin{document}`, and in the paper's own `.sty` and `.cls` those load. xelatex: `fontspec`,
  `unicode-math`, `xeCJK`, `polyglossia`, `ctex` and the `ctex*` classes. lualatex: `luacode`,
  `luatextra`, `luatexja`; lualatex wins if both appear. A commented-out package, an `\input` after
  `\begin{document}` and a system class the paper does not hold are not read.
- Limit: a package loaded by a system class or package (not the paper's own) is not seen.
  Whether a `\usepackage` inside an `\if` branch is live is not checked.

## `texlive-plain-generic` added to the image

- `texlive-latex-extra` only recommends `texlive-plain-generic`, and the image installs with
  `--no-install-recommends`, so these papers failed with no PDF: `\usepackage[normalem]{ulem}`
  (`\sout`), `soul` (`\hl`), `changes` (needs `ulem`), `datetime2` (needs `tracklang.sty`) and
  `\documentclass{aastex631}` (needs `epsf.sty`). The package is now in `infra/tex/Dockerfile`; all
  four of `ulem.sty`, `soul.sty`, `tracklang.sty` and `epsf.sty` are found by `kpsewhich`. Sandbox
  tests in `compile.sandbox.test.ts` build each one (they fail on the old image with
  "File `ulem.sty' not found" and the like). The `aastex631`test puts`\title`after`\begin{document}`, which that class needs.
- Image size 1.72 GB to 1.78 GB, compressed 502 MB to 506 MB.
- **The image ID is part of the build cache key, so every paper rebuilds once after the image is
  pulled or rebuilt** (as with the `cm-super` change above). Output bytes do not change for papers
  that already built: the full sandbox suite, including the ZIP rebuild tests, passes.

Not changed: still not installed, checked with `kpsewhich` on the new image: `pstricks.sty`,
`CJKutf8.sty`. (`dsfont.sty`, `bbm.sty` and `newtxtext.sty` came with `texlive-fonts-extra`, see
"`texlive-fonts-extra` added to the image".)

## Program source files are kept on import

- `.py`, `.c`, `.java`, `.m`, `.R`, `.json` and the rest of the list in `SOURCE`
  (`packages/server/src/archive.ts`) were left out of an import, although `\lstinputlisting{code/a.py}`
  reads them and `graph.ts` follows it. The build then failed with "File `code/a(.py)' not found"
and no PDF; the file also could not be added or renamed afterwards, because `checkPath`shares the
rule. They are now wanted, and`TEXT_FILE` includes them, so they open as text and can be
co-authored. The match is case-insensitive (`plot.R`).
- `decodeFile` now treats content with a NUL byte as not editable (stored read-only, like non-UTF-8).
  It did not before, for any extension; a NUL cannot be held in a database text column.
- `paperweave-toolchain.json` is reserved. Every revision download writes it, and re-import used to
  drop it only because `.json` was unwanted. `readZip` now skips it ("written by PaperWeave on
  download", in a folder too, as in the `src/` of a submission) and `checkPath` refuses the name.
- Files are never served raw: `picture/route.ts` serves only picture types with a signed type and
  `nosniff`, and the build and download routes use fixed types. `.html` and `.js` are never
  sent with their own content type.

Not changed:

- Files without an extension (`Makefile`) and `.ipynb` are still skipped.
- Papers imported before this change lack these files; they can now be added by hand.
- `\inputminted` still does not build, because shell escape is off, but its file is now kept. (A paper
  that loads minted fails as a whole, not in part: see "A paper that loads minted is told what to do".)

## `texlive-fonts-extra` added to the image

- Papers that load `inconsolata` (the ACL template), `bbm`, `dsfont`, `newtxtext`/`newtxmath`,
  `libertine`, `fontawesome5`, `mathabx` or `bbold` got no PDF ("File `X.sty' not found"), and
`acmart`set its text in Computer Modern instead of Libertine.`texlive-fonts-extra`is now in`infra/tex/Dockerfile`; `kpsewhich`finds all nine`.sty` files (`newtxtext`and`newtxmath`are
two). Sandbox tests in`compile.sandbox.test.ts`build each one, build XeLaTeX and LuaLaTeX
papers with`\setmainfont{Libertinus Serif}`(a font from fonts-extra), and check that an`acmart`
sigconf PDF embeds a Libertine font (`pdffonts`). The 11 of them failed on the old image.
- **Size:** image 1.78 GB to 4.15 GB (content size 506 MB to 1.2 GB). This is more than the 1.4 GB
  noted earlier, which was the package's installed size alone and not the image layer apt adds.
  A clean build of the image took about 5m15 here (2m40 before), most of it the download and unpack.
- **XeLaTeX by font name** did not work at first: fontconfig in the image did not list the TeX Live
  font folders, so `\setmainfont{Libertinus Serif}` failed. The Dockerfile now writes
  `/etc/fonts/conf.d/09-texlive-fonts.conf` and runs `fc-cache -f` at build time, so the cache is in
  the read-only image (1815 fonts listed). Build time of that paper: 1.4 s.
- **LuaLaTeX** builds its font-name database in `/tmp/texmf-var` on every build. Measured in the
  sandbox limits (read-only root, 64 MB `/tmp`, 1 CPU): 8.5 s for the Libertinus paper, 4.4 MB of
  `/tmp`. That is under the 20 s I set as the line, so the database is not baked into the image.
- **The image ID is part of the build cache key, so every paper rebuilds once.** CI builds the image
  on each run, so it is slower by the extra download. Output bytes of papers that already built do
  not change: the full sandbox suite (284 passed, 1 skipped), including the five `real-*` papers
  and the ZIP rebuild tests, passes, with no expectation changed.
- The sentence in `docs/import-matrix.md` that said the image lacks these fonts is replaced (source:
  `packages/server/src/matrix.test.ts`, regenerated with `WRITE_MATRIX=1`).
- Not changed: still not installed, checked with `kpsewhich`: `pstricks.sty` and `CJKutf8.sty`.
- This is one commit (the Dockerfile), so it can be dropped if the owner finds the size too much;
  the tests for these fonts would then be dropped with it.

## Glossaries and nomenclature are built

- latexmk runs with `-norc`, so it had no rules for `makeglossaries` or nomencl. A `glossaries`
  paper built with exit 0 and an empty glossary (`.glo`, `.acn` and `.slo` written, `.gls`, `.acr`
  and `.sls` never), a `nomencl` paper had an empty nomenclature (`.nlo`, no `.nls`), and nothing
  warned, so "Check before submitting" called it ready.
- `-norc` stays. Our own rules, `LATEXMK_RULES` in `packages/latex/src/latexmk.ts`, are passed with
  `-e`, which latexmk honours with `-norc`. `.glo`, `.acn` and `.slo` run `makeglossaries`; `.nlo`
  runs `makeindex -s nomencl.ist`, unless the `.aux` has `\@istfilename`, when the `.nlo` is the
  `numbers` glossary of `glossaries` and `makeglossaries` is run. All use list-form `system()`, so
  no shell reads a file name, and the string has no single quote. The worker and the command in a
  revision download's `paperweave-toolchain.json` both use it, so the ZIP rebuilds the same PDF
  (a sandbox test runs the manifest command as written in the image, and compares bytes).
- It also wraps BibTeX (`pw_bib`): see "A paper that `\input`s its own `.bbl` and has no `\bibliography` failed to build".
- A failed rule is now an error: "The glossary could not be made. The build log has the details."
  (latexmk's "Collected error summary" names a `cusdep` rule).
- **With `\usepackage[xindy]{glossaries}` the build now fails.** xindy is not in the image. It used
  to build with exit 0 and an empty glossary. This follows the BibTeX precedent: a tool that cannot
  run is an error, not a quiet empty list. The fix for the author is to drop the option.
- Not changed: with `nomain` and only a custom `\newglossary` extension, no rule fires, so that
  glossary is still empty.
- Tests: `compile.sandbox.test.ts` (acronym glossary with the root in a folder, nomencl, `numbers`,
  xindy, XeLaTeX and LuaLaTeX; six, all failing on the old code), `diagnostics.test.ts` (an excerpt
  captured from a real xindy build), `revisions.sandbox.test.ts` in both packages.
- `docs/import-matrix.md` does not mention glossaries, so it is unchanged.

## A proposal to add text is stale when the text around its place is deleted

- A proposal to insert text (`expected === ''`) holds two Yjs anchors: the character after the
  caret and the one before it. When an editor deleted or retyped the text around the caret, both
  anchors closed up to one index, `now` was `''` as expected, and the place read as unchanged: it
  was listed fresh and Accept wrote the text at wherever the place had closed up to. The same held
  for undoing an accepted deletion (`replacement === ''`).
- Rule: if either neighbour is deleted, the place is lost and the proposal is stale. An anchor at
  the start or end of the file holds no character and never counts as lost, so an insertion at
  either end, or into an empty file, stays fresh.
- `listProposals` marks it `stale` and `placeLost`; `acceptProposal` and `undoAccept` answer
  `conflict` (`runCommand` with `exactPlace`, checked under the file lock); `reviseProposal` refuses
  with "The place this was to be added at is no longer in the file. Make a new proposal." The
  proposals pane shows that sentence and hides "Change the proposal". Editor commands from the
  sync server pass `exactPlace` too (see "An insertion from the visual view whose place was
  deleted"). No migration.
- A restore that brings the sentence back leaves the proposal stale: the restored characters are
  new ones, and a place cannot be re-attached (there are no words to find it by).
- **Review data.** `exportReview` now writes `stale: true` for every open or accepted proposal that
  is stale (before: accepted only) and `placeLost: true` for one whose place was lost; both are
  optional, the format is still `paperweave-review-1`. Import used to place every open proposal by
  its words, which undid staleness: an insertion arrived fresh and Accept wrote in the wrong place,
  and a word changed in the source and typed once elsewhere arrived fresh on the other copy. Now an
  open stale proposal with words is anchored at the start of the file (it reads as stale, Accept
  answers `conflict`, "Find these words again" stays the person's choice, and `reviseProposal`
  refuses the closed-up stretch). An open stale insertion (or one with `placeLost`) is left out and
  reported in `missing`: "A proposal to add “…” in main.tex: the place it was to be added at was
  no longer in the file." Accepted proposals are unchanged. Files exported before this change carry
  no flag and import as they did: placed by their words, so they can still arrive fresh. No
  migration.

## Typing that landed between a delete's revision and its removal

Deleting a file cut a revision in one transaction and hid the file in another. Edits that waited
for the files while the revision was cut landed after it and before the removal: they were saved,
acknowledged, and in no revision, while the page said "revision N still has it". Restoring N
brought the file back without them. Now `cutRevision` takes an optional `within`, run after the cut
in the same transaction (also when the cut finds nothing changed), and `deleteFile` removes the file
there, after checking again that the file is live and not the root and that the person may still
write. Files are locked before the project, as in a restore. The `acl` notification goes out when
the transaction commits. `appendUpdate` and `appendUpdates` now refuse a file that has been
deleted, so a queued edit is refused instead of acknowledged. Tests: `files.sandbox.test.ts` (an
edit queued behind a delete is refused, the file's `head_seq` equals the revision's `seq`, restore
gives back the text as it was; a role lowered mid-delete refuses the delete) and
`sync.sandbox.test.ts` (no log entry above the revision's `seq`, editor closed with `no-access`).

## A connection that was still loading its file when access changed

Hocuspocus registers a connection only after the file has been read, and `recheck` and `signedOut`
walk only registered connections. Someone removed, lowered or signed out in that window was missed:
their socket stayed open and they went on reading live. Now the `connected` hook looks first
(`look`, the body `recheck` uses for each connection): write access, role message and `4403
no-access`; then, for a ticket that names a sign-in, whether that session still exists (`4401
signed-out`). If the database cannot answer there, the socket is closed with `try-again`, which the
editor retries. Tests: three in `sync.sandbox.test.ts`, on a second server whose store holds reads
back until released.

Limit: Hocuspocus drains messages queued before `connected`, so a person removed in the window may
still receive the text as of their valid ticket. Only the live reading stops.

## A root change racing a delete, and two renames to one name

Two races found by forcing interleavings. `setRootFile` updated the project and then, through the
root's foreign key, needed the file; a delete (inside `cutRevision`) holds the files and then
updates the project, so the two deadlocked and `setRootFile` failed with a raw 40P01. It now takes
the files and then the project, in one transaction, the same order as the delete, and checks the
file again with them held: a file deleted a moment before gives `not_found`, and the root never
points at a deleted file. `renameFile` checked that the name was free and then updated, so two
renames to one name could hit the unique index and surface a raw 23505; it now turns that into the
same `conflict` ("Another file already has that name.") that `createFile` already gave. Tests: two
in `files.sandbox.test.ts`, held in place by the lock wait and a barrier, not sleeps.

## "Restored while you were offline" no longer fires wrongly, or fails to

The editor holds unsent edits when a ticket names a newer restore than it last saw. It only learned
the number from tickets, so a restore made while it was connected (which arrives as ordinary edits)
left it stale, and its next offline spell with an unsent edit was held falsely. Separately, the
number was taken as seen when the ticket was fetched; if that attempt died and the person typed
before the next one, the edits merged into the restored text unasked. Now `restoreRevision` runs
`pg_notify('restored', '<project>:<number>')` in its transaction; the sync server listens, brings
each open file of that paper up to its log, and only then sends `{ restored: n }` to those
connections, so the edits reach the socket first. When the listener reconnects it sends each open
paper its current number, one query per paper. The editor takes the maximum of what it has and what
it is told, and commits the ticket's number only in `onSynced`. Tests: one in `sync.sandbox.test.ts`
(announced, and after the edits); three in `recover.spec.ts` (restore while connected, restore that
leaves the open file alone, and a connection that dies after its ticket). The last holds the order
with routes, not sleeps.

## Held data no longer leaves through the review file

"Data kept back never leaves, in any download" was false for the ZIP with review data:
`exportReview` wrote every thread and proposal, so a held CSV's quoted rows (`quote`, `expected`)
and the text around them (`before`, `after`) went out in `paperweave-review.json`. It now reads the
held file ids once (`heldFileIds`, the same set the ZIP uses) and skips every thread and proposal
on those files, by file id so a rename cannot dodge it: detached and resolved threads and decided
proposals too. The file gains an optional `held: [{ file, threads, proposals }]`, counts only, and
importing it adds one line per entry to the report's `missing` list. Files without the field read
as before. The project page says beside the ZIP link that comments and proposals on held files are
left out. Tests: one in `reviewdata.sandbox.test.ts`, one in `data.sandbox.test.ts` (export,
import report, rename, release).

Not covered: a comment body or an evidence string on another file that quotes the held data in a
person's own words. That is free text, and nothing can tell it from any other sentence.

## Grammar findings stay out of every form of citation

Gate E3 (no grammar finding inside an equation, unit, code, path or citation) leaked for three
spellings of a citation, because the parser's cite atom ended early: a biblatex multicite
(`\\autocites[see][12]{a}[adn compare][15]{b}`) was cut after its first group, so the later notes
were prose; `\\cite [p] {k}` was not read as a citation at all; and an angle-bracket note
(`\\cite<pre>{k}`) was not either. The cite atom now skips whitespace (one line break, never a
blank line), an `<...>` note, a multicite's leading `(pre)(post)` notes and its repeated
`[pre][post]{keys}` units. A later unit counts only if whole, so `\\textcites{a} [see below]` still
reads "[see below]" as prose.

`CITES` gained the multicites (`cites`, `parencites`, `textcites`, `autocites`, `footcites`,
`smartcites`, `supercites`, and the capitalised four biblatex has), exported as `MULTICITES`. It is
shared, so `citeIndex` reads every group too, and `\\cite<pre>{k}` now yields its key: the citation
index and the visual editor's atoms agree with the grammar view. Tests: five in `prose.test.ts`
and `labels.test.ts` (fail on the old code), one in `grammar.sandbox.test.ts`.

## A download with its review, while someone types

The ZIP "with review data" cut a revision, then read the live text to place each thread and
proposal by its words and what stands around them. Typing between the two meant the review
described text that differed from the ZIP's files, so on import a quote with the same words
elsewhere could not be told apart: a proposal was reported missing and a thread came in detached.

The review is now read inside the cut's own transaction (`within`), with every file held, so it
and the files are one moment. Only the database is read while they are held; the store is sent to
before. `exportReview`, `listThreads`, `listProposals` and `loadUpdates` take a transaction client
as well as the pool. Test: `reviewdata.sandbox.test.ts` types between the cut and the review read
(fails on the old code).

## A chart is judged by the files in the paper

- **What was wrong.** `stale` compared the data's version with `charts.drawn_digest`, one row
  set by the last drawing. A restore puts `charts/<name>.pdf` and `.png` back without touching
  that row. Draw at data v1, change and approve the data (v2), cut a revision, redraw, restore
  that revision: the paper held v2 data with the v1 drawing and the chart said it was fresh, so
  `submissionChecks` said ready and the old figure shipped in the ZIP and PDF. The reverse
  (restore to a v1 revision, data back to v1) said "out of date" wrongly.
- **Now** `listCharts` collects the data versions (`record.data.sha256`) of every `chart_draws`
  row whose two digests are those of the files now in the paper. A drawn chart is stale unless
  that list holds the data's current version (and a deleted data file has none, so it is stale).
  Several draws of the same bytes: any match is fresh. If no draw matches both files, the old
  `drawn_digest` rule applies. No migration; `submit.ts` reads `stale` and needed no change.
- **Held by** `charts.sandbox.test` (false fresh, false stale) and `submit.sandbox.test` (not
  ready after the restore). The false-fresh and false-ready tests and the false-stale one all
  failed on the old code.
- **The chart's spec: done.** The same hole existed for a spec change, a redraw and a restore.
  `listCharts` now also collects `shown_as`, the data versions of those drawings whose
  `record.chart` equals the chart's current `spec`. With a drawing on record for the files, the
  chart is stale unless `shown_as` holds the data's current version. `Chart.changed` is
  `'settings'` when the data matches but the settings do not, `'data'` otherwise (also when both
  differ), `null` when fresh; the submission check, the paper's page and the chart's page word
  it so. Two specs that draw the same bytes both match; A to B to A and drawn again is fresh.
  Held by `charts.sandbox.test` and `submit.sandbox.test` (restore to a drawing of other
  settings).

## A repeated label counts when TeX says it is defined twice

The pre-submission checks treated every label written twice in the source as a problem. Text TeX
skips (an old paragraph in `\iffalse ... \fi`, the other arm of an `\ifwide ... \else ... \fi`)
defines nothing, so such papers could never be ready though TeX builds them without a warning.
Like undefined labels, missing citations and missing files, a duplicate now defers to TeX when the
newest build is of the paper as it stands: if TeX did not warn "multiply defined" for the label,
it is a warning. A stale or missing build still reads the source alone. With cleveref, TeX also
warns about `key@cref`; that is now counted as the same label, so it is listed once.

| Paper                                                         | Before               | After                         |
| ------------------------------------------------------------- | -------------------- | ----------------------------- |
| Same label inside `\iffalse ... \fi`, built                   | problem, never ready | warning, ready                |
| Same label in both arms of `\ifwide ... \else ... \fi`, built | problem, never ready | warning, ready                |
| Label really defined twice, built                             | one problem          | one problem                   |
| `\iffalse` paper edited and not rebuilt                       | problem              | problem (and the stale build) |
| cleveref, label really defined twice                          | two problems         | one problem                   |

## An insertion from the visual view whose place was deleted

- **The fault.** A citation, reference, equation, figure or table window sets the place when it
  opens, and the command runs when the person confirms, perhaps minutes later. `insertCommand`
  named the place by one anchor, the character after the caret, for both ends. If a co-author
  deleted the paragraph meanwhile, the anchor closed up to the next surviving character, the
  expected text `''` still matched, and the server answered `applied`: the insertion landed at the
  seam, next to a heading or inside its `\section{`. `atomCommand` with an empty part (an empty
  table cell, an absent caption) had the same shape.
- **Now.** `insertCommand`, and `atomCommand` when its part is empty, put `from` on the character
  before the place (association -1) and `to` on the character after. The sync server's command
  path passes `exactPlace: true` to `runCommand`, so an insertion is refused (`conflict`) if either
  character was deleted. `placeLost` already handles the association, and an anchor with no
  character (the start or end of the file) is never lost. `runCommand` is unchanged. The editor
  shows its usual "That text changed before the edit arrived. Try again."
- `Bridge.applyCommand`, the in-memory stand-in for tests, does the same check. It holds a small
  copy of `placeLost`, because `packages/bridge` cannot import `packages/server` (that would be
  a circular dependency); keep the two in step.
- `visual.ts` puts the caret after an insertion from `c.to`, which is unchanged (the character
  after the caret), so the caret still follows the insertion.
- **Stricter than before, and safe.** If another person types exactly at the caret, the stretch
  between the anchors is no longer empty and the command conflicts; the person tries again.
- Tests: four in `packages/bridge/src/bridge.test.ts` (paragraph deleted, delete running into a
  heading, empty atom part, anchor association) and two in `apps/sync/src/sync.sandbox.test.ts`
  (refused; and the ends of the file and unrelated typing still apply).

## A replacement that spills into its neighbours

An inline atom's replacement was checked for spilling (`contained`) only against the client's text. It now travels as `contained: true` on the command, and `runCommand` and `Bridge.applyCommand` check it against the text as it stands when the command lands, answering `conflict` if another editor's edit made it spill (for instance deleting the space after `\sys{}` before `\sys` is written there). The check parses a window, not the file (`containedNear` in `packages/latex/src/contained.ts`): from two paragraphs before the edit to two paragraphs after it, where a paragraph boundary is a blank line (a heading that begins a line also starts one), found by the rule `reparse` restarts on, with its 24-character margin. The window is parsed before the edit and after it, and `contained` runs on the two with offsets relative to the window, so the cost follows the paragraph and not the file: about 5 ms at 1 MB and 5 MB and about 30 ms at 50 MB (`MAX_FILE_TEXT`), with the edit in an ordinary paragraph (the 5 MB server test finishes in about 1.5 s including import), where the full-file check took 0.75 s, 4.3 s and ran out of an 8 GB heap. The preamble is kept apart: an edit before `\begin{document}` is refused (nothing there is an atom), and a window after it gets a one-line preamble so a second `\begin{document}` is text, as in the whole file. A window over 256 KB (`WINDOW_CAP`, one paragraph with no blank line in it, say) is refused with `conflict`; it never falls back to the full parse, because refusing is safe and running out of memory inside the row lock is not. Against the full-file check, a seeded property test (`packages/latex/src/contained.test.ts`) finds the window never accepts what the full check refuses, and agrees exactly on ordinary documents. On random fragment soup it can refuse what the full check accepts, when the window starts inside a span left open across a blank line (an unclosed `verbatim`, `$$` or environment), since it then reads that text as prose; about 0.1% of such cases.

## Formulas are checked for spilling too

`openMath` (the formula box) now goes through `Bridge.rewriteCommand`, as `openAtom` does, so an edit that would change how the text around the formula is read is refused in the box ("This would change how the text around it is read ... make the change in the source") and the command that does go out carries `contained: true`, which the server checks again. Before, `$x$` to `$x`, to `$x$ %` or to `$x$\end{document}`, and a `\begin{equation}` with no `\end{equation}`, were all applied: the paragraph froze, the rest of a line became a comment, the paper became one raw block, or the formula and the next paragraph merged. (Unclosed braces and blank lines, which still passed here, were closed later: see "An equation typed into the Insert window can no longer stop the build".)

`contained` (`packages/latex/src/contained.ts`) accepts a display-math block as well as an inline atom, so it requires exactly one math block at the same block index, covering exactly the replacement. A formula the browser cannot draw (`$\frac{a}{b$`, an unknown macro) still applies if it is contained.

- **Refused now.** Changing an inline formula to a display one in the box, or splitting one equation into two, changes the block structure and is refused with "make the change in the source".
- Tests: `contained.test.ts` (display to display, missing `\end{equation}`; the window property test now includes math blocks), `bridge.test.ts`, `commands.sandbox.test.ts` and `maths.spec` (`$T` and `align` without its end, alert shown, box open, source unchanged).

## File names: folders and byte limits

`checkPath` now refuses a path with a part over 255 bytes in UTF-8 (a 200-character CJK name is 600 bytes), and `createFile` and `renameFile` (also the rename proposal) refuse a path that uses an existing file as a folder, or is a folder of an existing file: "A file and a folder cannot share the name "main.tex"." Before, both passed, `mkdirSync`/`writeFileSync` in the builder threw, and every build of that paper failed. Reproduced with `createFile('main.tex/notes.tex')`, a rename to `assets.tex` beside `assets.tex/a.png`, and a 200-character CJK name.

- **Import.** A ZIP holding `a.tex` and `a.tex/b.tex` was imported whole. Now the file that is also a folder is skipped, with the reason in the import report, and the folder's files are kept. An entry with a part over 255 bytes is skipped, with a reason.
- **Restore.** `restoreRevision` does not re-validate paths. It replaces the paper with the revision's file set and removes later files, so a later file cannot collide with it. A revision cut before this fix may still hold a colliding pair, and restoring it brings that back. Not fixed here.
- Tests: `files.sandbox.test.ts` (names, folders, import), `builds.sandbox.test.ts` (a 240-byte name builds).

## Edits typed offline in a file that was deleted, or after losing access

Coming back online, the editor said "This paper was restored to an earlier revision while you were offline" and offered "Apply my edits to the restored paper" when no restore had happened: the file had been deleted, or the person removed from the paper. `/api/sync-ticket` answers `restored: null` then (`lastRestore` threw an `AppError`), and `FileEditor` took `null !== 0` for a restore, held the edits and threw before the sync server was asked, so `refuse()` never ran. Now only a numeric `restored` holds edits (a file deleted and then brought back by a real restore still does). With `null` the ticket is used, the sync server refuses it, and the editor locks as for any other lost access, saying "What you typed here was not saved. Copy what you need from it." The locked text stays selectable. `restoreOffered` is set only from a number. With nothing unsent nothing changes. No server change.

- Tests: `tests/e2e/recover.spec.ts` (file deleted; person removed; and the other file's tab still saves, with the owner seeing its edit).

## Fault suite: a restore pressed twice

`SEED=302909809 FAULTS=120` failed with "the revision kept before a restore lacks text that was stored". It was the test model, not the product. Two restores to the same revision in a row, with nothing typed between, make one revision: the second is the first again (the button pressed twice, already covered in `revisions.sandbox.test.ts`). The model still looked for the revision numbered one below the restore, which was the paper from before the first restore. The product lost nothing: the stored text was the restore revision's text.

- The model now checks whether the restore added a revision. If it did not, the paper as it stood is that restore revision itself, and every mark stored before must be in it. The invariant (acknowledged text is never lost) is unchanged.
- Also fails on main and on 1c68346, so it was long-standing and found by a new random seed.

## A comment's text deleted, then brought back with undo

- **What was wrong.** Undo writes the deleted characters again as new ones, and a thread's
  places stayed on the old ones. After a deleted sentence was undone, the thread said "This text
  has been deleted" for everyone though the file read as before. Only the tab that undid still
  marked the words, and a reload lost that. "Attach to the same words again" refused when the
  words occurred twice.
- **What happens now.** The tab that undid is the only one that knows where the words stand. When
  it reads a detached thread and finds the words, it sends their places to the server, which
  attaches the thread only if the thread is detached, both places are in the saved text, and
  the words there match the thread's fingerprint. Anything else is refused and the thread
  stays detached; the tab tries again at its next reading. Viewers and outsiders are refused as
  before. Deleting again (redo) detaches the thread, correctly.
- **What triggers the attach.** The reading of the threads: when the comments panel is first
  shown, and whenever the build pane's poll (every few seconds) says the paper's text or its
  comments have changed. After an undo is saved the text mark moves, so the undoing tab reads
  about one poll later and sends the places. Everyone else's panel and a reload pick the change
  up the same way: the re-attached anchors move the comments mark, so their next poll reads
  the thread attached. That depends on the poll, not on a push: expect a few seconds.
- **A fault found by a flaky test.** About one attach in six was refused with "That place in the
  text is not valid", whatever the timing: the editor writes places in the URL-safe alphabet
  (`-`, `_`, no padding) and the route accepted only the standard one, so a place whose bytes
  encoded to a `-` or `_` was refused, silently, and nothing read the threads again. The route
  now accepts both. A refusal because the undo is not yet saved (`conflict`) was never seen: the
  poll waits for the save to show. If it did happen, the retry would come at the next change.
- **Not done.** Proposed changes had the same fault. Fixed in the next section.

## A proposal's text deleted, then brought back with undo

- **What was wrong.** The same as for a comment: undo writes the deleted words again as new
  characters, the proposal's places stayed on the old ones, and it went "Out of date" for
  everyone, with Accept refused, though the file read as before.
- **What happens now.** When the proposals panel reads an open, out-of-date proposal about words,
  and this tab finds those exact words at the proposal's old places (the tab that undid does),
  it sends the new places once (`action: attach` with `from` and `to`) and reads again once.
  The server attaches only if both places are in the saved text, the proposal is open and
  out of date, and the words there equal what the proposal expected (a proposal stores no
  fingerprint, so the words are compared). Otherwise it refuses, silently, and the next reading
  tries again. The route accepts standard and URL-safe base64, at most 200 characters, both
  places or neither. Other people and a reload see it fresh at their next poll.
- **Insertions are not attached again.** A proposal to add text has no words to compare, and
  nothing is stored about the text around it (no context, no fingerprint), so the server could
  not tell the place the tab names from any other caret. A place whose neighbour was deleted
  stays lost on purpose (`placeLost`), and an undo cannot be told from a retyping. They answer
  `conflict` and the person makes a new proposal. Storing the context at proposing time would
  allow it; not done.
- **Not covered.** An accepted proposal whose text was deleted and undone is still attached
  again only by the old way (the words in the file once).
- Tests: `proposals.sandbox.test.ts` (places make a proposal fresh with the words twice, and
  Accept lands at the right place; other words refused; not out of date refused; insertion
  refused) and `tests/e2e/proposals.spec.ts` (delete, save, Ctrl+Z, save; also after a reload).

## Busy buttons keep the keyboard

- **What was wrong.** "Compile now" was `disabled` while a build was queued, and "Ask a model to
  review the selected text" while a review was asked for (up to a minute). A button that is
  disabled while it has the keyboard drops it to the page: Chromium moves focus to `<body>`
  and it stays there. After a failed build "Compile now" is the keyboard user's only way on.
- **What happens now.** Both are `aria-disabled` while busy and ignore a press (Enter, Space,
  click), as `Once`, `Say` and `Change` do. The review button has a ref guard, since state is
  seen too late for a double press; Compile now posts one build at a time and sends none while
  one is queued. `globals.css` greys any `button[aria-disabled='true']` with `not-allowed`.
- **Left as they are.** "Accept" and "Undo the accept" (`disabled={p.stale}`) are unavailable
  for good, not busy; `spike/Spike.tsx`.
- **Tests.** `keys.spec.ts` (Compile now has the keyboard while compiling and after; a second
  Enter and Space send no second build) and `proposals.spec.ts` (the review button, the answer
  held back, keeps the keyboard and sends one request). Both fail on the old code.
- **Follow-up, done.** In `Threads.tsx`, "Attach to the same words again" unmounted on success,
  focus went to `<body>` and nothing was announced. It now says "The words were found again."
  in the comments' note and moves focus to the Comments heading, as "Find these words again"
  does in `Proposals.tsx`. Test: `keys.spec.ts` (fails on the old code).
- **Follow-up, done.** `removeAction` returned a bare address after removing someone: no status
  line, focus fell to `<body>` as the row unmounted, and a stale `?saved=1` was dropped without
  a word. `removeMember` now returns the removed person's email, and the action goes to
  `?removed=<email>`; People says "Removed <email> from this paper." in a `Result`, which takes
  the keyboard. The name comes from the server, not the form. Tests: `keys.spec.ts` and
  `projects.sandbox.test.ts` (both fail on the old code).
- **Follow-ups, done.** `removeChartAction`, `removeEvidenceAction` and leaving a paper
  returned no result either. Each now goes to an address that says what happened, in a `Result`
  that takes the keyboard, with the name taken from the server: `removeChart` returns the chart's
  name (`?chartRemoved=`), `removeEvidence` the citation's key (`?unchecked=`), and `removeMember`
  also the paper's name, so leaving lands on `/projects?left=` with "You left <paper>.". Two
  checks of one key give the same words, which `Result` would not take the keyboard for twice, so
  that address carries a changing `n` and the `Result` is keyed on it. Tests: `keys.spec.ts` and
  the sandbox tests of the three server functions (all fail on the old code).

## Charts and a file and folder under one name

- **What was wrong.** `createFile` and `renameFile` refuse a file and a folder under one name,
  but `putFile` (used by the chart worker) did not check. With a file such as
  `charts/latency.pdf/notes.txt` in the paper, drawing the chart `latency` added
  `charts/latency.pdf` beside it, and every build after that failed ("The build service could
  not run this build") when the builder could not make the folder. A file named just `charts`
  cannot be added (no known extension), so that exact case did not arise.
- **What happens now.** `putFile` runs `pathClash` against the paper's live paths and throws the
  same `AppError` as `createFile`; `drawNext` shows that text as the chart's problem and adds
  no files.
- **Test.** `charts.sandbox.test.ts` (fails on the old code).

## A heading from the visual view

- **What was missing.** The visual view showed headings but could not make one.
- **What happens now.** "Heading" on the toolbar, Alt+H, and "Insert a heading…" in the menu at the
  caret open a window with a level (Section, Subsection, Subsubsection) and a title. It goes in by
  the same road as a figure: `Bridge.headingCommand` builds an insertion at the caret and the
  server's command (`exactPlace`) applies it, so there is no server or schema change.
  - Only in an ordinary paragraph. A list item, a heading, a figure or table (so a caption), the
    preamble, other raw LaTeX, a frozen block and a paragraph just opened with Enter are refused
    with "Put the caret in a paragraph to add a heading."
  - A caret in the middle of a paragraph splits it; the rest becomes the next paragraph. The
    line breaks added are only those needed to leave a blank line each side, counting the ones
    already there, so there is never a run of three. A `%` comment on the caret's line cannot
    swallow the heading, since the heading starts after a blank line.
  - The title is one line (whitespace collapsed), not empty, with balanced braces and no bare
    `&` or `%` (`cellText`, as captions), and not ending in a lone backslash.
  - A text that moves before Apply is handled by the existing `conflict` / `placeLost` result.
    Undo takes the heading back in one step.
- **Left as it is.** Alt+H is Firefox's Help menu key on Windows and Linux if the page does not
  take it; Alt+T is Tools there and was already in use. There is no way yet to change a heading's
  level or to turn a paragraph into a heading.
- **Tests.** `bridge.test.ts` (exact bytes mid-paragraph, both ends, refusals, the projected
  heading node, comments) and `insert.spec.ts` (toolbar, Alt+H, menu, undo, a second person,
  refusals, axe).

## Enter in a list item

- **What was missing.** Enter in a list item in the visual view was refused ("That edit spans
  LaTeX structure"), because only paragraph Enter was a local splice.
- **What happens now.** Enter in a flat `itemize` or `enumerate` item inserts `\n`, the indentation
  of the item's own `\item`, and `\item ` at the caret (`translate.ts`). It is a splice like
  paragraph Enter: no server command, and undo and collaboration come with the shared text.
  - The indentation is copied (spaces or tabs); an `\item` on the `\begin` line gives none.
  - Backspace at the start of an item after the first joins it to the item before: it deletes
    from the end of the earlier item's text to the end of this item's `\item`. At the end of an
    item, Enter then Backspace gives back the original bytes. Split in the middle of text that
    has a space at the split, the space stays at the front of the new item and Backspace removes
    it too (paragraph Enter does the same).
  - Enter in an empty item does nothing and says nothing, except in the last of two or more
    (see "Starting a list from the visual view"). Enter inside `\emph{...}` is refused as
    in paragraphs. Backspace at the start of the first item is unchanged.
  - `parse.ts`: an empty item's `pre` now ends after the spaces on its own line and the rest is
    `post`, so text typed into it goes right after `\item `, not after the next line's indent.
- **Not built.** `\item[label]`, description lists, nested lists and items of several paragraphs
  are still raw blocks. Enter at the very start of the first item is refused. A selection
  replaced by Enter in a list is still refused.
- **Tests.** `bridge.test.ts` (exact bytes, indentation, typing, Backspace as inverse, refusals,
  two replicas), `parse.test.ts` (pieces of an empty item, incremental equals full), and
  `visual.spec.ts` (Enter, typing, undo, a second person).

## Starting a list from the visual view

- **What was missing.** A list could not be started without the source view, and Enter in an
  empty item did nothing, so a list could not be left.
- **What happens now.** "Bulleted list" and "Numbered list" on the toolbar, Alt+L and Alt+N, and
  "Insert a bulleted list" and "Insert a numbered list" in the menu at the caret put
  `\begin{itemize}`, `\item ` and `\end{itemize}` (`enumerate` for numbered) at the caret, at
  once, with no window. `Bridge.listCommand` builds it like `headingCommand` (same refusals, and
  the same blank-line counting, now one private helper). The caret goes in the new empty item,
  right after `\item `, so typing fills it.
  - Only in an ordinary paragraph; elsewhere "Put the caret in a paragraph to add a list." A
    caret in the middle of a paragraph splits it. Undo takes the list back in one step.
  - Enter in the empty last item of a list of two or more removes that `\item` (the splice
    Backspace uses) and puts the caret in a new empty paragraph after the list: typing there
    writes after `\end{itemize}`. The paragraph is anchored to the list's end before the edit;
    `Bridge.sync` moves the anchor along with it, so the offset is that of the old text. Enter
    in a middle item, or the only item, still does nothing.
- **Deleting a block from the visual view.** A display formula, a figure or table (any whole
  `\begin{x}...\end{x}` raw block), a lone `\label{...}`, a heading with no title and a list of
  one empty item can be removed. No server or schema change: `translate.ts` (`removeBlock`) turns
  the deletion of exactly one top-level node into one splice of the source, the block's bytes
  and one stretch of whitespace beside it.
  - Which whitespace: the one after the block, unless that alone holds the blank line between
    paragraphs, then the one before; at the end of the file, the one before. So `A\n\\[x\\]\nB`
    becomes `A\nB` (no paragraph break appears) and `A\n\n\\[x\\]\n\nB` keeps exactly one blank
    line. `guard()` is applied at the join, as for Backspace between paragraphs. A paragraph just
    opened with Enter below the block keeps its place (its index moves up by one).
  - Still refused, with the usual note: the preamble, `\begin` and `\end` halves of transparent
    environments, `\end{document}`, frozen blocks, command lines (`\newcommand`, `\input`,
    `\maketitle`), a `\label` with a comment after it, a heading with a title, a list with text
    or more than one item, and typing over a selected block (a replacement, not a deletion).
  - Keys and button (`visual.ts`): Backspace or Delete in an empty heading, and Backspace in a
    sole empty list item, delete the whole block; Delete or Backspace on a selected formula
    works through the same rule. Figures and tables have a "Remove" button (accessible name
    "Remove figure" or "Remove table") after "Edit in source", only for people who can edit.
    The caret goes to the nearest text. Undo restores every byte (`bridge.test.ts`,
    `insert.spec.ts`).
  - Not built: moving a block, and removing any other kind of block except in the source.
- **Left as it is.** Alt+L and Alt+N: Firefox on Windows and Linux uses neither for its menu bar
  (they are free), but some browsers or window managers may; the editor takes them while it has
  the keyboard. Nested lists, `\item[label]` and description lists are not made here.
- **Tests.** `bridge.test.ts` (exact bytes, both ends, file start, no run of three line breaks,
  enumerate, refusals, the projected node and caret, leaving the list, two replicas) and
  `insert.spec.ts` (toolbar, Alt+L, menu, leave, a second person, undo, refusal, axe).

## Decisions waiting on the owner

See "What I need from you" in `docs/plan.md`. None blocks C1.

One more, found since:

- **How long to keep what builds make.** Every build's PDF, log and SyncTeX file is kept for
  ever, and so is every automatic revision. See "What a paper keeps for ever" above for how
  fast that adds up. The PDFs of old automatic revisions can be made again, so dropping them
  loses nothing a person wrote; nothing does so today.
- **Should a build with LaTeX errors still show its PDF, and may submit or export use it?** Today
  any error means no PDF: `compile.ts` keeps the PDF only on exit 0, and latexmk runs without `-f`.

## How things fit

- LaTeX text in a `Y.Text` is the only stored document. Buffers hold LF and no BOM; the file's
  newline style and BOM are reapplied on export (`packages/latex/src/encoding.ts`).
- `parse` splits a file into blocks; each text block is a list of pieces that together cover every
  source character. A wrong parse can change what is shown, never what is stored.
- `Bridge.filter` turns a visual transaction into source splices or refuses it. `Bridge.applied`
  writes the splices. `Bridge.sync` re-derives the visual document after any source change and
  replaces only what differs.
- The bridge never generates LaTeX from the tree.

## Conventions

- Tests that use randomness take a seed and print it on failure. `FUZZ=<n>` changes how many
  cases run; the fault suite takes `SEED=<n>` and `FAULTS=<steps>`.
- Tests that need Docker (the TeX image, Postgres, the object store) are named
  `*.sandbox.test.ts` and run with `pnpm test:sandbox` after
  `docker compose -f infra/compose.yaml up -d --wait`.
- Every server function that touches a project takes the acting user and calls `authorize` first.
  A non-member gets `not_found`, never `permission_denied`.
- Browser tests run against a production build on port 3100. The dev server reloads the page when
  any file in the repo changes, test output included.
- Query `files` for a paper's files. `all_files` also holds deleted ones; only restore reads it.
- Deleted files are never purged. Deleting a paper removes them. A purge needs a retention rule
  first: an owner decision.
- Never log manuscript text. Log IDs and counts.
- Unsynced edits live in the browser tab's memory. Closing the tab while offline loses them; the
  browser warns first. Keeping them on the device (IndexedDB) would survive that, at the cost of
  leaving manuscript text on shared computers: an owner decision, not yet made.
- A link or a PDF jump to another page asks first when the open file has edits the sync service
  has not confirmed (`lib/leaving.ts`); `beforeunload` alone does not cover in-app navigation.
- Names shown for other people in a file come from each client and are not verified.
- One sync server to a database. Everything typed or done over the live connection reaches
  other editors through the one sync server that took it, which holds each open file in its
  own memory. A second server started against the same database waits for the first to stop
  (`onlyOne`, called in `apps/sync/src/main.ts`). Running two at once would need every edit,
  and who is where in a file, to go between them.
- A resent edit can be stored twice. That is harmless to the text and goes at the next compaction.
- The editor says "Offline" as soon as the browser does. It does not wait for the socket, which
  can take many seconds to notice.
- Sign-in is rate-limited per client address, read from `X-Forwarded-For`. In production the app
  must sit behind a proxy that sets that header itself, or the limit can be dodged. Browser tests
  give each simulated person their own address the same way.
- The web app reads its settings from `apps/web/.env.local` (copy `.env.example`). Email goes to
  the local mail catcher at http://localhost:8025; browser tests read sign-in links from it.
- The ponytail skill in `.claude/skills/` applies to all work here: the smallest complete change.
- A `[` or `*` typed in the visual view where LaTeX looks past a space or one line break for an
  argument (start of an `\item`, of a body after `\begin{...}`, after `\\`) is written as `{}[`.
  Not covered: a comment line between the command and the `[`.
- A space or tab that lands right after a command name (typed, left by a deletion, or pasted) is
  written as `{}` plus the space, because LaTeX drops a space after a command name; so is the
  bare text left when bold or emphasis is taken off right after a command name
  (`\noindent\textbf{Setup.}` becomes `\noindent{}Setup.`).

## File names LaTeX cannot spell

- **What was wrong.** A file could be created or renamed to a name with `%`, `#`, `"`, `{` or
  `}` in it (`50%.png`). A rename then wrote `\includegraphics{50%.png}` into the source, and
  the Figure tool inserted such names too. Every engine fails on them (`File ended while
scanning`, `Illegal parameter number`), and they cannot be quoted, so the name is refused.
- **Now** `texName` in `packages/server/src/archive.ts` refuses them, in any folder part of the
  path too (`dir%x/a` breaks `\input` the same way), from `createFile` (so uploads), the file
  rename and its proposal. Only the new name is checked: renaming away from such a name, an
  import, a restore and `replaceFile` of an existing file still take the names they have. The
  Figure tool says "LaTeX cannot use this picture's name. Rename it first." and inserts
  nothing.
- **Held by** `files.sandbox.test` ("a name LaTeX cannot spell"), the add-file step in
  `files.spec` and a figure test in `figures.spec`.
- **Not done:** the import report does not flag such names; an imported paper can keep a
  picture it cannot build with until it is renamed (the Figure tool and the rename form now
  tell the person). `CMD` in `packages/latex/src/graph.ts` still uses `[^{}]*`, which is right
  now that such names are not made here.

## Waiting pages without a reload, and stale references you can read

- **Found by** the accessibility audit run on two more states. A reference whose number is behind
  the text was faded with `opacity: 0.65` (about 2.9:1, `color-contrast`). The checks before
  submitting (while a build runs) and a chart waiting to be drawn had a `<meta
http-equiv="refresh" content="2">`: a reload every 2 seconds that restarts a screen reader and
  loses the keyboard's place (WCAG 2.2.1).
- **Now** `.pw-stale.pw-ref` and `.pw-stale .katex-tag` use `var(--muted)` (italic kept) in
  `globals.css`. `Again` (`apps/web/app/Again.tsx`) calls `router.refresh()` every 2 seconds
  while it is drawn and the browser is online; the server stops drawing it when the build is
  done or the chart has waited two minutes (`stuck`). `router.refresh` does not load the
  document again, so the page's nonce is not re-issued (see `lib/nonce.ts`).
- **Held by** `numbers.spec` (audit), `charts.spec` and `submit.spec` (no refresh `<meta>`,
  audit, focus kept across a tick, the result still appears).
- **Not done:** no `<noscript>` refresh; without scripts these pages no longer update by
  themselves (the pages need scripts for most else).

## A scanner's fetch no longer uses up the sign-in link

- **Found by** a security look at sign-in: the emailed link signed in on a GET, so a mail
  gateway that fetches links before delivery used it up and was given the session; the person
  then found the link "used or expired".
- **Now** the email links to `/sign-in/confirm?token=...&next=...` (`apps/web/app/sign-in/confirm`).
  Opening it changes nothing; the "Sign in" button posts to `confirmSignInAction`, which calls
  `auth().api.magicLinkVerify`, sets the cookies and goes to `next` (checked with `safePath`, now
  in `auth.ts`). Any failure goes to `/sign-in?link=used`. `/api/auth/magic-link/verify` is
  switched off in `createAuth` (`disabledPaths`). `SendLink` receives `token`; the email and the
  "link sent" text say to press the button.
- **Held by** `auth.sandbox.test.ts` (a scanner's GET leaves no session; the old path is 404; the
  person can still sign in once) and `projects.spec` (scanner, then person; `next` kept; second
  press says used; page audited). Tests that sign in go through the page: `testing.ts`
  `signIn` and `helpers.ts` `signIn`/`confirmSignIn`.
- **Not done:** a scanner that presses buttons would still use the link.

## Sign-in could be sent to another site by a tab

- **Found by** a browser check: `/sign-in?next=/%09/evil.example/x`, signed in, answered with a
  redirect to `/\t/evil.example/x`, which browsers read as `//evil.example/x`.
- **Now** `safePath` (`packages/server/src/auth.ts`) refuses any character up to space, DEL and
  backslash, and the parsed result must stay on this site. Every `next` goes through it (sign-in
  page, confirm page and action, the emailed address); other redirects are built from the
  server's own paths.
- **Held by** `auth.test.ts` (including a property over random strings), `auth.sandbox.test.ts`
  and `projects.spec` (signed in, and the emailed page with a tab in `next`).

## Sign-in limits that cannot be turned against people

- **Found by** the planner, with the real handler in production mode: ten requests by others
  locked an address out for most of each hour; with no `x-forwarded-for` everyone shared one
  bucket per path; a spoofed single-value `x-forwarded-for` bought a bucket each; a forwarded
  confirm link signed a person in as someone else without saying whose it was.
- **Now** `maySendSignInLink` (`packages/server/src/auth.ts`): per address a bucket of three
  links filling one per six minutes (refusal: "A sign-in link was sent to this address a few
  minutes ago. Use the newest email, or try again in a few minutes."), and an hourly cap on all
  sign-in emails, `SIGN_IN_EMAILS_PER_HOUR` (default 500). Both are decided under one database
  lock. By-client limiting of the library is on only with `TRUSTED_IP_HEADER`, kept in the
  database (`rateLimit` table, made by the library's migration), and skips a request without a
  usable single address. Migration `0029` indexes the hourly count.
- **The confirm page** shows "This signs you in as R…@example.org" (`signInLinkAddress`, read
  only), and the button is described by it.
- **Tests:** the e2e server trusts `x-forwarded-for` (`TRUSTED_IP_HEADER` in
  `playwright.config.ts`) so each test person is a client of their own; the "ten arrive" test is
  now "three arrive, nine are told a link was sent" (changed on purpose for the new rule).
- **Not done:** the by-client limit is off in a deployment that sets no header; the owner picks
  hosting and proxy (`docs/settings.md`).

## Abuse limits on comments, invitations and grammar checks

- **Found by** the planner with `testDb`: 2,000 replies in 1.1 s (10.4 MB listing); 180
  invitations from six accounts, 30 an hour to one stranger; 50 concurrent identical grammar
  checks made 50 outbound requests; a sign-in `name` kept CR/LF.
- **Now** `mayWrite` (`packages/server/src/limits.ts`) before every comment, reply, new thread
  and proposal: 60 per person per paper in ten minutes, 2,000 per paper a day
  (`COMMENTS_PER_USER`, `COMMENTS_PER_PAPER`), counted from `thread_comments` and `proposals`.
  `invite` also holds an address to a burst of three then one an hour, and the service to 200 an
  hour (`INVITATIONS_PER_HOUR`). `checkGrammar` shares one request among identical concurrent
  checks and allows 60 requests to the checker a minute per person (kept or shared answers are not counted) (`GRAMMAR_CHECKS_PER_USER`, table `grammar_requests`,
  migration 0032, which also adds three indexes). `cleanName` in `auth.ts` runs on user create
  and update. Mention emails were already capped at 60 an hour per person.
- **Tests:** one per fault in the sandbox files; the mention-email test sets
  `COMMENTS_PER_USER` high for itself, and `vitest.config.ts` sets
  `INVITATIONS_PER_ADDRESS_BURST=1000` for the others, which invite the same addresses to
  paper after paper (adapted to the new rule, not weakened).
- **Not done:** no UI change; counts are not locked, so parallel requests can pass by a few.

## Braced text macros in titles, and a focusable diff

Found by a three-person walkthrough.

- **Was:** `title = {The {\TeX}book}` was read as "The book": `plainText`
  (`packages/latex/src/bib.ts`) dropped every unknown macro, so "Look up again" said the title
  differed from the registry's "The TeXbook", and the Entry column showed "Knuth 1984. The book".
  Accents were reduced to the bare letter (`\"o` to o).
- **Now** `plainText` gives `\TeX`, `\LaTeX`, `\LaTeXe` (LaTeX2e) and `\BibTeX` as their text,
  accents as the accented letter (`\"o`, `{\"u}`, `\c{c}`, `\'{\i}`, `\v{S}`), `\ss`, `\o`,
  `\aa`, `\l` and the other letters, `\&`, `--` and `~`. An unknown macro goes alone: its braced
  text and whatever follows stay. The DOI comparison still ignores case, accents and punctuation
  (`squash`), so "Schön" and "Schon" are the same, as before.
- **Tests:** `bib.test.ts` (the converter; the old expectation "Erdos", "Schon" is now "Erdős",
  "Schön") and a sandbox test in `evidence.sandbox.test.ts` with `{\TeX}book` against a registry
  stub. Both fail on the old converter.
- **Also:** the comparison of two revisions scrolled sideways on a long line, but its `<pre>` could
  not be reached with the keyboard (axe `scrollable-region-focusable`). It is now a named region
  ("Changes to main.tex") with a tab stop and a visible outline. `a11y.spec.ts` audits it with a
  line wider than the window; that failed before.

## A `\documentclass` in an `\input`-ed file

- **What was wrong.** Import refused a paper whose root was `\input{setup}` followed by
  `\begin{document}`, with `\documentclass` in `setup.tex`, although TeX builds it (checked with
  pdflatex, xelatex and lualatex for seven layouts: `\input{setup}`, `{setup.tex}`,
  `{tex/setup}`, bare `\input setup`, `\include`, two levels, and a setup file that opens with
  `\RequirePackage`, `\PassOptionsToPackage` and a comment).
- **Now** `reachesClass` (`packages/latex/src/graph.ts`) accepts a file with `\begin{document}` whose
  text before it, or a file it `\input`s or `\include`s there, has `\documentclass`. It is only a
  second choice: archives with a file holding both words pick their root as before. `findRoot` and
  the importer (`papers`, `describeImport`) use it; the Latin-1 probe does not. The walk reads each
  file once, eight deep, 50 files, 1 MB. A dynamic `\input{\dir/x}`, an `\input` after the body, a
  commented one and a cycle do not count. Every other part already followed preamble `\input`.
- **Wording changed on purpose:** the refusal now reads "No file here has \begin{document} with a
  \documentclass before it, in that file or in a file it \inputs." (`import.sandbox.test`,
  `tests/e2e/import.spec.ts` follow).
- **Held by** `graph.test` (seven layouts, four refusals), import and worker sandbox tests and a
  browser test that imports the split ZIP and builds it.

- **Footnote chip reads as words.** In the visual editor a `\footnote{...}` chip now shows
  `Footnote: See appendix.` (note body through `plainText`, cut at 40 characters with an ellipsis),
  with the full LaTeX still in the title and "footnote: ..." as its accessible name. Editing is
  untouched. `plainText` no longer mistook `\textbf`, `\cite` and the like for the `\t` accent.
  Held by `footnote.test`, `bib.test` and `tests/e2e/atoms.spec.ts`.
- **Import report opens with a summary line.** `summarizeImport` (`packages/server/src/import.ts`):
  "Imported N files: root main.tex, compiler pdflatex, M% of body prose editable visually, K
  source-only files." from what `describeImport` already computes (K counts preamble files shown in
  source only). Held by `compiler.test` and `tests/e2e/atoms.spec.ts`.

## `.git` and `__MACOSX` no longer count against the import limits

- **What was wrong.** A ZIP of a paper's working folder was refused because `.git`, `__MACOSX`,
  `.svn`, `.DS_Store` and `Thumbs.db` entries were counted and checked (symbolic link, name length,
  duplicates, 2000 files, sizes) before they were skipped, although they are never opened. A git
  clone with over 2000 loose objects, or a Finder ZIP with many `__MACOSX/._*` twins, said "it has
  too many files"; the `__MACOSX` twin of a long name said "a file name in it is not usable"; a
  symbolic link inside `.git` refused the whole archive.
- **Now** `readZip` (`packages/server/src/archive.ts`) skips system entries right after the folder
  check: neither counted nor checked, and still not listed in `skipped`. A new `entries` limit
  (50,000, every entry in the archive) is checked once from the ZIP's own entry count before any
  entry is read, so the skip cannot be used to make the reader walk an endless archive.
- **Held by** `archive.test` (`.git`, `__MACOSX` twins, long-name twin, paper files still counted,
  entry bound) and two sandbox tests in `import.sandbox.test` (a zipped working folder with `.git`
  imports as the paper alone; a symlink inside `.git` imports). The hostile-archive test's
  symbolic link row (`link.tex`) is still refused.
- **Not done.** Other unwanted folders such as `node_modules` or `.venv` still count and can
  refuse. (Fixed in "Files the import leaves out no longer refuse the ZIP".)

## The import report names files LaTeX cannot use

- **What was wrong.** A paper imported with `figs/result#1.png` (or `%`, `"`, `{`, `}` anywhere in a
  path) was accepted with no word in the report that LaTeX cannot name it; the team found out when a
  build failed or a rename was refused.
- **Now** `describeImport` (`packages/server/src/import.ts`) lists the paths that fail `texName` in
  `report.unnamable` (sorted), and the web import report shows one item naming the first 10 and "and
  N more", with "Rename them before using them." Nothing shows when there are none. Import still
  succeeds. Reports stored earlier have no field and render as before.
- **Held by** `compiler.test`, `import.sandbox.test` and `tests/e2e/atoms.spec.ts`.
- **Not done.** The files are not renamed for the user, and the file list does not mark them.

## A proposal that would break as LaTeX says so

- **What was wrong.** A proposal's replacement is stored and applied as LaTeX source, and only
  its type, length and `\r` were checked. A reviewer typing `12% faster` silently dropped the rest
  of the source line from the PDF (latexmk exits 0, no warning); `Smith & Jones`, `item_1` and `#2`
  broke the build; `$5` or `\emph{much` left a group open. The owner saw a card with nothing wrong.
- **Now** `replacementHazards` (`packages/latex/src/hazards.ts`, pure) is run by `listProposals` for
  open proposals whose words still stand, and its messages come back as `Proposal.latex`. The card
  shows them under "Written as LaTeX, this would not come out as it reads". It is advisory: Accept
  stays allowed. A `%` that opens a comment is found anywhere in the file (`commentOpen`, moved from
  the bridge into `@paperweave/latex`). An unfinished group or a bare `& # _ ^` is found by parsing
  only the paragraph around the edit before and after, and reporting what the change adds. The
  change form says "This is LaTeX: write \% for %, \& for &, \_ for \_."
- **Held by** `hazards.test` (table of cases), `proposals.sandbox.test` and `tests/e2e/proposals.spec.ts`
  (warning shown, Accept enabled, gone after the change is written with `\%`, axe audit).
- **Not done.** `%` inside `verbatim` or `lstlisting` is flagged. Unfinished groups and bare
  characters are not found in raw blocks (captions, tables, nested lists), lists with blank lines
  between items, or the preamble (the comment check still works there). A paragraph over 40 KB
  is not parsed. `$5 to $3` written wholly inside the replacement is a valid formula and is not
  flagged. Critique and grammar replacements are not checked.

## Invisible and unusual spaces broke pdfLaTeX builds

- **Before:** a zero-width space (U+200B), a thin or narrow space (U+2009, U+202F), an en or em
  space, a direction mark and similar, typed or pasted into the visual view, went into the source
  as they were. pdfLaTeX stopped at them with "Unicode character (U+200B) not set up for use with
  LaTeX", the message carried the raw character (invisible, and a direction mark can reverse the
  line it is in), and the source view showed nothing at the line it named. XeLaTeX and LuaLaTeX
  built, but dropped the space, so two words joined.
- **Now:** `escape()` writes thin and narrow spaces (U+2006, U+2008, U+2009, U+200A, U+202F) as
  `\,`; the other fixed-width spaces and line and paragraph separators (U+2000 to U+2005, U+2007,
  U+205F, U+2028, U+2029) as one plain space; and drops zero-width and direction characters
  (U+200B, U+200E, U+200F, U+202A to U+202E, U+2060, U+2066 to U+2069, U+FEFF). Typing one that is
  dropped changes nothing in the source (no empty edit, no `{}` after a macro), and a pasted
  paragraph of nothing else is not kept. U+00AD, U+200C, U+200D and U+3000 are left alone: they
  build everywhere or mean something in other scripts. `\,` shows in the visual view as a raw
  chip, which is accepted.
- **Source view:** these characters, and the ones CodeMirror already marks, show as a red dot
  titled "Invisible character U+XXXX". U+00A0, U+200C, U+200D and U+3000 are not marked.
- **Build error:** "Unicode character X (U+XXXX)" now reads "An invisible character (U+200B) is in
  the text here, and pdfLaTeX stops at it. Delete it: the source view shows it as a red dot." or,
  for a visible one, "pdfLaTeX has no character set up for ≤ (U+2264)." File and line are kept.
  Cached builds were meant to be redone (`TEX_TEXT` gaining `-unicode`), but only the comment changed; the constant did not until the nullfont change below.
- **Not fixed:** characters already in a source or an imported file are never rewritten; the
  source view now shows them and the error names the line.

## A file with mixed line endings can be edited

- **What was wrong.** One stray CRLF (or lone CR) in an otherwise LF file made `decodeFile` call the
  whole file uneditable. A ZIP whose `main.tex` had one CRLF was refused with "No file here has
  \begin{document}...", a chapter or `.bib` imported but could never be edited, commented on or
  proposed against, and an Excel-style CSV (CRLF rows, LF inside a quoted cell) was refused as "not
  UTF-8 text".
- **Now** such a file is editable (`FileMeta.mixed`, set only when true). Its stored bytes stay as
  uploaded until someone edits it; from the first edit it is written with its commoner line ending
  (a tie, or all lone CR, gives LF). The import report has a note naming the files (first 10, "and N
  more"). A restore of such a file is not taken as "the revision's bytes" (`revisions.ts`), so the
  next automatic cut does not make a spurious revision. Rows imported before this stay read-only
  (the file list says to upload the file again); no migration.
- **Held by** `encoding.test`, `parse.test`, `compiler.test`, and sandbox tests in `import`,
  `data` and `revisions`. The byte-for-byte export of every encoding fixture is unchanged.
- **Not done.** A mixed file typed in and taken back (more than one change, same text) exports
  uniform bytes and so makes one new revision.

## A sign-in that runs out closes its editors

- **What was wrong.** The sync server asked only whether a session row existed. An expired row
  is not deleted, so an editor opened under it kept saving as its person until the connection
  dropped, and a new connection under it was let in.
- **Now** both the check at connect time and a check every minute (`sessionCheckMs`, fixed in
  the service, shortened only by tests) treat an expired row like a missing one: the connection
  is closed with `signed-out`, which the editor already handles. Tickets that name no sign-in
  are exempt as before.
- **Not done.** No per-edit check: for up to a minute after the expiry an edit is still taken.
  A connection under a run-out sign-in is closed when the server accepts it, so the editor may
  receive the file's text once before that.

## A replaced file nobody had opened left the build "up to date"

- **What was wrong.** Uploading a new `refs.bib` (or `.sty`, `.cls`, `.csv`, a generated `.tex`) with
  "Replace the file of this name" did not make the build stale if the file had never been opened in
  the editor. The editor said "The PDF is up to date." and did not rebuild, and the check before
  submitting said nothing stood in the way and offered the ZIP and PDF of the old revision, holding
  the old file. The stale rule compared a file's digest only for files that are not text, and an
  unopened text file keeps `head_seq` 0 when it is replaced, so no clause fired.
- **Now** the digest is also compared for text whose log is empty or holds only the upload itself
  (`head_seq <= 1`). Text with edits (`head_seq > 1`) is still read from its log, as its digest in
  `files` is the old upload and would always differ. A file opened but not edited, mixed line
  endings included, is not stale after its build: `cut()` takes `files.digest` for it.
- **Held by** a sandbox test in `builds`: replace an unopened `refs.bib` (stale, the checks are not
  ready, the next build's ZIP holds the new file), replace it again after opening with the same text
  in other line endings (stale, then built), and replace it with its own bytes (not stale).
- **Not done.** An already-edited text file (`head_seq > 1`) replaced by an upload that differs only
  in line endings or byte order mark still reads as up to date: the PDF is the same, but the built
  revision's ZIP keeps the old line endings.

## Restoring a revision brings back whether a file is text

- **What was wrong.** A restore swapped a read-only file's digest and nothing else. If a Latin-1
  `refs.bib` had since been replaced by a UTF-8 copy, restoring an earlier revision left it
  marked editable text: a never-opened file could not be opened, an opened one showed the UTF-8
  text while builds and exports read the Latin-1 bytes, and an edited one was not restored at all.
- **Now** a restore makes each file's text-ness match the revision's bytes. A file that is text
  but whose revision bytes are not UTF-8 goes back to read-only (`eol`, `bom` cleared,
  `not-utf8`) and its connected editors are closed with `no-access`, as for a removed file. A
  read-only file that is text in the revision becomes text again and, if it has a log, the log is
  edited to the revision's text. The log is never deleted. `replaceFile` also syncs the log when a
  once-text, now read-only file gets a UTF-8 replacement.
- **Held by** sandbox tests in `revisions` (unopened, opened and edited cases; restoring forward
  again with a thread; replacing a read-only file that has a log) and in `sync` (editor closed).
- **Not done.** The editor's closing notice says "no longer have access... or deleted". Old
  read-only rows from mixed line endings are still not migrated.

## Table cells ignore comments, and a wrapped caption is not rewritten by Enter

- **What was wrong.** A table cut its cells from the source, comments included. A commented-out
  row ran into the next row's first cell (shown with a `%` that could not be saved, and "Delete
  column 1" removed the commented row too); a `% note` after `\\` moved onto a new row when one was
  added below; a commented-out last row showed as a phantom row; a `% was 2` at the end of a cell
  swallowed the `&` of a new column; and `\\%` was taken for an escaped percent. In the visual view
  the field for a caption or cell was a one-line input, so a caption wrapped over lines read as
  joined text and an unchanged Enter wrote the joined text, and `\caption{%` followed by a line
  break was written back as `\caption{%  Text}`, commenting out the closing brace.
- **Now** comments are left out of the cells and of the rows: a comment line above a row, or on a
  row's own line after `\\`, stays where it is when rows and columns are added or removed. A comment
  inside a cell makes the table not simple. The field shows a part as one line (`fieldText`), with
  bare `%` line-enders joined, and Enter on an unchanged field writes nothing.
- **Held by** unit tests in `floats.test.ts` and a Playwright test in `tables.spec.ts`.
- **Not done.** A caption or cell with a worded comment or a blank line is read-only in the visual
  view (edit it in the source). Bare `%` line-enders and line breaks inside a part are not kept when
  the part is changed. `\verb|%|` in a cell is taken for a comment.

## Inviting someone already on the paper

- **What was wrong.** "Send invitation" accepted the address of someone already on the paper, the
  owner's own included, stored it and emailed a link that promised a role it could not give: the
  recipient was told "This invitation does not change that".
- **Now** `invite()` refuses an address that is already a member (matched without regard to
  case), stores nothing and sends no email. The page's alert names their current role and points
  to the role control under People ("Change"). Someone removed can still be invited again.
  Accepting is unchanged: an old link never changes the role of someone already in.
- **Held by** `projects.sandbox.test.ts` and a Playwright test in `projects.spec.ts`.
- **Not done.** The invitation page's "already on this paper" answer is now only a defence for
  old links, and has no browser test.

## Visual edits no longer glue words onto a command name

- **What was wrong.** Taking bold or emphasis off wrote the words straight onto the command before
  them (`\noindent\textbf{Setup.}` became `\noindentSetup.`, which does not build; `\item\textbf{Speed}`
  broke the list). A space typed, pasted or exposed by a deletion right after a command name
  (`\sys. It` with " today" typed) was shown in the visual view but dropped by LaTeX (`Systoday.`).
- **Now** `guard()` puts `{}` between a command name and a following space or tab, and
  `markCommand` guards both sides of the replacement as pasted text is. A wrap's bytes do not change.
- **Held by** unit tests in `bridge.test.ts` and a build test in `compile.sandbox.test.ts`.
- **Not done.** Source that already reads `\sys is` or `\sys` followed by a line break is still
  shown with a space LaTeX drops; a line break exposed after a command by a deletion gets no `{}`;
  putting bold back on leaves the `{}` (`\noindent{}\textbf{Setup.}`); source-view paste and
  grammar replacements are unguarded as before.

## A comment on a long passage keeps all of it through export and import

- **What was wrong.** A review file keeps at most 500 characters of the words a thread is on, so
  an imported thread on a longer passage was attached to only the first 500. Editing the rest
  never marked it "Changed since".
- **Now** the review file's thread has optional `length` and `hash` (of the whole passage),
  written only when the passage is longer than the quote. On import, if the text at the found
  place still hashes to it, the thread is attached on the whole passage and its fingerprint is
  that hash. Otherwise, and for files without them, it is placed on the quote as before. The
  quote, `before` and `after` are unchanged, so older files and the placing of quotes are not
  affected.
- **Held by** three service tests in `reviewdata.sandbox.test.ts`: a long thread arrives on all
  700 characters and reads "changed" when the tail is edited; the file carries `length` and
  `hash` for the long thread and not the short one; and a tail that differs on arrival falls
  back to the quote (a guard that also passed on the old code).
- **Not done.** A long thread whose text beyond the first 500 differs on arrival is placed on
  its first 500 without a report line. The comment panel still shows only the first 500.

## A stray character in a TikZ picture no longer stops a submit

- **What was wrong.** One harmless stray character in a `tikzpicture` (`;;`, `\end{scope};`)
  built fine, but TeX logs it as "Missing character ... in font nullfont", which was reported as
  "Characters not shown". The submit page then refused the paper and offered no ZIP or PDF, and
  the build pane said some things were not in the PDF on every build. XeTeX's `("3B)` form of the
  code was not read at all. The earlier `TEX_TEXT` bump to `-unicode` was only in the comment.
- **Now** characters lost in `nullfont` get their own warning, "Stray character in a picture: ;
  is typed where TikZ draws no text (outside a node) ...", one per file, so the submit page lists
  it under "Worth a look" and the paper is ready. XeTeX's `("3B)` form is read (a real missing
  glyph under XeLaTeX is now reported too). `TEX_TEXT` is now
  `utf8-biber-eps-glyphs-strings-forcedate-unicode-nullfont` (this applies the `-unicode` bump
  too) and its comment block is repaired.
- **Held by** unit tests in `diagnostics.test.ts` and sandbox tests for pdfLaTeX, XeLaTeX and
  LuaLaTeX in `compile.sandbox.test.ts` and a submit test in `submit.sandbox.test.ts`.
- **Not done.** No line number (TeX gives none). Text meant to be shown but typed outside a node
  is only a warning.

## A paper with a ready-made `.bbl` and no `.bib` had every citation called missing

- **What was wrong.** An arXiv source often has `main.bbl` and no `.bib`. The import keeps the
  `.bbl` and it builds, but the citation report read only `.bib` files and `\bibitem`s in `.tex`
  files, so every `\cite` was "missing": the project page said the PDF shows a question mark
  (false), the submit page had a warning for each citation, the insert-citation picker was empty,
  and evidence could not be recorded ("The bibliography has no entry called k").
- **Now** a paper with no `.bib` file at all reads its `.bbl` for keys: the root's own
  (`main.tex` has `main.bbl`, in the same folder; with no root, every `.bbl`). Both a BibTeX
  `thebibliography` and a biblatex `\entry` are read, each key once. A key a `.tex` `\bibitem`
  already has is not added again. They show as entries with a place and a one-line description,
  and evidence can be recorded for them. (The import note said "its entries can be cited, but
  not changed or added to here"; it now says how to change it, see the section on a ready-made
  `.bbl` below.) The `.bbl` is not editable in the source editor.
- **Held by** unit tests in `bib.test.ts` and sandbox tests in `citations.sandbox.test.ts`,
  `evidence.sandbox.test.ts`, `import.sandbox.test.ts` and `submit.sandbox.test.ts`.
- **Not done.** A `]` inside a braced `\bibitem` label; a key BibTeX broke across lines with `%`;
  a biblatex `.bbl` whose header names another format version (a warning here, not a build error); a DOI
  lookup for `.bbl` entries.

## Renaming a chapter left `\includeonly` on the old name, and the chapter dropped out of the PDF

- **What was wrong.** `\includeonly{...}` was not read as naming files, so renaming a chapter
  with its references changed the `\include` line but not the `\includeonly` entry. TeX then
  built without error and silently left the renamed chapter out of the PDF.
- **Now** each `\includeonly` entry is read as a name (kind `only`) and renaming a file rewrites
  the entries that point at it, written as a plain `\include` would be: from the root's folder,
  with the extension only if it was written. The include graph ignores them: they make no edge,
  are never walked, and are never reported missing, so a chapter named there is still read where
  it is `\include`d and not in the preamble.
- **Held by** unit tests in `graph.test.ts` and `files.test.ts`, and a sandbox test in
  `files.sandbox.test.ts`.

## Opening another page no longer drops edits the sync service has not confirmed

- **What was wrong.** The only guard on unsaved edits was the browser's `beforeunload`, which does
  not fire on a client-side navigation. With the web app answering but the sync service away
  (restarting, WebSockets blocked, reconnecting after a wake, signed out), clicking another file,
  "Paper overview", or double-clicking PDF text from another file unmounted the editor and
  destroyed the only copy of what was typed, with no warning.
- **Now** such a click, or a PDF jump to another file, asks "What you typed in the file has not
  been saved yet... Leave anyway?" when the file has unconfirmed edits and the tab is either not
  connected or the last change was over 2 seconds ago. Plain clicks only: new-tab links,
  ctrl/cmd/middle clicks, `#text` and links to the open file never ask. Agreeing does not also
  bring up the browser's own prompt. "Discard my edits" never asks.
- **Held by** unit tests in `apps/web/lib/leaving.test.ts` and two tests in
  `tests/e2e/recover.spec.ts`.
- **Not done.** Back/Forward cannot be cancelled and still drops unsaved edits silently.

## A figure from the Figure dialog broke the build in the AMS template, and the error did not say why

- **What was wrong.** The AMS template did not load `graphicx`, but the Figure dialog (and a drawn
  chart) writes `\includegraphics`. The build failed with no PDF and the pane showed only
  `Undefined control sequence.`, because the log line that names the command was dropped. Any
  imported paper without `graphicx` behaved the same.
- **Now** the AMS template loads `graphicx`, and an "Undefined control sequence." build error
  names the command (`LaTeX does not know \nosuchmacro.`). For `\includegraphics` and `\eqref` it
  also says which package to add (`graphicx`, `amsmath`). The message keeps its old first sentence.
- **Held by** unit tests in `diagnostics.test.ts` and `templates.test.ts`, and sandbox tests in
  `templates.sandbox.test.ts` (a dialog-written figure builds from every template) and
  `compile.sandbox.test.ts` (real TeX log).
- **Not done.** The dialog does not add the package itself, and other packages' commands get only
  the generic sentence. A build that failed before keeps the bare message until it is rebuilt.

## The submit check said ready when an `\includeonly` left chapters out of the PDF

- **What was wrong.** With `\includeonly{ch/a}` in the root's preamble, TeX builds without error
  and reads only `ch/a`, so the PDF silently lacked every other `\include`d chapter. The submit
  check saw nothing wrong and offered the downloads.
- **Now** `leftOut` (in `graph.ts`) finds the `\include`d chapters of the files the paper reads that
  the last `\includeonly` before `\begin{document}` does not name, and the submit check reports
  them as a `file` problem naming them (at most five, then "and N more") and the way out: take
  the `\includeonly` line out, or the `\include` lines of what is not meant to be there. The
  problem points at the `\includeonly` line. Names are compared as TeX does, as plain strings
  after trimming, dropping quotes and a trailing `.tex`: `./ch/a` is not `ch/a`. An empty
  `\includeonly{}` leaves every `\include`d chapter out. A commented-out `\includeonly`, one
  that names a macro, or one after `\begin{document}` (already a build error) is ignored.
- **Held by** unit tests in `graph.test.ts` and `submit.test.ts`, and a sandbox test in
  `submit.sandbox.test.ts`.
- **Not done.** An `\includeonly` inside a file the preamble reads with `\input`, `\includefrom`
  and `\subincludefrom`, and an `\include` under `\iffalse` or after `\end{document}` (read as
  live) are not handled. A left-out `\include` of a file the paper lacks also gets the existing
  "not among the paper's files" warning.

## A paper from a Mac with accented file names failed to build, or imported with garbled names

- **What was wrong.** macOS writes file names decomposed (`U` and a combining diaeresis) where
  authors type them composed, and names were stored as given. The paper's `\includegraphics` and
  `\input` then missed the file, and the builder wrote the stored bytes as the file name, so TeX
  said "File not found" for a paper that built on the author's Mac. Separately, a ZIP name
  without the UTF-8 flag was read as CP437, so a UTF-8 name came out as mojibake.
- **Now** names are kept in Unicode NFC whether they come from a ZIP, an upload, a new file, a
  replace or a rename (`nfc` in `archive.ts`). A ZIP name without the flag that is valid UTF-8 is
  read as UTF-8; one that is not (real CP437) keeps its old reading. Two ZIP names that are the
  same once composed are refused as the same file twice. Replacing a file by its composed name
  replaces a file stored decomposed before this change, instead of adding a look-alike. Review
  data and a carried root file find files by their composed names.
- **Held by** unit tests in `archive.test.ts`, sandbox tests in `files.sandbox.test.ts` and a
  build test in `builds.sandbox.test.ts`.
- **Not done.** A reference written decomposed in the source is not matched (typed references are
  composed). Paths already stored decomposed are not rewritten; renaming one to its own name
  fixes it.

## A ready-made `.bbl` could not be added, replaced or renamed

- **What was wrong.** The name check refused every `.bbl` ("not a file type a paper uses"), so a
  paper that came with only a `.bbl` could not have its bibliography updated, a deleted `.bbl`
  could be put back only by restoring a revision, and after the root was renamed the `.bbl`
  could not be renamed to match (TeX reads `\jobname.bbl`, so the bibliography was orphaned). The
  import note told the author it could not be changed.
- **Now** a name ending in `.bbl` (any case, any folder) is accepted when a file is added,
  replaced or renamed (`checkPath` in `archive.ts`); `.aux`, `.blg`, `.log` and `.synctex.gz`
  are still refused. It stays a stored, read-only binary file: replacing it keeps its id, cuts a
  revision, and makes the last build stale. The citation report reads the `.bbl` as it stands now,
  including edits to a text file that was renamed to it. The import note now ends "To change it,
  upload a new copy with "Replace the file of this name" ticked".
- **Held by** a unit test in `archive.test.ts`, sandbox tests in `files.sandbox.test.ts`,
  `citations.sandbox.test.ts` and `builds.sandbox.test.ts`.
- **Not done.** Editing a `.bbl` in the source editor; the "left out" reason does not say a `.bbl` can be uploaded.

## A paper whose root is a `.ltx` file never built

- **What was wrong.** The import and "make this the root" accept a `.ltx` file as the root, but
  the build service refused any root not ending in `.tex`, so the author saw "could not run this
  build. Try again" for ever.
- **Now** the builder accepts a `.ltx` root as it does a `.tex` one, and the PDF, log and SyncTeX
  names drop `.ltx` the same way.
- **Held by** a build test in `compile.sandbox.test.ts` (with SyncTeX mapping back to `main.ltx`).
- **Not done.** Nothing known.

## The import dropped a paper's ready-made `.bbl` whenever any `.bib` was in the archive

- **What was wrong.** `readZip` set aside every `.bbl` if the archive held any `.bib`, whatever
  the paper named: a paper with `\bibliography{library}`, its `main.bbl` and a leftover template
  `.bib` lost the `.bbl` and could make no bibliography; a `.bib` in one paper's folder cost
  another paper its `.bbl`; a paper that `\input`s `main.bbl` failed on a missing file. The
  citation report read a `.bbl` only when the paper had no `.bib`.
- **Now** `readZip` hands the set-aside `.bbl` files back, and the import (`keepBbls`) keeps the
  ones a paper needs, found by `readyMadeBbls` in `graph.ts`: one a file the root reaches reads by
  name, and the root's own (`main.tex`, `main.bbl`) when a file the root reaches names a `.bib`
  that is not in the archive from the root's folder, or names one through a macro. The rest are
  dropped as before. The import report says why a `.bbl` was kept. The citation report reads the
  same set when the paper has a `.bib` (`bblFiles` in `labels.ts`). The build needs no change:
  `latexmk -bibtex-cond` does not run BibTeX when a named `.bib` is missing, so the `.bbl` is used
  (that holds only where a `.bbl` exists; with none, see the section on a missing `.bib` below).
- **Held by** unit tests in `graph.test.ts`, `archive.test.ts` and `import.test.ts`, sandbox tests
  in `import.sandbox.test.ts`, `citations.sandbox.test.ts` and `builds.sandbox.test.ts`.
- **Not done.** A `.bib` named only inside the paper's own `.cls` or `.sty` is not seen; a
  named `.bib` that is present but incomplete still replaces the `.bbl`; a paper
  that `\input`s its `.bbl` and has no `\bibliography` imported with the `.bbl` but did not
  build; fixed below (the cause was the root's own `.bbl` being read, not the `\citation` lines).

## A paper that `\input`s its own `.bbl` and has no `\bibliography` failed to build

- **What was wrong.** latexmk makes a BibTeX rule (`bibtex main`, source `main.aux`) for any `.bbl`
  TeX reads. `-bibtex-cond` skips BibTeX only when the rule's `.bib` is missing; with no
  `\bibdata` there is no `.bib` to be missing, so BibTeX ran, said "I found no \bibdata command",
  truncated `main.bbl` to 0 bytes and latexmk exited 12, so no PDF. `\input{refs.bbl}` escaped only
  because `refs.aux` does not exist.
- **Now** `LATEXMK_RULES` sets latexmk's BibTeX command to `pw_bib`. It runs real `bibtex` unless the
  `.aux` exists and neither it nor any `.aux` it `\@input`s has a `\bibdata` line; then it writes a
  stub `.blg` (latexmk reads the log) and returns 0, leaving the `.bbl` alone. Real BibTeX errors
  (bad `.bst`, `\bibliography` without `\bibliographystyle`) still fail. The download command
  uses the same rules. `TEX_TEXT` is bumped so a cached failed build is not reused.
- **Held by** `builds.sandbox.test.ts` (no `.bib`, an unrelated `.bib`, and `\nocite{*}`); the existing
  BibTeX-error, missing-`.bib` and manifest-command sandbox tests pass unchanged.
- **Not done.** Nothing known.

## A biblatex paper with a ready-made `.bbl` and no `.bib` built, but the submit check refused it

- **What was wrong.** With `\addbibresource{refs.bib}`, a biber-made `main.bbl` and no `refs.bib`,
  the build succeeded and the PDF was right, but the worker's "Biber could not find the
  bibliography file refs.bib." diagnostic has severity error, and the submit check made every
  error a problem: not ready, no revision, no ZIP or PDF to download.
- **Now** the submit check reads that diagnostic as a warning when the last build succeeded
  (`readyMadeMessage` in `submit.ts`), saying the bibliography was not made again and the PDF
  shows the ready-made `.bbl`. On a failed build (no `.bbl`) it stays a problem. A citation the
  `.bbl` lacks is still a citation problem.
- **Held by** a unit test in `submit.test.ts` and a sandbox test in `submit.sandbox.test.ts`
  (ready with a `.bbl`; a guard that the same paper with no `.bbl` is still refused).
- **Not done.** The stored diagnostic is still severity error (only the submit check reads it
  differently); the generic "LaTeX found it elsewhere" warning for the same `.bib` remains.

## The comparison of two revisions showed the whole file and never said which words changed

- **What was wrong.** The page listed every line of a changed file, so one number changed in a
  400-line file meant reading 200 lines to find it, and a long line (a paragraph on one line)
  scrolled sideways. A changed line was struck or bolded whole, so which word changed was a hunt.
- **Now** `diffHunks` in `textdiff.ts` keeps the changed lines and three around each, says how
  many unchanged lines were left out before each group and after the last, and for a removed line
  and an added line that are counterparts marks the words that changed (`<del>` and `<ins>`).
  Lines wrap, with the wrapped part hanging under the text. A file whose text is the same but for
  line endings or encoding says so instead of showing an empty block.
- **Held by** unit tests in `textdiff.test.ts` and a browser test in `revisions.spec`
  ("a comparison shows only what changed, and which words"), which failed on the old page. One
  expectation in `a11y.spec` changed: a long added line used to make the comparison scroll
  sideways, now it wraps, so that test expects no sideways scroll (the region keeps its name and
  tab stop, and the audit and focus check are unchanged).
- **Not done.** The line-endings-only sentence was not looked at in a browser. At most 200 pairs of
  lines per file are compared word by word. Lines were paired by position, only when a run had as
  many removed lines as added ones; see "The comparison lost its word marks when a line was added
  beside a changed one".

## A paper could not be renamed

- **What was wrong.** The name given when a paper was made was for good: a typo or a working
  title like `paper-final-v3 (1)` stayed on every page, email and download.
- **Now** the owner can rename the paper from a form on its page (`renameProject` in
  `projects.ts`, under the existing `project.settings` right, with the same one-line,
  at-most-200-characters rule as a new paper). The name is read live, so revisions, downloads
  and other people's pages show the new name; a rename makes no revision. Pages already open show
  the old name until reloaded.
- **Held by** a sandbox test in `projects.sandbox.test.ts` (only the owner may; bad names refused;
  an old revision is titled with the new name) and a browser test in `projects.spec`
  ("the owner renames a paper; a viewer cannot"), which failed before.
- **Not done.** Editors cannot rename; no history of old names; no live update of open pages.

## A brace left open in an input file was blamed on the root, and the build errors could not be followed

- **What was wrong.** With `\input{sections/method}` in `main.tex` and an unclosed `\textbf{` in
  `method.tex`, the pane said `main.tex:8 File ended while scanning use of \textbf`, the line of
  the `\input`, not the file with the brace. The same for `\footnote{` and `\caption{`. And the
  file and line of each build error were plain text: finding the place meant opening the file
  and counting lines.
- **Now** `runaway` in `apps/workers/src/compile.ts` reads which file TeX closed just before
  "Runaway argument?" (`readingAt` also records the files it sees closed) and, when only
  whitespace lies between, names that file, with no line, and says where it was read from ("read
  from main.tex line 5"). A file from TeX's own installation, or the root itself, changes
  nothing. `TEX_TEXT` in `builder.ts` is bumped, so a cached failed build is made again.
  In the build pane, an error, a `??` warning or a "not in the PDF" entry whose file is one the
  editor can open is a button that shows the file at the line (`showInEditor`, the same path as
  a click in the PDF), in the open file or by going to another; the text is as before.
- **Held by** unit tests on the real log (`diagnostics.test.ts`: file, folder root, footnote;
  guards for text before the runaway and an installed file), a compile
  (`compile.sandbox.test.ts`) and a browser test (`building.spec`: by pointer, in the open file,
  by keyboard, audit), each failed before the change.
- **Not done.** The unclosed-brace error has no line. (`\begin{itemize} on input line 4 ended by
\end{document}` is placed in its own file now: see "An environment left open in an input file".)

## A read-only visual view could not be reached by keyboard

- **What was wrong.** Tiptap gives the visual text `tabindex="0"` only while it is editable. For
  a viewer or reviewer, or a locked file, a long paper in the visual view scrolled but had
  nothing in it to focus: in Safari the keyboard could not scroll it, and the audit's
  `scrollable-region-focusable` rule applies. The source view had the same gap for the audit
  while editable, since a bare contenteditable reads as `tabIndex` -1. The test called "the
  visual view for someone who cannot edit" audited the source view, because the view last used is
  remembered.
- **Now** both texts always carry `tabindex="0"`: the source through `contentAttributes`
  (`FileEditor.tsx`), the visual through `coreExtensionOptions` (`lib/visual.ts`). Tab order for
  editable editors is unchanged. `recover.spec` audits a long file in both views, checks that
  the read-only visual text is reached with Tab and scrolled with PageDown, and that typing
  there changes nothing.
- **Not done.** Someone using only the keyboard probably cannot select text in the read-only
  visual view to start a comment: there is no caret.

## TeX accents and national letters showed as raw chips in the middle of a word

- **What was wrong.** `Caf\'e`, `Erd\H{o}s`, `Sch\"{o}n`, `{\'e}t{\"u}de` and `Gro\ss{}e` were read as
  a word, a raw chip, and the rest of the word, so the visual view broke a name in three and the
  grammar check read `Caf\'e` as "CafDummye".
- **Now** the parser reads the common accent commands (`\'e`, `\"{o}`, `\H{o}`, `\c{c}`, `\v{S}`,
  `\'{\i}`, …), the same wrapped in braces (`{\'e}`, `{\c{c}}`), and the national letters `\ss`,
  `\ae`, `\oe`, `\aa`, `\o`, `\l` and their capitals as one `esc` piece showing the composed
  character (`accentAt` in `parse.ts`). Only a pair whose composed form is a single UTF-16
  unit qualifies, since an `esc` is one display position. A bare `\ss` ends the piece only when
  the next character is not a letter or a space; typing after it writes `\ss{}` first. The
  source bytes are untouched: typing next to one lands on its edge, deleting the character
  removes the whole command, and copying gives the source.
- **Held by** tests in `parse.test.ts`, `prose.test.ts` and `bridge.test.ts` (including a small
  fuzz over a document dense with supported and unsupported forms), six new fragments in the
  shared fuzz list, and a browser test in `visual.spec` ("TeX accents show as one character
  each…"), which failed before. A test that unsupported forms stay raw passes before and after.
- **Left out.** Forms with a space (`\' e`, `\c c`; `Gro\ss e` is done, see the text commands section below),
  which need a guard rule of their own; accents with no single-unit composition, `\t`, `\d`, `\b`, standalone `\i` and `\j`,
  `\dh`, `\th`; a paper that redefines these commands is not checked for; `\LaTeX`, `\ldots`,
  `--` and ``…'' are still chips; accents inside raw atoms are unchanged; typing `é`still writes
  UTF-8; the chip's double-click LaTeX window is gone for these. A paragraph made only of`\AA{}` is still a raw block, as before.

## A reviewer can select text in the visual view with the keyboard

- **What was wrong.** The visual view was `contenteditable="false"` for anyone who cannot write,
  so a reviewer using only the keyboard had no caret and could not select the text that "Comment
  on the selected text" and "Propose a change here" act on. Only the source view selected.
- **Now** the visual view stays editable for reviewers and viewers (`setLocked` in
  `FileEditor.tsx` no longer shuts it for a non-writer) and refuses every change in
  `lib/visual.ts`: `filterTransaction` turns away any document change that is not a remote
  update (`projection`), a keydown guard refuses typing, Enter, Backspace, Delete and undo, redo,
  bold and emphasis, and paste, drop, cut and the mark commands refuse with the note "You can
  read this paper but not edit it. Nothing was changed." The text carries `aria-readonly="true"`,
  `inputmode="none"` and no spell-checking. A writer who is locked (file not arrived, refused,
  too large, role lowered) is still `contenteditable="false"`. The server's role check is
  unchanged and remains the guarantee.
- **Presence.** A reviewer's caret in the visual view is not shared with the others (as before):
  `moved` is only called for editors that can edit.
- **Tests.** `keys.spec` "a reviewer selects words in the visual view with keys alone..." (fails
  before: no selection). The reviewer assertions in `visual.spec`, `insert.spec` and
  `recover.spec` now expect `aria-readonly="true"` and `contenteditable="true"`.

## Files the import leaves out no longer refuse the ZIP

- **What was wrong.** `readZip` ran every entry that is not a system entry through the symbolic
  link, encryption, name, duplicate, count and size checks before looking at its type. Entries the
  import never opens (`node_modules`, `.venv`, data files, videos, pictures LaTeX cannot read, the
  toolchain file, build output, `latexmkrc`) could therefore refuse the whole archive: a 60 MB
  `data/raw.h5` ("too large"), 2,001 `.pyc` files ("too many files"), a symbolic link `Makefile`,
  a long path under `node_modules`, seven 45 MB videos ("too much data"). A report with thousands
  of left-out files was also thousands of list items.
- **Now** the type is decided first (`archive.ts`). An entry whose type the import leaves out is
  never read, checked or counted, except toward the 50,000-entry bound; it is listed in `skipped`
  once, with the same reason as before, and not at all if its name has a control character or is
  too long to show. Wanted files, `.bbl` files and `paperweave-review.json` keep every check, so
  `link.tex` as a symbolic link or an encrypted `.tex` is still refused. The 100 MB archive bound
  is unchanged. The report (`describeImport`) lists at most 200 left-out files (`SKIPPED_SHOWN`),
  the ones with a reason worth reading (picture, duplicate folder, name length) before the generic
  "not a file type a paper uses", and sets `skippedMore` to the rest; the page ends the list with
  "And N more files were left out." The latexmkrc note still reads the whole list.
- **Held by** `archive.test` (junk of every kind imports; picture, symbolic link, encrypted and
  duplicate entries of a left-out type import; names that cannot be shown are not listed; wanted
  symbolic link, encrypted and too-many-files entries and the entry bound are still refused),
  `compiler.test` (the cut and the count), a sandbox test (a folder with 301 `.pyc` files and a
  data file imports as the paper alone), and `import.spec` (200 rows, picture first, "And 6 more").
- **Not done.** An archive over 50,000 entries or 100 MB is still refused. A symbolic link or
  encrypted entry among the wanted files still refuses the archive without naming the file. The
  existing hostile-archive sandbox test's "password-protected entry" row has a stored size that
  yauzl rejects as damaged, so it passes without reaching the encryption check; the new
  `archive.test` guard builds the entry properly. Fixed: the sandbox `rawZip` now writes the
  12-byte encryption header, and that row asserts the "password-protected" message.

## ZIP entry names with `./` or `//` are cleaned

- **What was wrong.** `bsdtar -a -cf paper.zip .` and some other tools write entry names as
  `./main.tex`, and some write `sec//a.tex`. `readZip` kept them as they were, so the paper's root
  was `./main.tex` and `\input{sec/a}` was reported missing.
- **Now** `entryName` (`archive.ts`) removes `.` and empty parts of a name (`./main.tex` becomes
  `main.tex`, `sec//a.tex` becomes `sec/a.tex`, `a/./b.tex` becomes `a/b.tex`). Only whole parts
  are removed, so a name never gains a `..` or a leading `/` (yauzl still refuses those before
  this runs). `./` alone is a folder. Two names that become one file (`./a.tex` and `a.tex`) are
  refused as "the same file twice".
- **Held by** `archive.test` (the names, the folder, the clash, and a loop of hostile names that
  must be refused or come out safe) and a sandbox test (a tar-style ZIP imports with root
  `main.tex` and nothing missing).
- **Not done.** A ZIP whose every name starts with `./` was already imported correctly (the common
  folder is stripped); this only matters for mixed or doubled-slash names.

## Names written with TeX accents can be dismissed as paper words

- **What was wrong.** `Kov\'a\v{c}` and `H\"older` were sent to the checker as "Kováč" and
  "Hölder" and flagged, but the glossary and "It is a word of this paper" used the source text,
  which the glossary's word rule can never hold. The finding could not be dismissed.
- **Now** `readAs` (`packages/latex/src/prose.ts`) gives a stretch as the checker read it (accents
  and escapes as their characters, a line break as a space), and each finding carries it as
  `reads`. A spelling finding is matched against the glossary by `reads` (NFC, case-insensitive)
  or by its source, and is addable when `reads` fits. `words` stays the source, as the text of the
  change. The panel adds and drops by `reads`, so the UTF-8 and TeX spellings go together.
- **Held by** `prose.test`, the grammar sandbox test (real checker) and `grammar.spec`.
- **Not done.** The panel still quotes the source form (`Kov\'a\v{c}`). Accents that stay raw
  (`\' e`, `\t`, `\d`, `Gro\ss e`) are never checked, as before.

## Find and replace in the source editor

- **What was wrong.** The source editor drew only the lines near the window, so the browser's
  Ctrl+F found nothing for a word further down a long file, and there was no replace anywhere.
- **Now** the source view uses `@codemirror/search` (6.7.2) with four keys only: Ctrl+F, F3, Ctrl+G
  and Escape. The panel reads in house phrases ("Next", "Previous", "Match case", "Regular
  expression", "Whole word", "Replace all", "Close"). A "Find and replace" button in the "Go to"
  group opens it in the source view. Replace and Replace all are ordinary edits, so they are
  shared, saved and, for Replace all, one undo step. Someone who cannot edit gets Find only. The
  "All" button (several carets) is hidden: the editor has one caret.
- **Held by** `find.spec`: finding a word that is not drawn, Replace all shared with a second
  editor, saved and undone in one Ctrl+Z, a reviewer who finds but cannot replace, and the button,
  Escape and an axe audit with the panel open. No unit or sandbox test: no server or package
  change.
- **Not done.** Files without a visual view (.bib, .sty, .cls) have no toolbar, so they have
  Ctrl+F only. A panel opened while the file is still locked has no Replace row until it is
  reopened. No find in the visual view or the PDF, and no go-to-line.

  (`\' e`, `\t`, `\d`) are never checked, as before (`Gro\ss e` is now read, see below).

## Text commands read as what they print

- **What was wrong.** `\ldots`, `\,`, `\textendash` and `\LaTeX` were grey raw chips in the visual
  view and "Dummy" to the grammar checker, so `5\,km` was read as `5Dummykm`. `See Vo\ss ler` gave
  a false spelling finding on `ler`, because `\ss ` (TeX skips the space) was not one piece.
- **Now** `\ldots \dots \textellipsis \textendash \textemdash \slash \thinspace \copyright
\textcopyright \textregistered \texttrademark \textdegree \texteuro \pounds \textsterling`
  join the national letters as one-character `esc` pieces (`TEXT_WORDS`, `parse.ts`), and `\,` is a
  thin space. A piece takes the `{}` or the same-line spaces and tabs after the name, as TeX does,
  never a newline. The logos (`\LaTeX{}`, `\TeX`, ...) stay atoms (they are several characters),
  but read as their name to the checker and show as that word in the visual view (`logoOf`,
  class `pw-word`, source in the title). In the bridge, a space or tab typed after such a command
  and its eaten spaces gets `\ ` or `{}` first, so it is not lost; this is limited to these names
  (for every control word `\item  y` would become `\item \ y`).
- **Held by** `parse.test`, `prose.test`, `bib.test`, the fuzz list in `testutil`, `bridge.test`
  ("text commands in the visual view", including a generated-edit loop), the grammar sandbox test
  (real checker), and a browser test in `visual.spec`.
- **Left out.** `\-`, `\/` and `\@` print nothing and stay chips; accents with a space (`\' e`,
  `\c c`, `\H o`); `--`, `---` and quote ligatures still show as typed; a line break straight
  after `\ldots` shows as a space although TeX prints none; a space after `\LaTeX ` is shown
  although TeX skips it; papers that redefine these commands are not checked for; `plainText` for
  bibliography titles gains the new symbols; a line that is only `\ldots` stays a raw block.

## An environment left open in an input file

- **What was wrong.** A forgotten `\end{itemize}` in `sections/body.tex` is only found at
  `\end{document}`, so the pane said `main.tex:9 ... \begin{itemize} on input line 3 ended by
\end{document}`, and its button went to the end of the main file, where "line 3" is something
  else.
- **Now** the error is placed in the file that has the open `\begin` on that line:
  `sections/body.tex:3 \begin{itemize} on this line is never closed: \end{document} came first, at
main.tex line 9. Add \end{itemize}.` The worker reads the files the log shows were opened (a
  regular file, up to 2 MB, under the build copy; nothing is logged) and picks the one whose line
  has the `\begin` (comments left out) with more `\begin` than `\end` from there on. If two or more
  fit, the error stays on the root and says which files may hold it. The same error repeated by TeX
  is listed once. The build cache key changed, so an old failed build is rebuilt.
- **Held by** unit tests on real-shape logs (`diagnostics.test.ts`: the input file, same line in
  three files, a root in a folder, a repeated error, two candidates; guards for a mismatch in one
  file, a macro-made `\begin`, a comment, no reader, an installed file), a compile
  (`compile.sandbox.test.ts`) and a browser test (`building.spec`: the button names the input file
  and its caret lands on the `\begin` line, audit); each failed before the change.
- **Not done.** A `{` or `\begingroup` never closed still builds with exit 0 and no message (it
  needs a new kind of warning in the pane and the submit check). Knock-on errors (`You can't use
\end in internal vertical mode`) stay. A `\begin` whose matching `\end` was itself rejected as a
  mismatch stays on the root.

## A brace or group left open in the paper

- **What was wrong.** A `{` left open in an argument of the root file (`\textbf{`, `\footnote{`,
  `\caption{`) was reported as `... The { is never closed in this file (read from undefined line
undefined).` plus a false `The paper ends without \end{document}.` A `{` or `\begingroup` left
  open as a group, or an `\iftrue` with no `\fi`, built with exit 0 and no message, so the submit
  check said ready while the rest of the paper was in that font.
- **Now** the root runaway says `The { is never closed in this file.` and the second error is not
  added. For a build with no error, the log's `### simple group ... entered at line N` and
  `(\end occurred when \iftrue on line N was incomplete)` lines each become a warning `Never
closed: ...` (outermost first, at most 10). The log does not name the file: with one of the
  paper's own files read, it is placed on that file and line; with more, it has no place and says
  `(in the main file or one it reads in)`. The pane lists them under "Left open"; the submit check
  passes them on as compiler warnings, unchanged. The build cache key changed.
- **Held by** `diagnostics.test.ts` (root runaway, one file, nested groups and conditionals across
  files, LuaTeX `\if`; guards for a failed build and a missing `\end{document}`), sandbox tests in
  `compile.sandbox.test.ts` and `submit.sandbox.test.ts`, and a browser test in `building.spec`
  (list, keyboard to the line, audit).
- **Not done.** The file in a multi-file paper; the line of an unclosed argument brace; groups
  opened by a package; a submit problem rather than a warning.

## Lower-case list items in the grammar check

- **What was wrong.** The grammar check read each `\item` as the end of a paragraph and the
  command itself as nothing, so a list item that starts in lower case (`\item open-source code.`,
  `\item first, we parse it.`) was flagged "sentence should start with an upper-case letter" when
  the item before it ended in `.` or `, and`, or when it was the first item after a paragraph
  ending in `.`. Lower-case items are normal in papers.
- **Now** the command that opens an item is read as the bullet it prints (`• `), so each item is
  a bulleted line and is not taken for the start of a sentence. A real sentence inside an item
  (`\item first, we parse it. it is fast.`) is still checked. The command stays marked as not
  prose, so no finding can touch it. Enumerate items read as bullets too: numbers hid real
  findings in a prototype.
- **Held by** a unit test on the reading of itemize and enumerate (`prose.test.ts`) and a test
  against the real checker (`grammar.sandbox.test.ts`: lower-case items in both kinds of list are
  left alone, a lower-case sentence is not, a repeated word in an item is still found); both
  failed before the change. The grammar benchmark is unchanged.
- **Not done.** A lower-case continuation paragraph straight after a
  list whose last item ends in `.` is still flagged. Side effect: the repeated-beginning rule no
  longer spans items, and `\item this are wrong.` now gives one finding (the plural verb after
  "this") instead of two.

## Description and nested lists in the grammar check

- **What was wrong.** The parser keeps a list raw when an item has an option (`\item[Term]`),
  when the environment has an argument (`\begin{enumerate}[label=...]`) or when an item holds a
  nested environment, a blank line or a display formula. A `description` list is always raw. The
  grammar check read each of these as one hard break, so a misspelling in them gave no finding.
- **Now** the grammar check reads such a list from the inside: the opening and closing lines are
  hard, each `\item` reads as a bullet, and the text of an item and of a list nested in it is
  prose. The whole `\item[Term]` is hard; a plain term reads as `• Term:`, so the item after it is
  not taken for the start of a sentence. Code and display formulas inside an item stay hard.
  Only `prose.ts` changed; the parser, the visual editor and the bridge are as before.
- **Held by** a unit test on the reading of description, nested and optioned lists
  (`prose.test.ts`) and a test against the real checker (`grammar.sandbox.test.ts`: a misspelling
  and a repeated word in description and nested items are found at their exact place, the term and
  a listing are not, the fix leaves the rest of the line byte-exact); both failed before.
- **Not done.** The visual editor still shows these lists as one raw block, so a finding in one
  is in the Language panel (and its replacement applies to the source) but has no underline
  there, and "show" puts the caret before the block. The term itself is never checked.
  `enumerate*` and custom list environments are unchanged.

## The comparison lost its word marks when a line was added beside a changed one

- **What was wrong.** Word marks in a comparison were given only when a run of changed lines had as
  many removed lines as added ones, paired by position. Changing a number and pressing Enter after
  it, adding a sentence on the next line, or deleting a line above a changed one made the changed
  line a plain whole-line removal and addition.
- **Now** each run of changed lines is matched in order, without crossing pairs, so that the most
  shared characters are kept (`counterpart` and `pairRun` in `textdiff.ts`). A pair must still
  be mostly the same words, a blank line is never a counterpart, and lines left over stay
  whole-line changes. At most 400 word comparisons are made per call (cheap pre-checks do not
  count); after that, rows stay whole-line. Nothing is logged.
- **Held by** unit tests in `textdiff.test.ts` (paragraph added after, sentence added on the next
  line, line deleted above, a paragraph split by Enter, equal counts matched by likeness, pairs not
  crossing, a blank line, guards for big runs) and a browser test in `revisions.spec` ("a
  comparison still marks the changed word when a paragraph was added after it", with an audit).
  The unit test "lines that are not counterparts stay whole-line changes" changed in one case:
  `a` / `b` against `a` / `b x` / `b y` now pairs `b` with one of the added lines.
- **Not done.** A run of more than 100 cells (removed x added) is paired by position only, and only
  with equal counts. Moved lines are not detected.

## Labels and environment lines are one line in the visual view

- **What was wrong.** Every lone `\label{..}`, every `\begin{theorem}[..]` / `\end{theorem}` (and
  `proof`, `lemma`, ...) and the final `\end{document}` was a dashed box headed "LaTeX: label", with
  the source in a `<pre>` and an "Edit in source" button. A labelled theorem was four boxes around
  one sentence.
- **Now** those lines are one quiet line: a lone label reads `label sec:intro` (with ` · 2.1` when
  the last build numbered it), a begin line reads `Theorem (Convergence)` or `Proof`, an end line
  `End of theorem`, the end of the file `End of document`. The line has a `source` button (its name
  is `Edit in source: <the line>`); the LaTeX is the line's title. A `\label` inside a paragraph is a
  small tag showing its key. Display only: `markerOf` (`apps/web/lib/marker.ts`) decides from the
  block's source and the parser's label, so the parser, bridge, schema and server are unchanged,
  and deleting a lone label still works while the halves of an environment still refuse.
- **Held by** `marker.test.ts`, the bridge guard "markers are display only" (projected source,
  typing, label removal, refused halves, undo) and a browser test in `visual.spec`
  (counts, texts, button, typing, Backspace on a label, axe audit).
- **Not done.** A theorem's printed title and number (`\newtheorem{obs}{Observation}` shows
  `Obs`); merging a label into its heading line; the preamble box, `\maketitle`, `\input`, `\title`
  lines, which stay boxes; paper text macros (`\eg`) and `--`/quote ligatures; a `\newtheorem`
  added since the page loaded stays boxed until a reload. A label with a trailing comment, or an
  `\end{document}` followed by text, stays a box.

## A paper's own text macros read as words

- **What was wrong.** `\newcommand{\sys}{PaperWeave}` showed as a grey raw chip in the visual
  view, as `\sys` in a caption or a table cell, and as "Dummy" to the grammar checker. So `These
\dbs is used here.` (`\dbs` for databases) had no finding, and `We use it \etc. it works.` had a
  false one on "it".
- **Now** a macro whose body only prints words reads as them (`textOf`, `textMacros`,
  `textMacroOf` in `macros.ts`). A body qualifies when it holds letters, digits, punctuation,
  `\ `, `~`, `\,`, `--`, `\%`-style escapes, `\@`, `{}`, `\xspace`, a `LIGATURES` command
  (`\dots`) and other macros that qualify; no more than 80 characters. A macro with arguments, a
  font wrapper (`\textsc{..}`), a formula, `\DeclareMathOperator`, a cycle, or a name in
  `LIGATURES` does not. Definitions are read in the order TeX reads them: the root's preamble,
  descending at each `\input` and at each `\usepackage`/`\documentclass` of the project's own
  `.sty`/`.cls`; the last one wins. A name that the body of the paper, or a file the preamble does
  not read, defines in any other way is left out. At most 256 names.
- **Display.** In the editor an atom written exactly `\sys` or `\sys{}` shows the words (class
  `pw-word`; the title is the source; a double click edits the source). A caption, a cell and
  their labels show the words in place of the macro, except inside `$..$`. The fields still hold
  the LaTeX, and nothing is written to the file.
- **Grammar.** `prose(src, transparent, macros)` reads such an atom as its words; it is still
  `hard`, so a finding that touches the macro is dropped. The answer cache is keyed by a hash of
  the annotation (it holds the text and what every macro stands for), so a change in a package
  that the checked file does not contain gives a new request. Nothing of the text is logged.
- **Stale.** The editor reads the words when the page loads: a macro changed since shows after a
  reload. The grammar check reads them on each check.
- **Left out.** Font wrappers (`\textsc{..}`) and macros with arguments do not qualify. No space
  is added or removed after `\sys word` as TeX would. Captions and cells are not grammar-checked.
- **Held by** `macros.test`, `prose.test`, a guard in `bridge.test` (typing beside macros keeps
  every byte), the grammar sandbox test (real checker, a package changed under an unchanged
  file), and browser tests in `visual.spec` and `grammar.spec`.

### Maths macros in TeX's order, from the paper's own packages

- **Was.** `paperMacros` read the root's preamble first and the files it `\input`s after, so a
  redefinition in the root lost to an earlier definition in an included file. It never read
  `.sty` or `.cls`, so a formula written with a macro from the paper's own package was drawn as
  raw LaTeX. `\providecommand` overrode an earlier definition. A macro that declared more
  arguments than its body used (`\newcommand{\hide}[1]{}`) printed the argument.
- **Now.** `mathMacros(texts, root)` takes what is in force at the end of the root's preamble
  (the same walk as `textMacros`, now shared as `inForce`): last definition wins, `\providecommand`
  does not override, the project's own packages are read where they are loaded. A macro whose
  body uses fewer arguments than it declares is given to the renderer as
  `\@secondoftwo{#n}{body}`, which takes and drops the unused ones. `paperMacros` reads
  `.tex`, `.ltx`, `.sty` and `.cls` files.
- **Left out.** `\def` with parameters, macros with an optional argument (and a name such an
  optional-argument redefinition has replaced), names containing `@`, and definitions in the body
  of the paper.
- **Stale.** Macros are read when the page loads, as before.
- **Held by** `macros.test`, `apps/web/lib/mathmacros.test` (the renderer drops the argument),
  the `paperMacros` sandbox test in `labels.sandbox.test`, and `maths.spec`.

## The key index misses references and citations TeX reads

- **What was wrong.** A comment inside a key list (`\cref{fig:a,% the first` then `fig:b}`) made
  the index read the comment as part of a key, and a `}` in the comment ended the list early. Renaming
  `fig:b` left that reference behind, the label report showed a bogus undefined label, and the
  citation report said the paper "cites `% b`" with no entry. Some commands were not read at all
  (`\cpagerefrange`, `\vrefrange`, `\nameCref`, `\autopageref`, `\shortcite`, `\citetalias`,
  `\citeN`, ...), so their entries counted as uncited and were left out of the Bibliography table.
  A line break between a command and its braces (`\ref` then `{fig:a}`) was not read, though the
  visual view already read it.
- **Now** a key list is read with its comments blanked out (same offsets, so a rename splices
  the real key and leaves the comment bytes alone); a `}` in a comment does not close it. A key
  split by a comment is left out. Spaces, tabs and one line break (never a blank line) may stand
  before every argument, as in `parse.ts`; the parser's `\ref` reading does the same. More
  cleveref, varioref, prettyref, natbib and apacite names are references or citations. No
  `TEX_TEXT` bump.
- **Held by** `labels.test.ts` (comments in a list, escaped percent, line breaks, every new name),
  `parse.test.ts` (a `\ref` over a line break is one atom, and the existing invariant test over
  every name), sandbox tests in `labels.sandbox.test.ts` and `citations.sandbox.test.ts`, and a
  browser test in `labels.spec` (rename over a comment, `\shortcite` listed in the Bibliography).
- **Not done.** The visual chip for `\cref{a,%` + line break + `b}` still splits its own source
  and shows `??` for the second key (`visual.ts`, left alone because of pending work). `\nameCref`
  chips show the number, as `\namecref` already does. A comment inside a `\hyperref[..]` key.
  Commands with other argument shapes (`\defcitealias`, `\citefield`, `\volcite`,
  `\citeaffixed`).

## Between the PDF and the text, to the word

- **What was wrong.** SyncTeX goes between the PDF and the text by the line, both ways, and a
  paragraph typed in the visual view is one source line, so it was paragraph-only. Measured on
  real builds of a two-column paper with 12 one-line paragraphs (156 marker words): "Show in PDF"
  landed within one printed line for 12 and on the wrong page for 18, always at the paragraph's
  first line. The band was as wide as the page, so on two columns it did not say which column; at
  200% the place could be off to the side. A double-click in the PDF put the caret at the line's
  start. On a hard-wrapped paper (`ieee-multifile`), 7 of 243 words (the first word of a source
  line, or a paragraph's last) resolved to a neighbouring line, and the `synctex` tool agrees.
- **Now.**

  |                                                  | before              | now                                                        |
  | ------------------------------------------------ | ------------------- | ---------------------------------------------------------- |
  | Text to PDF, within one printed line (156 words) | 12                  | 155 (118 exact)                                            |
  | Text to PDF, right page                          | 138                 | 155                                                        |
  | PDF to text, caret                               | start of the line   | the clicked word, selected                                 |
  | The band                                         | as wide as the page | as wide as the line's column, centred sideways when zoomed |
  | First word of a hard-wrapped source line         | the line above      | its own line                                               |

  Source to PDF: the editor sends the caret's share of its line (`share`, 0 to 1); `toPdf` takes
  the record at that share of what the line made, over line boxes, columns and pages, and says
  the box it is in (`left`, `width`). PDF to source: `toSource` says how far along its line the
  clicked record is (`share`, over the line's own records, in file order); that share was within 7
  characters (median) and 40 (greatest) of an occurrence of the clicked word over 2,748 words.
  The clicked word is read from the PDF's text layer in the browser (`apps/web/lib/pdfword.ts`)
  and looked for, whole, on the line, then the line below, then the line above; it is never in a
  request, an address or a log. A place in another file is kept in the browser (`carry`/`taken` in
  `pdfsync.ts`) while the address says only `?line=N`. A line edited since the build keeps the
  line-only behaviour: `share` is neither used nor returned.

- **Held by** `synctex.test.ts`, `pdfword.test.ts`, a sandbox test in `builds.sandbox.test.ts`
  (a one-line paragraph that runs from page 1 to page 2 of a two-column paper) and two browser
  tests in `synctex.spec` (words both ways in both views, the band's page, height and width, 200%,
  another file, every `/sync?` request's shape, the audit; the first words of a hard-wrapped
  paper). Each new test failed on the old code.
- **Not done.** A word split by a hyphen or a ligature falls back to the share; the keyboard
  route ("the middle of the pages") has no word, only the share; a moved line keeps line-only
  behaviour.

## Charts with numbers or dates along the bottom were drawn wrongly

- **What was wrong.** A grouped bar chart over a number or date column stacked its bars (Vega-Lite
  dropped the offset because the axis was continuous): a percentage ran to 160 and the bars were
  slivers. A year axis read `2,019.0 | 2,019.5 | ...`. A scatter over years began at 0, with every
  point in the last stretch of the axis. A column of whole days got hour ticks (`06 AM`, `12 PM`).
- **Now** bars over numbers or dates are one per value, side by side, in ascending order (dates
  as written, labels level when there are few and short). Number axes of scatter and line charts
  start at the data's own extent, are not ticked between whole numbers when every value is whole,
  and print numbers under 10000 without a thousands comma. A date axis of whole days is ticked by
  the day. Text bars are as before. `toSvg` is split out of `render` in the worker.
- **Held by** `charts.test.ts` in `packages/server` (the specification) and in `apps/workers`
  (the drawn SVG: labels, point places, bar widths, no dropped offset), and a sandbox test that
  draws a grouped bar over a year column twice to the same bytes.
- **Not done.** Charts already drawn keep their old picture until "Draw it again" (they are not
  marked out of date; `chart_draws` has no rule version). A two-day date axis still shows one
  `12 PM` tick. The y axis still groups thousands and starts at zero.

## A proposal changed after it was last seen

- **What was wrong.** Accept applied whatever words the proposal held at that moment. If its
  author (or another editor) changed the replacement after the card was drawn, the paper got text
  nobody had looked at, and the "This changes more than the wording" flags on the card were for
  the old words. Reject could turn down a revision unseen, and two people changing the same
  proposal silently overwrote each other.
- **Now** Accept, Reject and Save send the two texts the card showed (`seen`). If the proposal
  reads differently, the server refuses with a conflict, writes nothing, and the card is read
  again so it shows the proposal as it now reads. The update itself also names the texts it
  expects, so a change between the check and the write is refused as well. A person changing a
  proposal who is overtaken by someone else's change is told so beside the form, and keeps what
  they wrote. A `seen` that is not a pair of texts is refused as invalid. No `TEX_TEXT` bump.
- **Held by** a sandbox test in `proposals.sandbox.test.ts` (accept, reject and revise refused on
  stale `seen`, malformed `seen`, success with fresh `seen`, retry, no `seen`, withdraw) and a
  browser test in `proposals.spec` (Accept refused on a card that could not refresh, and the note
  for a change overtaken while writing).
- **Not done.** Withdraw is not checked (it is the author's own, and decides nothing about what
  it says). A tab opened before this deploy sends no `seen` and behaves as before. The race
  between the check and the write is closed by the update's `where` clause, which has no test.

## Resolve hides a reply that was never seen

- **What was wrong.** Ana replies "Don't close this, Table 2 is wrong". Ben's card still shows the
  old thread, so he presses Resolve, and the thread drops into "Resolved (n)" with the objection
  unread and no notice. Smaller: a reply sent just after the last comment of a thread was deleted
  brought the thread back holding only an answer to nothing.
- **Now.** Each thread carries a `mark`, a digest of its live comments and when each was last
  changed. Resolve sends the mark the card was drawn from; if anyone has written, changed or
  deleted a comment since, the server refuses (`conflict`) in the same statement that would have
  resolved it, the page reads the thread again, and says "Someone wrote in this thread after you
  last saw it". The reply stays in the open list, the Resolve button keeps the keyboard, and the
  next press sends the new mark. Opening again is never guarded; an older page that sends no mark
  behaves as before. A reply to a thread with no live comment is refused. No schema change; the
  mark is never logged.
- **Held by** two sandbox tests in `threads.sandbox.test.ts` and `threads.spec` ("Resolve refuses
  a thread someone wrote in after it was drawn"). Each failed on the old code.
- **Not done.** A reply sent to a thread resolved a moment earlier is still taken and lands in
  Resolved; the owner's Delete of a comment its author changed a moment earlier is not guarded;
  the mark does not cover the text under the thread; a draft is still lost when its thread
  disappears.

## A paper's own words saved from a page left open

- **What was wrong.** The Language form sent the whole word list and the whole list of switched-off
  rules as the page had drawn them, and saving replaced what the paper held. With the paper's page
  open in one tab, words made the paper's own (and rules switched off) in the editor were deleted
  or switched back on by pressing Save there for any reason, and "Language settings saved." was
  shown. The editor's two buttons read the lists and wrote them back, so two clicks at once could
  lose a word (twenty at once kept one).
- **Now.** `changeLanguageSettings` adds and removes words and rules on what the paper holds,
  under a row lock; the editor's buttons add one word or one rule. The form carries what it showed
  (`shownLanguage`, `shownGlossary`, `shownOff`) and `languageChange` turns the difference into
  words to add, words to drop, rules to switch on and a language only if it was changed. A form
  drawn before this change is saved whole as before. `setLanguageSettings` takes the same lock.
  Nothing is refused and no message is new. Words are never logged.
- **Held by** `grammar.test.ts`, three sandbox tests in `grammar.sandbox.test.ts` and a browser
  test in `grammar.spec`. Each failed on the old code.
- **Not done.** The page still does not show others' changes until it is saved or reloaded; a word
  removed on the page while someone re-adds it in the editor follows whichever came last; the
  editor's panel does not hear of a word removed on the page until its next check.

## A file named in the wrong letter case said "may come with TeX", with no hint

- **What was wrong.** Papers written on macOS or Windows, which ignore letter case in file
  names, often say `\includegraphics{Figures/Plot}` for `figures/plot.png`, or
  `\input{Sections/Intro}` for `sections/intro.tex`. They build at home and fail here and on
  arXiv. Nothing said the file was there under another spelling:
  - the import report said the name "is not among the paper's files. It may come with the TeX
    installation", which only a build can tell;
  - the checks before submitting said `The paper has no file "Figures/Plot".`;
  - the build pane said only ``LaTeX Error: File `Figures/Plot' not found.``
- **Now.** `includeGraph` records `near` on a missing name: the paper's file that matches it
  but for letter case (with the extension TeX would add, through `\graphicspath` and an
  import folder too). It is advice only: no edge, no reading order, no build and no export
  changes, and nothing in the paper is rewritten. The import report, the submit check and the
  build pane (which reads the name out of the error it shows) each say which file it is and
  that capitals count here. A name that matches nothing keeps its old sentence exactly.
- **Held by** tests in `graph.test.ts`, `import.test.ts`, `submit.sandbox.test.ts`, and a
  browser test in `import.spec.ts` that imports such a paper, reads the hint in the report and
  in the pane, corrects the name and builds.
- **Not done.** No one-press fix. The visual view still says "cannot be shown here. It is in
  the PDF." Names that differ in Unicode normalisation are not matched. A reference made
  through a macro is not checked. Import reports stored earlier keep the old sentence.
- **Found here, fixed in the next section.** "Add a row" on a one-column table inserted `\n     \\`, which
  `tableOf` did not read back as a row (`closeRow` dropped a lone empty cell), so the button
  seemed to do nothing and each press added a blank line to the PDF.

## "Add a row" on a one-column table did nothing

- **What was wrong.** The new row of a one-column table was written as an empty cell and `\\`,
  and the table reader dropped a line with one empty cell, so the grid did not change while each
  press added a blank line to the PDF. (When the last row had no `\\` of its own the new row had
  none either, and it could not be read for the same reason.)
- **Now** a line that is only `\\` is a row, as in LaTeX. A final line with nothing after the last
  `\\` (or only rules or a comment) is still not a row, so existing tables keep their row counts.
  Adding a row after an unterminated last row of a one-column table also gives the new row its
  own `\\`. Nothing else in the source changes.
- **Held by** the one-column tests in `packages/latex/src/floats.test.ts` (end, middle, repeated,
  delete, edit of the new cell, trailing `\\ \hline` guards) and the one-column case in
  `tests/e2e/tables.spec.ts`.

## A caption or description typed in place can no longer stop the build

- **What was wrong.** A caption edited in place was not checked, so `50% of runs`, `Done}`,
  `Cost {in` and `Ends \` were all written. Real pdflatex then stopped with
  `! File ended while scanning use of \@xdblarg` and no PDF for the first, third and fourth, and
  with `! Extra }` for `Done}`. With the brace no longer closing, the caption vanished from the visual view and could
  not be repaired there. A lone trailing backslash also passed the cell and dialog checks. A
  picture description written without braces (`alt=A dot`) broke on a comma:
  `! Package keyval Error: green and blue undefined`.
- **Now.** `captionText` (`packages/latex/src/floats.ts`) refuses a bare `%` or `&`, a line
  break, unbalanced braces and a final backslash; `\\` is allowed in a caption. It guards the
  in-place caption field and the Insert figure/table dialog. `cellText` also refuses a final
  backslash, so the heading dialog's own check is gone. A description written without braces gets
  them when the new text has a comma or `=`; the splice is still the value only. An unchanged
  Enter writes nothing, so an existing odd caption is never rewritten. The refusal does not
  quote what was typed.
- **Held by** tests in `packages/latex/src/floats.test.ts` and the caption steps in
  `tests/e2e/tables.spec.ts` (refusal, field kept open with the typed text, then a good caption;
  the closing ZIP comparison shows nothing else changed).
- **Not done.** A bare `#`, `_`, `^` or unbalanced `$` in a caption still gives a TeX error (a PDF
  is still made; `#` is legitimate inside `\href`) — corrected below: the worker keeps no PDF when
  latexmk exits non-zero, and the section "A bare `_`, `^`, `#` or unclosed `$`" now refuses those. Captions are edited as LaTeX, not escaped
  for the person. `\verb|%|` in a caption is refused. No server-side check.

## An equation typed into the Insert window can no longer stop the build

- **What was wrong.** The Insert window handed what was typed straight to the server, wrapped in
  `$...$` or `\begin{equation}`. Real pdflatex stopped on `p = 50%` (`! Missing $ inserted`),
  `\frac{a}{b` (`! File ended while scanning use of \frac`, no PDF), `a } b` (`! Extra }`),
  `a $ b`, a blank line inside the formula, and a display holding its own `\end{equation}`. The
  preview drew `p = 50%` without complaint, because KaTeX reads `%` as a comment. The Edit path
  had been given a check earlier, but it only compares how the text around the formula is parsed,
  and the parser does not count braces inside maths, so `$\frac{a}{b$` and a display with a blank
  line or an unclosed brace passed there too.
- **Now.** `formulaText` (`packages/bridge/src/clipboard.ts`) is `pasteable` plus no blank line.
  `Bridge.formulaCommand` refuses ('spills', nothing written) a formula that fails it, and one
  that would change how what is around it, or its own block, is read (checked against the full
  and the incremental parse, with a stand-in of the same shape). Where even a plain formula is
  not a block of its own (a list item, a heading) only the text check applies, so a display
  equation in a list item still goes in. The window shows its existing "make the change in the
  source" note and stays open with what was typed. The Edit window gets the same text check
  before `rewriteCommand`. Only the formula's own splice reaches the source; the typed formula is
  never logged or put in a message. Other insertions and `openAtom` are unchanged (`\verb|%|`
  and `\url{...%20...}` are legitimately not pasteable).
- **Held by** `formulaText` and "an equation typed into the Insert window" in
  `packages/bridge/src/bridge.test.ts` (eight places, eleven refused, seven accepted, conflicts),
  the new test in `tests/e2e/insert.spec.ts` and the extra step in `tests/e2e/maths.spec.ts`.
- **Not done.** `&` or `#` in an inline formula and `_`/`^` misuse still give TeX errors. `a = 50%`
  at the end of a line of a display equation is accepted and prints without the percent sign.
  Footnote and other atom edits get no brace check beyond `contained` (later: see "A footnote or
  other text command edited as LaTeX can no longer stop the build"). No server-side check for
  insertions. No TEX_TEXT bump.

## A bare `_`, `^`, `#` or unclosed `$` in a table cell, caption or heading title failed the build with no PDF

- **What was wrong.** The earlier notes said a PDF is still made after such a TeX error. It is not:
  `apps/workers/src/compile.ts` keeps the PDF only when latexmk exits 0, so the build fails with
  nothing to show. With the worker's own latexmk command, `file_name` and `x^2` (`Missing $
inserted`), `Item #3` (`macro parameter character #`, or `Illegal parameter number` in a caption
  or title) and `Costs $5` (`Extra }, or forgotten $` or `Missing $ inserted`) all exit 12. In-place
  cells, captions and heading titles accepted them, because `cellText` and `captionText` only
  check braces, `&`, `%` and line breaks.
- **Now.** `stray` and `strayAdvice` (`packages/latex/src/floats.ts`) find the first such mark and
  say what to write (`\_`, `\#`, `\$`, or put the formula between `$` signs) without quoting what
  was typed. Formulas (`$x_1^2$`, `\(...\)`, `$$...$$`), escaped marks, `\verb`, and the arguments
  of commands such as `\label`, `\ref`, `\cite`, `\url`, `\href`, `\includegraphics` and
  `\ensuremath` pass. Text commands (`\textbf`, `\multicolumn`, `\text`, ...) are read as text.
  The in-place cell and caption fields, the Insert figure/table dialog and the heading dialog
  refuse such text and stay open with what was typed. An in-place cell or caption that already
  held such a mark may be edited (the `underscore` package, or source that was already broken).
  `cellText` and `captionText` are unchanged. No TEX_TEXT bump.
- **Held by** the `stray` tests in `packages/latex/src/floats.test.ts` and the refusal steps in
  `tests/e2e/tables.spec.ts` (cell, caption), `tests/e2e/insert.spec.ts` (heading) and
  `tests/e2e/figures.spec.ts` (figure dialog). The exemption for a cell or caption that already
  holds a mark is held by review only.
- **Not done.** Marks inside text-like commands outside the known set, or inside any unknown
  command's argument; `#` inside `\href` in a caption or title (exit 12, stays allowed); a paper
  using the `underscore` package is told to write `\_` the first time (that still builds); the
  server chart-caption check, the atom/footnote window (later: see "A footnote or other text
  command edited as LaTeX can no longer stop the build"), inline-formula `&` and `#`; no
  server-side check.

## A bare character in a .bib entry

- **What was wrong.** A `_`, `^`, `&` or `#` written bare in a `.bib` field (`title = {max_pool}`,
  `journal = {Science & Nature}`, a `howpublished` with a URL) is fine to BibTeX and Biber but
  not to TeX when it reads the result. Under BibTeX the errors were in the `.bbl` and said only
  "In the bibliography (an entry of a .bib file, as LaTeX reads it)", up to four times, with no
  file or line. Under biblatex they were reported at the paper's `\end{document}`, in
  `main.tex`, a line with nothing wrong in it.
- **Now** the error is one line in the `.bib`: "In the reference smith2020, the title field has
  a bare _: Missing $ inserted. Write \_ instead." (`^`: write `\^{}` or put it in `$...$`). The
  reference is read from the `.bbl` line TeX names (BibTeX), or, for biblatex, from every
  `\entry` of the `.bbl` when the error is at or just after `\printbibliography`; only an entry
  whose field really has the character is named (a `\_`, a `$x_i$` and `abstract`, `keywords`,
  `file`, and for biblatex `url`, `doi`, `eprint` are not). The knock-on errors of the same
  entry are dropped. An entry found with no such character is named at its own line; a key no
  `.bib` has says "In the bibliography, in the reference k ...", with no file. Without the
  paper's files to read, the old sentence stays. Builds from before are rebuilt (`-bibentry`).
- **Held by** `bareIn` tests in `bib.test.ts`, excerpts of real logs in `diagnostics.test.ts`
  (BibTeX and Biber, a root in a folder, guards for a message away from `\printbibliography` and
  for `$x_i$`/`url`), two real compiles in `compile.sandbox.test.ts` (the `&` test now asserts
  the `.bib` file, line and reference; a `_` under both engines gives one error at its line) and a
  browser test in `building.spec.ts`, each failed on the old code.
- **Not done.** A `%` in a biblatex field (`File ended while scanning use of \field`; BibTeX builds
  it silently). A key in a braced `\bibitem` label that contains `]`. A `.bib` found only in TeX's
  own tree. An error printed by `\fullcite` or the like, away from `\printbibliography`. The
  shell-escape message of minted. A `#` that joins strings in a `.bib` (`month = jan # "~1"`) is
  read as a bare one if TeX complains of `#` in that entry.

## A paper that loads minted is told what to do

- **What was wrong.** minted runs Pygments during the build, and shell escape is off, so a paper
  that loads it does not build at all (no PDF), not just without its listings. The build pane
  listed five errors for one listing (`You must invoke LaTeX with the -shell-escape flag`,
  `You must have pygmentize installed`, `catchfile ... _minted-main/default.pygstyle not found`,
  `Cannot find Pygments style`, `Missing Pygments output`), three or four more for each further
  listing, the first on `\begin{document}` and none saying what to do. The import note said
  "those parts will not build", which was wrong for minted.
- **Now** the build shows one error, on the `\usepackage` (or `\RequirePackage`) line that loads
  minted: "This paper loads the minted package, which runs a program (Pygments) during the build.
  PaperWeave never runs programs from a paper, so it cannot be built with minted. Set the code
  with the listings package instead (\begin{lstlisting})." It is only given when minted's own
  shell-escape error is in the log; the other minted and catchfile errors are dropped and the
  rest keep their log order. With no way to read the paper, or minted loaded from a `.sty` or
  `.cls`, it keeps TeX's line. The import note for minted now says the paper will not build until
  the code is set another way; `pythontex` and `shellesc` keep the old sentence. Builds from
  before are rebuilt (`-minted`).
- **Held by** six excerpt tests in `diagnostics.test.ts` (one error on line 2, no `read`, a root
  in a folder, a second listing with an unrelated error between, a commented-out `\usepackage`,
  a catchfile error with no trigger left alone), a real compile under pdfLaTeX and LuaLaTeX in
  `compile.sandbox.test.ts`, three note tests in `import.test.ts` and a browser test in
  `building.spec.ts`.
- **Not done.** Keeping a frozen minted cache (`.pygtex`/`.pygstyle` files are dropped at import;
  minted 3 and 2 differ in format; listings would go stale after edits; the image would need to
  change): an owner decision. `frozencache` without its cache still shows minted's own errors.
  `pythontex`, `svg` and other shell-escape packages. Import reports stored earlier keep the old
  sentence. Nothing converts minted to listings.

## A footnote or other text command edited as LaTeX can no longer stop the build

- **What was wrong.** The atom window (footnote, citation, reference, other inline LaTeX) only
  asked the bridge to rewrite the command, and the bridge accepted `\footnote{Costs $5.}`,
  `{R & D}`, `{Item #3}`, `{a_b}`, `{x^2}` and `{\begin{itemize}}`. With the worker's own flags
  every one of them exits 12 and the worker keeps no PDF: `Missing $ inserted`, `Misplaced
alignment tab character &`, `You can't use 'macro parameter character #'`, `Extra }, or
forgotten \endgroup`. `\emph{R & D}`, `\textsc{a_b}` and `\mbox{#1}` failed the same way.
  Several `Missing $ inserted` on one line show as one diagnostic, because `diagnostics()`
  de-duplicates by file, line and message.
- **Now.** `atomProblem(text, was)` (`packages/latex/src/floats.ts`) names the first mark that
  stops the build (`_`, `^`, `#`, an unclosed `$`, and `&` while the text has no `\begin{`) or an
  unbalanced `\begin`/`\end`, and says what to write, without quoting the text. `openAtom`
  (`apps/web/lib/visual.ts`) asks it first and the window shows the message in its alert and stays
  open with what was typed. Text that already had the problem is not held to it. The check is in
  the web layer, not the bridge, because the formula window shares `rewriteCommand`. `\url`,
  `\href`, `\cite`, `\ref`, `\label`, `\verb` and tables pass.
- **Held by** the `atomProblem` tests in `packages/latex/src/floats.test.ts`, the guard that no
  inline atom of any fixture is flagged and the pinned bridge line in
  `packages/bridge/src/bridge.test.ts`, and the refusal steps in `tests/e2e/atoms.spec.ts`.
- **Not done.** `#` in `\url` or `\href` inside a footnote (exit 12 with hyperref, stays
  allowed); `\verb` inside a footnote; `&` in an optional argument (`\citep[pp. 3 & 4]{a}`); `&`
  is not checked once the text has any `\begin{`; a `\begin` inside a comment is counted; text
  commands outside the known set; a paper using the `underscore` package is told to write `\_`;
  no server-side check; the formula window is unchanged. No TEX_TEXT bump.

## Deleting a file the paper reads was done at one click

- **What was wrong.** "Delete" sat beside "Rename" in each file row, but Rename shows the lines
  that name the file first and Delete went straight through. Built afterwards with local TeX:

  | Line left behind                 | Result                                                 |
  | -------------------------------- | ------------------------------------------------------ |
  | `\input{sections/intro}`         | exit 12, no PDF, `File 'sections/intro.tex' not found` |
  | `\include{sections/intro}`       | exit 12, no PDF                                        |
  | `\includegraphics{figures/plot}` | exit 12, no PDF                                        |
  | `\bibliography{refs}`            | exit 0, PDF made, citations unchecked                  |

  On a shared paper one misclick stopped everyone's build; the only message was "Revision N still
  has it", and restoring rolls back co-authors' edits too.

- **Now** "Delete" on a file that some line names opens a page ("Delete <path>") that lists those
  lines, file by file, with their numbers, says nothing has been deleted yet, and has a button
  "Delete <path> anyway". The lines are found by the same reading Rename uses (`fileUses` in
  `packages/server/src/files.ts`). The root file says it must be replaced first, with no button.
- **Held by** `files.sandbox.test.ts` ("the lines that name a file are found before it is
  deleted"), `files.spec.ts` (the page, the other tab untouched, then "anyway"; a file nothing
  names still goes at one click) and the page in the `a11y.spec.ts` walk.
- **Not changed.** A file nothing visible names is still deleted at once. Names written through a
  macro are not seen. Lines are not removed or commented out for the person. There is no digest, so
  a line added between the page and the click is not shown. Restoring a revision remains the way
  back. The sync/API path, `deleteFile` itself, does not ask.

## A label set on a code listing is a label

- **What was wrong.** `\begin{lstlisting}[caption={Hello}, label={lst:hello}]` and
  `\lstinputlisting[label=lst:file]{code/a.py}` give LaTeX a real label (the PDF prints its
  number), but the reader of the paper skipped the listing's options. A `\ref` to it was reported
  as "no label has that name", the Submit check blocked on it or said LaTeX had resolved it,
  "Rename the label" did not offer it, and the reference picker left it out.
- **Now** the `label=` option of `lstlisting` and `\lstinputlisting` is read like a `\label`: braced
  or bare, with spaces round the `=`, over several lines, ignoring comments, the last one winning.
  Rename changes exactly the key. A `\label` in the body of a listing is still verbatim text.
- **Held by** a unit test in `labels.test.ts` (forms, comment, nested braces, `lstinputlisting`,
  guards for `enumerate[label=]`, `minted[label=]`, `#1`, an unclosed `[`, `citeIndex`), a sandbox
  test in `labels.sandbox.test.ts` (listed, no undefined reference, rename byte-exact, name taken)
  and a browser test in `labels.spec.ts`.
- **Not done.** `label=` on thmtools theorems, tcolorbox, `\lstset` and `\lstnewenvironment`
  environments (the fresh-build "LaTeX resolved it" warning still applies).

## A list with an option, a comment or a length before its first item is an editable list

- **What was wrong.** Of the 25 `itemize`, `enumerate` and `description` lists in the corpus,
  only 14 were editable lists in the visual view; the other 11 were one dashed raw block with
  "Edit in source". Four of them had an option on the environment (`[noitemsep,leftmargin=0.4cm]`,
  `[leftmargin=1em]`, `[noitemsep]`), one a comment line and one a `\setlength\itemsep{0em}`
  before the first `\item`. All of these print nothing, but the parser only accepted `\item`
  straight after `\begin{..}`.
- **Now** an option on the `\begin` line, comment lines and a list length (`\setlength{\itemsep}{..}`,
  `\setlength\itemsep{..}`, `\itemsep0pt`, also `parskip`, `parsep`, `topsep`, `partopsep`,
  `itemindent`, `leftmargin`, `labelsep`, `labelwidth`) may stand between `\begin{..}` and the
  first `\item`. They are part of the first item's `pre` piece, so they are kept byte for byte and
  never shown as prose. Editable lists in the corpus go from 14 to 19 of 25.
- **Held by** parse tests (eight heads, each a list with the right item count and the head in the
  first `pre`; five guards that stay raw), a prose test (a commented-out `\item` is not prose),
  a bridge test (Enter and typing change only their own bytes, with an option, a comment and a
  tab-indented length head, and deleting a list with an option) and a browser test in
  `visual.spec.ts` that also runs the accessibility check.
- **Not done.** The visual list shows 1, 2, 3 or bullets whatever `label=`, `resume` or `start=`
  say. An option on the line after `\begin`, and `\small` or other commands before the first
  `\item`, stay raw. Deleting a list's only empty item removes its option and head comments with
  it. Nested lists, `\item[..]`, `description` and display maths in items stay raw blocks.

## `{\em ..}`, `{\it ..}`, `{\bf ..}` and `{\tt ..}` are styled text in the visual view

- **What was wrong.** Old font-switch groups in prose were one raw atom each. In the 17-paper
  corpus that was 446 dashed chips in 7 papers (`{\em` 346, `{\tt` 48, `{\it` 43, `{\bf` 9),
  inside 226 of 1,685 text blocks: the words could not be typed into, and the grammar check read
  them as "Dummy".
- **Now** a group that opens with `\em`, `\it`, `\itshape`, `\bf`, `\bfseries`, `\tt` or
  `\ttfamily` is read like `\emph{}`, `\textit{}`, `\textbf{}` or `\texttt{}`: the opening
  (`{\em `, with the spaces and the one line break TeX skips, or `{\em{}`) and the closing `}` are
  bytes the editor keeps, and the words between them are text with that style. On the corpus 435
  of the 446 groups become ordinary styled text; raw chips in prose fall from 1,657 to 1,236 and
  text blocks holding a chip from 601 to 416. Typing lands inside the braces, deleting all of a
  group's words removes exactly `{\em ..}`, and turning the group's own style off leaves exactly
  its words. A generated-edit run over the corpus (41,172 accepted edits on 42 documents) changed
  no byte outside its range.
- **Held by** parse tests (each switch name, the line break, `{\em{}`, nesting, heading and list
  item, tiling, eight guards that stay raw, `{\em cost $5}` staying a paragraph), a prose test
  (the words are prose, the braces and `{\tt ..}` are not), bridge tests (typing, deleting and
  unstyling change only their own bytes; a 300-seed generated-edit run) and a browser test in
  `visual.spec.ts` that also runs the accessibility check.
- **Not done.** `{\sc ..}`, `{\sl ..}`, `{\small ..}` and a group holding a bare command
  (`{\bf \bert}`, which may be a declaration) stay raw chips. `{\bf {\it x}}` shows bold italic
  where LaTeX prints italic only. A space typed first in a group is eaten, as TeX eats it.
  Emphasis or Bold on part of a group nests `\emph{}` inside it. Nested lists, `\item[..]` and
  `description` stay raw blocks.

## Comment lines inside a paragraph are one quiet note, and read as nothing to the grammar check

- **What was wrong.** Each comment line inside a paragraph was its own dashed monospace chip, cut
  at 28 characters. In the 17-paper corpus that was 369 chips in 14 papers (284 whole comment
  lines, 74 a bare `%`, 11 trailing words), inside 154 of 1,685 text blocks, in 197 runs; 44 runs
  were 2 to 10 or more consecutive lines. The grammar check read each as the noun "Dummy":
  `that\n% old\nthe` was sent as `that Dummy the`, and `word%\n next` as `wordDummy next`.
- **Now** comment lines that follow one another are one raw atom, as they already were between
  paragraphs, and the visual view shows it as one small italic note (`% old claim one old claim
two`, cut at 40 characters, the source in the title, announced as "comment: ..." or "empty
  comment"). The grammar check reads a comment as nothing, and the line break and indentation
  after it as nothing, as TeX does. Corpus comment chips fall from 369 to 197. A generated-edit
  run over the corpus (35,853 accepted edits on 38 documents) changed no byte outside its range.
- **Held by** parse tests (one atom for a run, a bare `%`, a trailing comment, guards for
  comments between paragraphs, a blank line ending a run, and `50\%`), a prose test, a web unit
  test for the note's text, bridge tests (typing and deleting around the note change only their
  own bytes; a 300-seed generated-edit run, which now includes a list item with a comment, and
  a bridge test for Enter at the start of an item) and a browser test in `visual.spec.ts` that also
  runs the accessibility check.
- **Note.** Enter at the start of an item after the first splices `\n\item ` at the end of the item
  before, the same document as Enter there, and leaves the item's own bytes alone. The
  generated-edit run models that range (the end of the item before), where it had used the range of
  the item the caret was in.
- **Not done.** The space shown after a bare `%` (TeX prints none). `\noindent`, `\-` and `\\`
  were still chips read as "Dummy" (see "Commands that print nothing are quiet marks"); maths
  macros (`\hgg`) and reference wrappers (`\sref{}`) are not rendered. A grammar finding across a comment is still dropped. Enter at the start of an
  item whose previous item is empty is accepted and does nothing (`translate.ts` returns no
  edits there); the source is untouched, so it is harmless.

## Commands that print nothing are quiet marks, and read as nothing to the grammar check

- **What was wrong.** `\noindent`, `\-`, `\/`, `\@`, `\\`, `\newline`, `\allowbreak` and a
  backslash at the end of a line were raw chips, and the grammar check read each as the noun
  "Dummy". In the 17-paper corpus that was 272 chips in 41 of 1,685 text blocks, in 6 papers: `\\`
  222 (217 in one author list), `\noindent` 26 (25 paragraphs; 24 are `\noindent\textbf{..}`
  run-in headings), `\-` 13, backslash-newline 11. 31 blocks held a raw chip only because of
  these. `\noindent{\bf Setup.}` was one chip with the heading inside it. On a live LanguageTool the
  stand-in hid real findings: `\noindent we adopt` gave no sentence-start finding and
  `baseline.\\` then `An other` no compound finding.
- **Now.** Each is an atom of its own (`\noindent{}` with its empty braces; any other braces after
  it are a group of their own, so `\noindent{\bf Setup.}` is a chip plus an editable bold group).
  The visual view shows a small quiet mark (`¶` no indent or indent, `↵` line break, `·` for the
  rest), the source in the title, an accessible name such as "no indent". A backslash at the end of
  a line is TeX's control space, as `\ ` is. The grammar check reads them as nothing, `\\`,
  `\newline` and `\linebreak` as a space, and `\-` as part of its word (`Schmid\-huber` reads
  `Schmidhuber`, and a finding may cover it). Stand-ins fall from 7,267 to 6,995 and "Dummy"
  glued to a letter from 3,438 to 3,173. A generated-edit run over the corpus (10,164 accepted
  edits on 12 documents, all 272 sites) changed no byte outside its range. `TEX_TEXT` is not
  bumped.
- **Held by** `quiet.test.ts`, parse tests (`\noindent` and its braces, control space, guards), a
  prose test, bridge tests (typing and deleting around each kind change only their own bytes; a
  600-seed generated-edit run) and a browser test in `visual.spec.ts` that also runs the
  accessibility check.
- **Not done.** The visual view does not break the line at `↵`; the space shown after
  `\noindent ` (TeX drops it); `\vskip`, `\vspace`, `\smallskip`, `\;` and `\quad` stay chips
  (7 in the corpus); `\\` in captions and table cells; the import coverage figure still counts
  these atoms as raw.

## A paper that names a `.bib` it does not have, and has no `.bbl`, got no PDF

- **What was wrong.** With `-bibtex-cond`, latexmk says "I WON'T RUN 'bibtex main'" for a `.bib`
  that is not among the files and does a dummy run. The `.bbl` never appears, the rule stays out of
  date, and after five passes latexmk exits 12 with "needed too many passes". A PDF is in the work
  folder, but the build keeps it only on exit 0, so the author saw "The bibliography could not be
  made. The build log has the details." and no PDF. It hit every new paper before its `.bib` is
  uploaded and any paper whose `.bib` is deleted: `\bibliography{refs}` with no `refs.bib`;
  `\bibliography{refs,more}` with only `refs.bib`; biblatex `\addbibresource{refs.bib}` with none.
  The 17-paper corpus (through ZIP read, `keepBbls`, import and the worker's `compile()` in the
  image):

  | Result                        | Papers                                                                                                  |
  | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
  | Imported and built, no errors | 12                                                                                                      |
  | Refused at import, correctly  | 2 (`1602.03837`, `hep-th_9711200`)                                                                      |
  | Fail on EPS (owner decision)  | 2 (`1207.7214`, `1502.03167`)                                                                           |
  | Failed for this cause         | 1 (`1301.3781`: `\bibliography{strings,refs}` beside an inline `thebibliography`, no `.bib`, no `.bbl`) |

- **Now** `LATEXMK_RULES` has an `after_xlatex` hook, `pw_bbl`: when the TeX log says there is no
  `<root>.bbl` and none exists, it makes an empty one and prints "PaperWeave: no main.bbl, an empty
  one stands in." The build then ends after a normal pass and keeps the PDF, with `[?]` for the
  citations. `diagnostics()` reads that line together with latexmk's "I WON'T RUN" block (the marker
  also prints on ordinary first passes, which BibTeX then overwrites) and says, once per file, as a
  warning: "Bibliography not made: refs.bib is not among the paper's files, so the PDF has [?] ...".
  The biber "could not find" error is not also said on such a build. The build pane lists it under
  "Not in the PDF" with the capital-letters hint (`Refs.bib` for `refs.bib`), and the submission
  check makes it a problem of kind `file`, so the paper is not ready. The rules string has no single
  quote and runs no command, and the download command carries it, so ZIP and PDF stay in step.
  `1301.3781` now exits 0 with the same 12 pages. Across 15 corpus papers and 10 fixtures, the old
  and new rules give the same exit code and `pdftotext` text, except that paper. A `.bbl` that is
  there is kept byte for byte, with a `.bib` missing (BibTeX and biber); a `.bib` syntax error and
  `\input{main.bbl}` with no file still fail. `$bibtex_use=2` was rejected: it makes biber truncate a
  ready-made `.bbl`.
- **Held by** `diagnostics.test.ts`, `latexmk.test.ts`, three tests in `builds.sandbox.test.ts`, the
  biblatex check in `submit.sandbox.test.ts` (which used to expect the build to fail), and a browser
  test in `building.spec.ts` that also runs the accessibility check.
- **Not done.** The warning carries no line of `\bibliography`. With one of two `.bib` files missing,
  entries of the present one also show `[?]`. A per-chapter `.bbl` (chapterbib, multibib) is not
  stubbed.

## One "Worth a look" line per cause for compiler warnings

- **What was wrong.** "Check before submitting" passed every compiler warning through as its own
  "Worth a look" item, uncapped: 88 items for about 18 causes across 12 clean corpus papers. One
  `\section` with maths made hyperref write a warning per token; a font without a size made one per
  shape; `\small` in maths made one per line. Two warnings also lost their second line: LaTeX's own
  warnings continue with 15 spaces, not `(name)`, so "You have requested package `eso-pic'," ended
  at the comma and "No positions in optional float specifier" lost its line number.

  | Paper      | Items before | What                                                             | After |
  | ---------- | -----------: | ---------------------------------------------------------------- | ----: |
  | 1312.6114  |           27 | 26 hyperref "Token not allowed in a PDF string", one per token   |     3 |
  | 1512.03385 |           20 | 15 "Font shape ... size not available", plus the size summary    |     5 |
  | 1810.04805 |           29 | 28 "Command \small invalid in math mode", one per line, 11 files |     2 |
  | 1404.7828  |            6 | 4 "Command \o invalid in math mode", 2 bookmark                  |     2 |

- **Now** `diagnostics()` reads a LaTeX warning's 15-space second line as part of it (all 15 corpus
  logs: same warning count, 5 messages change; `2010.11929` gains lines 105, 110 and 138). Every
  "Token not allowed in a PDF string" becomes one "PDF bookmark: ..." warning per file and line,
  which says the page is not affected and offers `\texorpdfstring`. "Font shape ... size ... not
  available" and "Size substitutions ..." become one "Font sizes not available: ..." warning at the
  first place, listing up to six sizes. `byCause()` in `packages/server/src/findings.ts` merges
  findings with the same level, kind and message (never a chart's) into one item with its places,
  and the submit page shows the first five places and "and N more places." The toolchain text gets
  `-merged`, so cached builds are made again. No message contains manuscript text, and nothing is
  logged.
- **Held by** `diagnostics.test.ts` (the multi-line test's expectation changed: it asserted the old
  per-token and per-shape texts), `findings.test.ts`, a test in `compile.sandbox.test.ts`, and
  "warnings with one cause are one line, with every place" in `submit.spec.ts`, which runs the
  accessibility check.
- **Not done.** Overfull boxes are not reported. "You have requested package" from an installed
  file is still listed. The `naaclhlt2019` `\ifx` false alarm remains: a package-opened group is
  reported as "\ifx on line 3 ... has no \fi" (repro: `\usepackage[hyperref]{naaclhlt2019}` in a
  six-line paper whose line 3 is blank). The build pane still shows none of these warnings.

## A group or conditional a package leaves open is not held against the paper

- **What was wrong** The build pane said "Built, but something is left open: `\ifx` on line 3 ...
  has no `\fi`" on every build of a paper using the official NAACL 2019 style, and again under
  "Worth a look" on submit. It was false: the style ends a line with `\ifaclfinal\else...` and no
  `\fi`, the kernel's own `\fi` closes that one instead, and TeX reports the kernel's `\ifx` with
  the line counter of the main file. The log gives a line number, never the file. A group an
  installed package opens (`\begingroup` on its line 5) was shown the same way, with a button to
  the author's innocent line 5. Of the 15 corpus logs only `1810.04805` has such a line.
- **Now** When the build can read every own file the log names, an entry is kept only if one of
  them has an opener on that line: `\if...` or `\unless` for a conditional (so an author's
  `\ifdraft`, which TeX names `\iftrue`, still counts), `\begingroup`, or `{` / `\bgroup`
  (comments and `\{` ignored). None: a package, class or macro opened it, and nothing is said.
  Exactly one: the warning is placed at that file and line, with no "in the main file or one it
  reads in", even when several files were read. More than one: the unplaced wording as before. A
  file that cannot be read leaves the old behaviour. Wording of kept warnings is unchanged. The
  toolchain text gets `-opened`, so cached builds are made again. Nothing is logged.
- **Held by** seven tests in `diagnostics.test.ts` (the two false alarms, a place in a read-in
  file, a root folder, `\ifdraft`, two fits, an unreadable file, comment and `\{` guards), two in
  `compile.sandbox.test.ts` (a `.sty` that leaves `\ifx` open; a brace left open in a section),
  and two in `building.spec.ts`, which run the accessibility check. The existing "group left open"
  tests are unchanged.
- **Not done.** A conditional or group opened by the paper's own macro (`\newcommand{\hide}{\iftrue}`)
  and never closed is no longer reported, since no line of the paper has the opener. `\ifdraft` is
  still named as TeX names it (`\iftrue`). The faulty line inside the `.sty` is not found. Still
  carried over: overfull boxes are not reported; "You have requested package" from an installed
  file is still listed; the build pane shows no compiler warnings.

## The e2e tests' temporary folders

- **What was wrong.** The Playwright tests make folders with `mkdtempSync(join(tmpdir(),
'paperweave-e2e-'))` and never removed them. On one machine that was about 15,000 folders and
  4.7 GB in `/tmp` (63 MB each for `large.spec.ts`), which filled the disk. CI starts fresh each
  time, so only local runs suffered.
- **Now** `tests/e2e-global-setup.ts` (the config's `globalSetup`) makes one
  `paperweave-e2e-run-*` folder and sets `TMPDIR` to it, so `tmpdir()` in the test workers
  returns it; it returns a function that removes the folder when the run ends. The web servers
  start before `globalSetup`, so they keep the normal `TMPDIR`. No spec file changed. Running
  `large.spec.ts` and `uploading.spec.ts` left the count of `/tmp/paperweave-e2e-*` unchanged.
- **Not done.** Folders from earlier runs are not removed. A run killed with SIGKILL still leaves
  its one `paperweave-e2e-run-*` folder. Existing servers reused from an earlier run keep their
  own `TMPDIR`. `uploading.spec.ts:117` ("a page restored after a large upload...") fails here
  with and without this change.

## TeX Gyre and `texlive-humanities` added to the image

- **What was wrong.** 30 arXiv papers not tried before went through import and the worker's build: 23 built. Three got no PDF only because the image lacked a package: `tgpagella` (2307.09288, Llama 2), `qtree` (2305.10601, Tree of Thoughts), `dramatist` (2203.15556, Chinchilla). `texlive-fonts-recommended` only recommends `tex-gyre` and the image installs without recommended packages, so TeX Gyre was missing under every engine: `\usepackage{tgtermes}` said "File not found", and `\setmainfont{TeX Gyre Termes}` or `\setmathfont{TeX Gyre Pagella Math}` failed under XeLaTeX and LuaLaTeX.

  | Paper      | Before                                   | With the packages     |
  | ---------- | ---------------------------------------- | --------------------- |
  | 2307.09288 | `File 'tgpagella.sty' not found.` no PDF | 77 pages, 0 undefined |
  | 2305.10601 | `File 'qtree.sty' not found.` no PDF     | 14 pages, 0 undefined |
  | 2203.15556 | `File 'dramatist.sty' not found.` no PDF | 36 pages, 0 undefined |

  Every package name the 47 corpus papers load and do not ship is 161 names; the image lacked 6: the three above, `pst-node` and `auto-pst-pdf` (PSTricks, stays out) and `eprint` (optional in its class).

- **Now** `infra/tex/Dockerfile` installs `tex-gyre`, `fonts-texgyre`, `fonts-texgyre-math` and `texlive-humanities` (`qtree`, `dramatist`, `gb4e`, `linguex`, `covington`). The three papers build untouched; 26 of the 30 build. Size: 17.0 MB more to download, 45.8 MB installed; `docker images` shows `paperweave-tex` at 4.15GB and the derived test image at 4.25GB. Papers that built before give the same pages, text and fonts under both images (all three corpora). **The image ID is part of the build cache key, so every paper rebuilds once** after the image is rebuilt. On the machine where this was written the tests ran against a derived image (old image + the same four packages + `fc-cache -f`) because of disk space; CI builds the real one.
- **Held by** the ten new cases in `compile.sandbox.test.ts`; each fails on the old image. Run locally
  against the derived image: 10 failed on the old image, 10 passed on the new. The full sandbox suite
  could not run locally because the local blob store was out of disk; CI builds the real image from the
  Dockerfile and runs the whole suite against it.
- **Not done.** `pstricks` and `CJKutf8` are still not installed (`docs/import-matrix.md` already says so). The import report does not say that a paper loads a package the image lacks; the build says "File 'X.sty' not found". The other fresh-corpus failures: 1909.11942 (one author field with a comma before "and" makes BibTeX report errors; latexmk stops and the only message is "The bibliography could not be made. The build log has the details."), 1509.05363 (the paper's own class loads `lastpage` and `totpages`, which the installed `totpages` refuses), 1912.01703 (minted with `frozencache`), 1411.4028 (PSTricks and EPS). 2203.15556 loads minted but never uses it and builds; its import note still says it "will not build until the code is set another way". Carried over: overfull boxes; "You have requested package"; the build pane shows no other compiler warnings.

## A BibTeX error says what BibTeX said, and where

- **What was wrong.** Only a syntax error at a line of a `.bib` and a missing `.bib` or `.bst`
  were read from BibTeX. Any other error gave "The bibliography could not be made. The build log
  has the details.", and the build log (TeX's) never has BibTeX's words. Of thirteen small
  papers, one per kind of BibTeX error, eleven gave only that sentence; so did 1909.11942, where
  one reference of 62 has a comma before "and".
- **Now** (`diagnostics()` in `apps/workers/src/compile.ts`):
  - A name BibTeX cannot read names the reference and the field, at that field's line of the
    `.bib`: `refs.bib:4 In the reference b, name 2 of the author field ends with a comma. Put only
"and" between names, with no comma before it.` (or "has too many commas"). The names
    themselves are not quoted.
  - A `crossref` to nothing: `refs.bib:2 In the reference b, crossref names nope, which is in none
of the paper's .bib files.`
  - Said in the paper's terms, with no file or line (BibTeX gives a line of the `.aux` only): a
    space in a citation key, a second `\bibliography`, a second `\bibliographystyle`, one key
    spelt with different capitals, a `.bib` named twice.
  - A style file BibTeX cannot read is named, at its line if it is the paper's.
  - Each is said once however often BibTeX repeats it; at most ten name errors a build. `TEX_TEXT`
    gained `-bibsaid`, so every paper rebuilds once.
- **Unchanged:** the build still fails and keeps no PDF on any BibTeX error, also when BibTeX
  wrote every entry (1909.11942 would be 17 pages). Whether to go on in that case is the owner's
  decision.
- **Held by** the new tests in `diagnostics.test.ts`, two in `compile.sandbox.test.ts` and one in
  `building.spec.ts`. The unit and sandbox tests were run on the development machine; the
  Playwright test was written but run only in CI.
- **Not done.** The errors about the paper's commands (`\bibliography` twice, a key with a space)
  have no file or line. A kind of BibTeX error not listed still gives the old sentence, which
  still points at a build log that does not have the details; BibTeX's output is not kept.
  BibTeX's warnings other than an undefined abbreviation are not shown. Carry over: 1509.05363
  (own class loads `lastpage` and `totpages`), 1912.01703 (minted `frozencache`), the 2203.15556
  import note, PSTricks/EPS/CJK; overfull boxes; "You have requested package"; the build pane
  shows no other compiler warnings; nested lists, `\item[]` and `description` raw in the visual
  editor; Enter at the start of a list item after an empty one.

## A build starts from what the paper's last good build made

- **What was slow.** Every build started in an empty folder, so each edit cost two to four TeX
  runs and a BibTeX or biber run. On 32 papers (22 real, 10 fixtures) a word typed at the end
  took a median 3.5 s to build, 15.6 s for the largest.
- **Now** (`compile()`'s `warm` folder in `apps/workers/src/compile.ts`; `warmDir` in
  `builder.ts`; `BUILD_WARM_DIR`): the worker keeps what a paper's last good build made (the
  `.aux`, `.toc`, `.bbl`, latexmk's record; not the PDF, not the paper's files) in a folder of
  its own and puts it back before the next build, so latexmk runs only what the edit calls for:
  one run for a word (median 1.5 s, 5.2 s for the largest), two when numbering changes. Measured
  through the worker's own `compile()`, five edits on each of the 32 papers (160 steps):

  | Edit                                                  | From nothing (before)                | From the last good build                       |
  | ----------------------------------------------------- | ------------------------------------ | ---------------------------------------------- |
  | A word typed at the end                               | 3 runs, median 3.5 s (all 32: 146 s) | 1 run, median 1.5 s (all 32: 57 s)             |
  | A numbered section with a label and a reference added | 3 runs, median 3.5 s                 | 2 runs, median 2.5 s                           |
  | That section taken out again                          | 3 runs, median 3.5 s                 | 2 runs, median 2.7 s                           |
  | An undefined command typed (the build fails)          | 1 run, median 1.5 s                  | 2 runs (warm, then from nothing), median 3.0 s |
  | The error mended                                      | 3 runs, median 3.6 s                 | 1 run, median 1.4 s                            |

  The rules, and why each is there: nothing kept is used after a file is added, removed or
  renamed, or the root or compiler changes (latexmk does not follow them: a `.bib` taken out
  leaves its `.bbl` in use); a build that fails from kept files is run again from nothing before
  it is reported (something kept may be what is wrong); BibTeX's and biber's words are repeated
  while the `.bbl` they made is still read (a warm build that does not run them has none of
  their words on its output); only the `.aux` files the last run touched give labels (a chapter
  no longer included leaves its `.aux` behind); the PDF is never kept, so every build runs TeX
  with its own date.

- **Nothing a build produces changes**: 160 steps on the 32 papers and 35 on made-up ones gave
  the same PDF bytes, SyncTeX, diagnostics, labels and log as a build from nothing. The cache
  key and `TEX_TEXT` are unchanged, so no paper rebuilds because of this.
- **Held by** the new tests in `compile.sandbox.test.ts` (run on the development machine), one
  in `revisions.sandbox.test.ts` and one in `builds.sandbox.test.ts` (written, not run on the
  development machine: the local blob store refuses writes; CI runs them).
- **Not done.**
  - A build that fails costs two runs where it cost one (median 3.0 s against 1.5 s): the error
    is checked from nothing before it is shown. A failed run that ran out of time is not tried
    again; a failure near the time limit followed by the second run can take up to twice the
    limit.
  - A paper whose first-ever run fails but whose later runs would pass (a `\ref` used as a
    number) can build here after an edit and still fail from nothing; not seen in the corpus.
  - The kept files stay on the worker's disk until 200 other papers have built, the image
    changes or the folder is cleared; they are not removed when a person leaves a paper. They
    hold what an `.aux`, `.toc` and `.bbl` hold: headings, captions, the reference list.
  - Workers on different machines do not share them; the first build a machine does of a paper
    is from nothing.
  - **The wait around the build is now the larger part**: the pane notices its own edit only at
    its next poll (up to 5 s when quiet), waits one more poll (2 s) for the paper to be still,
    and sees the finished build at the next poll (up to 2 s). Telling the pane at once that this
    editor typed is the natural next step; it needs browser tests, which cannot be run on the
    development machine.
  - LuaLaTeX builds its font cache on every build (7 s for a five-line paper, warm or not):
    `TEXMFVAR` is in the container's temporary folder.
  - Carry over, unchanged: 1509.05363 (own class loads `lastpage` and `totpages`), 1912.01703
    (minted `frozencache`), the 2203.15556 import note, PSTricks/EPS/CJK; overfull boxes; "You
    have requested package"; the build pane shows no other compiler warnings; nested lists,
    `\item[]` and `description` raw in the visual editor (6 of 20 corpus papers with lists; five
    overlapping causes); Enter at the start of a list item after an empty one; whether to build
    on past a BibTeX error.

## The build pane hears from its own editor

- **What was slow.** After a pause in typing the pane waited for a poll to notice the edit (every
  5 s when quiet), one more poll to find the paper still (2 s), and after the build another poll
  to see it (2 s). With a 1.5 s build: 4.1 to 9.1 s from the last key, median 6.6 s from a quiet
  paper and 5.0 s at the end of typing. "Compile now" on a quiet pane could go unseen for up to
  five seconds. (Measured by running the pane's poll against a made-up server with the clock
  moved by hand, fifty phases; not in a browser.)
- **Now** (`apps/web/lib/autobuild.ts`, `lib/typing.ts`, `whileShown().now` in `lib/shown.ts`):
  the editor tells the pane when the server has what was typed; the pane asks for the build 1.7 s
  later if nothing more was typed, two seconds after the last key at every phase. A build that is
  new is asked about every 500 ms for its first ten seconds. A press of "Compile now" counts the
  wait from the press. From the last key to the pane knowing of a PDF of that text (simulated,
  not browser-measured):

  | Case                                                                       | Before (min / median / max) | Now (every phase) |
  | -------------------------------------------------------------------------- | --------------------------- | ----------------- |
  | One edit to a quiet paper, build 1.5 s                                     | 4.1 / 6.6 / 9.1 s           | 3.7 s             |
  | The end of eight seconds of typing, build 1.5 s                            | 4.1 / 5.0 / 6.1 s           | 3.7 s             |
  | One edit, build 2.5 s                                                      | 6.2 / 8.7 / 11.1 s          | 4.8 s             |
  | End of typing, build 2.5 s                                                 | 6.2 / 7.1 / 8.1 s           | 4.8 s             |
  | One edit, build 5 s                                                        | 8.2 / 10.7 / 13.2 s         | 7.4 s             |
  | "Compile now" pressed (automatic off), build 1.5 s / 2.5 s, from the press | 2.1 s / 4.2 s               | 1.6 s / 2.7 s     |
  | Someone else's edit, build 1.5 s                                           | 4.1 / 6.6 / 9.1 s           | 3.8 / 6.3 / 8.7 s |

  Not changed: someone else's edit still waits for a poll that finds the paper still; a quiet
  paper is still asked about every five seconds, a hidden page not at all; a build is asked for
  once for each state of the paper; the 30-second retry after a refusal; every sentence shown;
  every limit.

- **Why two seconds and not less.** A paper gets 120 builds an hour, 100 of them automatic, and
  automatic builds are 30 s apart once 60 are used. A shorter wait builds at more pauses. A
  made-up typist (an hour, three seeds, build 1.5 s, pauses of four seconds or more, 603 of
  them) with the limits: today 248 pauses caught up, none within 4 s, median wait 5.7 s; 3 s
  wait: 257, 5, 4.7 s; **2 s: 240, 191, 3.7 s**; 1 s: 209, 144, 2.7 s, and the first refusal
  comes sooner (11 to 12.5 min against 13.5 to 14.3). At today's limits two seconds is the
  fastest wait that does not lose pauses to the limit. The typist is invented: read the table as
  the shape of the trade, not as a forecast.
- **Held by** `autobuild.test.ts` and `shown.test.ts` (run on the development machine, clock
  moved by hand) and one test in `building.spec.ts` (written, run only in CI: the local blob
  store refuses writes).
- **Not done.**
  - Not measured in a browser: the time to fetch and draw the new PDF comes on top and is
    unchanged.
  - An edit that does not come from this page's editor is noticed by the poll as before (up to
    5 s, then 2 s): another person's typing, a proposal accepted, a file uploaded, renamed or
    deleted, a chart drawn again.
  - A build under way is not stopped when more is typed: the next one waits for it. With a 5 s
    build a sentence typed after a pause is in the PDF 7.4 s after its last key.
  - While a build is new the pane asks twice a second: about half as many requests again over
    half an hour of typing (664 to 1027 in the model). Each is the two statements
    `docs/benchmarks.md` times at 6 ms (62 ms for a paper of 2,000 files).
  - **The hourly limits now decide the wait, and are the owner's.** `BUILDS_PER_PAPER_HOUR` and
    `BUILDS_PER_USER_HOUR` were set when a build cost about three TeX runs; an ordinary edit now
    costs one. The made-up typist uses the 60 unspaced automatic builds in about a quarter of an
    hour of steady typing, today as well as now, and is then built every 30 s. At 280 an hour
    the model typist never meets a refusal in an hour, and a wait of one second (`STILL_MS =
700`) would give 2.7 s from the last key for about a fifth more builds.
  - Carry over, unchanged: everything in the "Not done" of "A build starts from what the paper's
    last good build made" except its item on the wait around the build.

## A selection across a formula, a figure, a heading or a list

- **What was wrong.** In the visual view a selection that ran across anything but paragraphs
  could not be deleted, typed over or cut: "That edit spans LaTeX structure. Make it in the
  source editor." A section could not be deleted there at all. Counted on the corpus (31
  papers, 118 body files) with the real bridge and the editor's own transactions
  (`tr.deleteSelection()`, `tr.insertText()`), not in a browser:

  | Selection made on every such place in the corpus                                                                                           | Before     | After          |
  | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------- |
  | Middle of a paragraph to the middle of the paragraph two on, typed over: 2,601 places, 1,999 with something other than a paragraph between | 0 of 1,999 | 1,620 of 1,999 |
  | A section, from the start of its heading to the end of its last paragraph, deleted: 733 sections in 28 papers                              | 0          | 674            |
  | From the start of a heading to the start of the next heading, deleted: 742                                                                 | 0          | 664            |
  | Two neighbouring paragraphs, middle to middle, deleted: 1,911 pairs, 703 with something between                                            | 0 of 703   | 549 of 703     |

  Of 4,052 accepted selections made for real on corpus files (random ends, 40% typed over),
  every one changed the source by one splice, left it balanced in braces and environments, and
  gave no file a frozen block; the view was the projection of the source every time.

- **Now** (`acrossBlocks` in `packages/bridge/src/translate.ts`, `Bridge.filter`,
  `Bridge.sourceOf`, `Bridge.mayCut`). A selection from one text block into another, that is not
  paragraphs only and not inside one list, is deleted, typed over or cut. The ends are taken
  from the selection in the editor's state, not from the step the editor makes:
  - An end inside a paragraph keeps what is left of the paragraph; if both ends are like this
    the two remnants join. At a paragraph's first (left end) or last (right end) character it
    goes whole.
  - A left end at the very start of a heading's title or of a list's first item takes the
    heading or list whole, command and all; a right end at the very end of one does too; a right
    end at its very start leaves it whole.
  - Everything between goes if it may: paragraphs, headings and lists without definitions,
    formulas, whole `\begin{L}...\end{L}` blocks, a lone `\label`, comments, layout-only lines
    (`\vspace`, `\noindent`, `\newpage`, ...), and a theorem or abstract with both of its lines
    inside.
  - One splice; typed words that stand alone become a paragraph of their own; one blank line
    is left, not two.
  - Copy and cut say the same: a heading or list selected from its start or to its end is
    copied as LaTeX with its command, so a section cut here and pasted elsewhere arrives byte
    for byte. A cut whose LaTeX cannot travel (a stretch ending in a comment, 89 of 2,590 in
    the probe) and that is not paragraphs only is not made, with the one new sentence: "That
    selection cannot be cut as LaTeX. Cut it in the source editor."
- **Still refused**, with "That edit spans LaTeX structure. Make it in the source editor.": an
  end in the middle of a heading's title or a list item; a command line between the ends
  (`\input`, `\bibliography`, `\maketitle`, `\newcommand`, `\def`); half of a theorem or
  abstract; the preamble and `\end{document}`; a frozen block; Ctrl+A; Enter over such a
  selection; a paragraph just opened with Enter.
- **Held by** seventeen tests and the two new fuzzer kinds (`sdel`, `srep`) in
  `packages/bridge/src/bridge.test.ts`, run on the development machine (`pnpm test`: 54 files,
  730 tests; the range and interleaving fuzzers pass at 10,000 and at `FUZZ=40000`), and one
  test in `tests/e2e/visual.spec.ts`, written and run only in CI (the local blob store refuses
  writes).
- **Not done.**
  - An end inside a title or an item (477 + 422 of the neighbouring pairs in the corpus are
    paragraph-to-heading or heading-to-paragraph, middle to middle): it needs the closing brace
    or `\end{itemize}` kept, two splices.
  - A reference to a label that went with a figure or a section prints `??`; the build and the
    submit check say so, the editor does not warn before the deletion (the same as deleting one
    figure today).
  - Text someone else types inside a figure or formula while another person deletes across it
    stays, on its own, where the block was (the same as in the source editor).
  - A file whose every block is selected and deleted is left empty; the caret then has no text
    to stand in.
  - Not tried: an input method composing over such a selection; drag and drop of a selection;
    Safari and Firefox.
  - A selection ending in a comment cannot be cut (it can be deleted); the sentence says to use
    the source editor.
  - Carry over, unchanged: nested lists, `\item[..]` and `description` raw in the visual view;
    Enter at the start of a list item after an empty one; everything in the "Not done" of "The
    build pane hears from its own editor".

## A footnote can be added in the visual view

- **What was missing.** The visual view had a tool for a reference, a citation, an equation, a
  figure, a table, a heading and a list, and none for a footnote; typed there, `\footnote{..}` went
  in as its characters. Counted over the 31 corpus papers (29 with body text, 118 body files) with
  the real bridge, counts only: 24 of 29 papers have at least one footnote; 164 are shown as a chip
  (174 `\footnote{` in the source); 159 stand in a paragraph, 4 in a list item, 1 in a heading; 126
  of the 164 hold LaTeX (a formula 47, `\url`/`\href` 34, a citation 24, a reference 18, styled text 10) and 38 are words only.
- **Now** (`footnoteBody` in `packages/latex/src/floats.ts`, `Bridge.footnoteCommand`,
  `footnote()` in `apps/web/lib/visual.ts`, `FootnoteBox` in `Tools.tsx`): with the caret in
  running text, a toolbar button "Footnote", Alt+O or "Insert a footnote…" in the menu opens a
  window with one field, "Text". Enter or "Insert" puts `\footnote{text}` at the caret and leaves
  the caret just after it; one undo takes it back. The field takes words and LaTeX that is running
  text (`\$ \% \& \# \_`, a formula, `\cite`, `\ref`, `\url`, `\emph`, `\textbf`, `\\`); line breaks
  and runs of spaces become one space. What would stop the build is refused with what to write: an
  empty text, a bare `%` or `&`, unbalanced braces or a trailing backslash, a bare `#`, `_` or `^`
  outside a formula, a `$` that does not close, `\verb`. A list, heading, `\item`, a display
  equation or anything that would not be read as one footnote where it stands is refused as "only
  running text". In a heading nothing opens and the note says a footnote there stops the build; not
  in running text says to put the caret in the text. Six new sentences, all in the window or the
  note. Corpus result: 4,514 put in at 6,056 carets, each exactly one new chip holding the text
  given, no file gained a frozen block, `check()` held every time, every refusal left the source
  untouched, and all 1,476 heading carets were refused. Builds (pdfLaTeX, made-up papers): the ten
  accepted texts build; the eleven refused texts fail the build; a footnote in a list item, in
  `\emph{}`, and in IEEEtran, amsart, llncs, acmart, elsarticle, revtex4-2, beamer and two-column
  article builds; a footnote in a heading's title fails in five of five classes.
- **Held by** two tests in `floats.test.ts`, eleven in `bridge.test.ts` (the fixture guard among
  them) and one in `compile.sandbox.test.ts`, all run on the development machine, and one in
  `insert.spec.ts`, written but run only in CI (the local blob store refuses writes). Two existing
  browser expectations were changed on purpose and not run locally: the toolbar in `keys.spec.ts`
  has 16 buttons, was 15; the menu list in `insert.spec.ts` gains "Insert a footnote…" after
  "Insert an equation…".
- **Not done.**
  - A caret after a space leaves the space before the note mark (`word \footnote{..}`); the tool
    does not move the place.
  - `\footnote[2]{..}`, `\footnotemark`/`\footnotetext` and `\thanks` are not offered; nor a
    footnote in a table cell or a caption (they are fields, and need other LaTeX).
  - A new footnote is running text only; a list or a display in one is made with "Edit
    footnote…" or in the source. `\input` and definitions typed into one are not refused (as in
    "Edit footnote…").
  - `\url` in a footnote needs the paper to load hyperref or url; without, the build says so.
  - No footnote at the very start of a paragraph that begins with a comment line or a `{\bf ..}`
    group (62 of 4,320 carets tried).
  - The words of a footnote are still not read by the grammar check.
  - Not tried: an input method in the field; Safari and Firefox; Alt+O on a Mac keyboard layout
    that types a letter with it (the other Alt keys are in the same position).
  - Found while measuring, not changed: Enter at the start of a list's first item is refused (40
    of 40 lists, 19 papers); Enter in the middle of a heading is refused (927 of 927); Backspace or
    Delete where a heading meets a paragraph does nothing (1,814 places).
  - Carry over, unchanged: nested lists, `\item[..]` and `description` raw in the visual view;
    everything in the "Not done" of "A selection across a formula, a figure, a heading or a
    list".

## Enter at the start of a list item always opens an item above it

- **What was wrong.** At the start of a list's first item Enter was refused with "That edit spans
  LaTeX structure. Make it in the source editor." (40 of 40 editable lists in the corpus, in 19 of
  the 20 papers with a list; counted with the real bridge and the editor's own Enter, counts only).
  At the start of an item after an empty one it did nothing and said nothing (carried in "Not
  done" since the list work). The second happened because Enter at the end of an empty item and
  Enter at the start of the item after it give the same document; the change was placed at the
  second, which is inside an empty item, and an empty item does nothing. Only the place of the
  split tells the two keys apart, and `translate` was not told it.
- **Now** (`translate.ts`, the list-item Enter branch; `filter` in `bridge.ts` passes where the
  split was made):

  | Caret at the start of               | Before                                                        | Now                                            |
  | ----------------------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
  | The first item                      | Refused with the sentence above                               | An empty item above it                         |
  | An item that follows an empty one   | Nothing happens, nothing is said                              | An empty item above it (Enter twice gives two) |
  | Any other later item                | An empty item above it                                        | Unchanged, byte for byte                       |
  | An empty item (first, middle, only) | Nothing happens; in the last of two or more, the list is left | Unchanged                                      |

  The source gets `\item `, a line break and the indentation of the item's own `\item`, directly
  before that `\item`; an option, comment lines or a length between `\begin` and the first
  `\item` stay above it. The caret stays with the text. Corpus result: 40 of 40 accepted, each one
  run of `\item `, a line break and the list's indentation before the first item's own `\item`,
  one more empty item, nothing else changed, no frozen block, `check()` every time; a second
  Enter gave a second item in 40 of 40; Backspace gave the original bytes back in 38 and the same
  but for spaces after `\item` in 2. Builds: an empty first item in five classes, 5 of 5.

- **Held by** six tests in `bridge.test.ts` (one of them over every fixture) and the fuzzers, run
  on the development machine, with the sandbox build of 150 generated visual edits (three
  cases); one test in `visual.spec.ts`, written but not run on the development machine (the
  local blob store refuses writes), so run only in CI. One existing test's last two expectations
  were changed on purpose (they pinned the refusal and the nothing). `harness.ts` tells the
  fuzzers where the new rule writes.
- **Not done.**
  - The caret stays with the text; it does not go into the new item (ArrowLeft or ArrowUp does).
    The owner may prefer the other.
  - Enter at the start of a later item after an item with text still writes its `\item` at the
    end of the item before, with that item's indentation; the new rule writes before the item's
    own. The view is the same either way.
  - Enter in an empty item that is not the last still does nothing.
  - Backspace at the start of the first item still does nothing (it does not turn the item into a
    paragraph); Backspace at the start of a paragraph after a list, and Delete at the end of a
    list's last item, are still refused (24 places each in the corpus).
  - Enter over a selection in a list is still refused.
  - Not tried: a real browser on this machine; an input method; Safari and Firefox.
  - Found while measuring, not changed (plan 178's survey): Enter in the middle of a heading is
    refused (927 of 927); Backspace or Delete where a heading meets a paragraph does nothing
    (1,814 places).
  - Carry over, unchanged: nested lists, `\item[..]` and `description` raw in the visual view;
    LaTeX's own "Empty `thebibliography' environment" line still shows beside "Bibliography
    empty"; everything in the "Not done" of "A footnote can be added in the visual view".

## Captions and footnotes in the grammar check

- **What was wrong.** The check read paragraphs, headings and list items. A float was one hard
  stretch and a footnote one stand-in word, so a mistake in a caption or a footnote was never
  listed, and a file with no other finding said "Nothing found in this file." Over the corpus
  (31 papers, 118 body files; counts only): 15,448 words in 513 captions and 3,597 words in 164
  footnotes were never read, against 223,110 read: 7.9 % of the corpus's prose, in 27 of the 28
  papers with body text. Two smaller faults were found with it: a footnote's mark and a `\label`
  read as "Dummy", glued to the word before. That hid a misspelling in the word before a footnote
  or at the end of a caption, and put a stand-in at the head of the next sentence.
- **Now** (`prose` and `placed` in `packages/latex/src/prose.ts`, `argumentsOf` in
  `packages/latex/src/floats.ts`, a few lines of `checkGrammar`). A mistake in a caption or in a
  footnote is listed like any other, with the same buttons; "Change to ..." changes those
  characters and nothing else, and the source view underlines it where it is written.

  |                                                                                                                                                                                                                | Before                                                          | Now                                                        |
  | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
  | A caption (`\caption{..}`, `\caption*{..}`, `\subcaption{..}`, the long form of `\caption[short]{long}`) in a `figure`, `table`, `algorithm`, `wrapfigure`, `longtable`, `subfigure` ...                       | never read                                                      | read, as a paragraph of its own                            |
  | A footnote (`\footnote{..}`, `\footnote[2]{..}`) in a paragraph, a heading, a list item, a raw list, a caption, another footnote                                                                               | never read; its mark reads as "Dummy", glued to the word before | read, as a paragraph of its own; the mark reads as nothing |
  | The sentence a footnote hangs on                                                                                                                                                                               | read with "Dummy" where the mark is                             | read whole, as if the footnote were not there              |
  | `\label{..}` in running text or at the end of a caption                                                                                                                                                        | reads as "Dummy"                                                | reads as nothing                                           |
  | A formula, citation, reference, command, file name, label or code inside a caption or footnote                                                                                                                 | -                                                               | never to be changed, as everywhere else                    |
  | The short form `[short]`, a commented-out caption, `\captionof`, `\captionsetup`, `\footnotetext`, `\footnotemark`, a `\caption` in a listing, verbatim or a formula, a footnote inside `\texttt`, table cells | not read                                                        | not read                                                   |

  How it works: a footnote's words cannot be read where they are written without breaking the
  sentence around them, so where a caption or footnote stands its body is sent as markup that
  reads as nothing. After the whole source each body is sent again, opened by a paragraph break,
  and read from inside by the same walk as everything else. An offset past the source's length
  is mapped back to where the words are written with a small table (`asides`), and a finding
  that is not inside one stretch of the source is dropped. The segments are filled in for each
  body when it is read and sorted, so they still tile the source and `inProse` and `readAs` work
  unchanged.

  Against the real checker over the corpus: 4,533 findings before, all kept at the same places;
  483 more, 421 in captions and 58 in footnotes, in 26 papers, 4 of them beside a footnote that
  the stand-in had hidden; 431 spelling, 46 grammar, 6 style; no rule fires on captions as such.
  The checker took 3 % longer on 5.9 % more characters.

- **Held by** six new tests in `prose.test.ts` and one against the real checker in
  `grammar-benchmark.sandbox.test.ts`, both run on the development machine; one in
  `grammar.sandbox.test.ts` and one in `tests/e2e/grammar.spec.ts`, written but not run on the
  development machine (the local blob store refuses writes), so run only in CI. One existing
  expectation was changed on purpose, in "every character of every fixture is in the annotation,
  in order": what is sent is now the source, then each caption and footnote again (it was the
  source alone), and more than five are read over the fixtures.
- **Not done.**
  - In the visual view a finding in a caption or a footnote has no underline, and "Show in the
    text" puts the caret beside the figure or the chip (as for a raw list). The source view
    underlines and selects it.
  - Table cells, `\thanks`, `\footnotetext`, `\captionof`, the short form of a caption and a
    `\caption` written outside a float environment are not read. A footnote inside `\texttt` is
    not read.
  - A caption or footnote is checked as a paragraph of its own: a rule that needs the sentence it
    hangs on (agreement with the word before a footnote's mark) does not see it.
  - No more than 2,000 captions and footnotes are read in one file (the most in one corpus file
    is 48).
  - Not tried: a real browser on this machine; languages other than English (none is offered).
  - Carry over, unchanged: Enter in the middle of a heading is refused (927 of 927); Backspace or
    Delete where a heading meets a paragraph does nothing (1,814 places); nested lists,
    `\item[..]` and `description` raw in the visual view; LaTeX's own "Empty `thebibliography'
    environment" line still shows beside "Bibliography empty"; everything in the "Not done" of
    "Enter at the start of a list item always opens an item above it".

## Abbreviations and made-up names are not misspelt words

- **What was wrong.** The checker knows no model, data set, laboratory or funder by name, and
  every one it met was listed under "Spelling" with its nearest dictionary word to change it to
  (`ResNet`: "Reset"). Over the corpus (31 papers, 118 body files; counts only), checked as
  British English as an imported paper is: 4,329 of 5,071 findings were spelling; 1,903 of those
  (44 %), in 28 of 28 papers, were on a word written as an abbreviation or a made-up name, 1,521
  of them a word the paper uses three times or more. A median paper showed 121 spelling findings.
- **Now** (`coined` in `packages/server/src/grammar.ts`, one line of `checkGrammar`). A word the
  checker does not know is not listed under "Spelling" when it is written as an abbreviation or
  a made-up name. Everything else is as before: the same findings, at the same places, with the
  same buttons.

  | The word                                                                                           | Before                       | Now                                                             |
  | -------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------- |
  | All capitals, two or more: `QNLI`, `MSCOCO`, `QA`; with a plural or possessive `s`: `NNs`, `GPU's` | Spelling: "ONLY"? "MSC OCO"? | not listed                                                      |
  | A capital after a small letter: `ResNet`, `mAP`, `arXiv`, `GoogLeNet`, `SpanBERT`                  | Spelling: "Reset"? "map"?    | not listed                                                      |
  | Three capitals or more: `RMSProp`, `MBConv`, `XLNet`                                               | Spelling                     | not listed                                                      |
  | A digit in it: `word2vec`, `x86`, `CO2`                                                            | Spelling (when not known)    | not listed                                                      |
  | Such names joined by a hyphen, or with a single character: `CLIP-ResNet`, `BiT-L`                  | Spelling                     | not listed                                                      |
  | An ordinary word, however misspelt: `teh`, `recieved`, `pre-trianed`                               | Spelling                     | Spelling, unchanged                                             |
  | A slip of the Shift key: `THe`, `ANd`, `WHen`, `THis`                                              | Spelling                     | Spelling, unchanged                                             |
  | A name with one capital: `Lamport`, `Frobnet`, `Kovač`                                             | Spelling                     | Spelling, unchanged ("It is a word of this paper" is for these) |
  | A name joined to an ordinary word: `GPU-acelerated`, `DBN-based`, `ResNet-like`                    | Spelling                     | Spelling, unchanged: the ordinary part may be the mistake       |
  | A grammar or style finding on any of these words (`an ResNet`, a repeated `QA QA`)                 | Grammar                      | Grammar, unchanged: the rule is for spelling only               |
  | A word of the paper's own list ("It is a word of this paper")                                      | not listed                   | not listed                                                      |

  The checker is asked and answers as before; the rule is applied to each answer after the
  paper's own list. It reads the stretch as the checker read it (`\'e` already `é`), splits it at
  hyphens, dashes, slashes and spaces, sets parts of one character aside, and says yes when every
  part left has a digit, a capital directly after a small letter, three capitals, or two capitals
  and no small letter. There is no dictionary, no list of names and nothing stored.

  Corpus result: 1,903 spelling findings go and 2,426 stay; a median paper shows 52 spelling
  findings (was 121) and 75 findings in all (was 140); the 742 grammar and style findings are
  untouched. Of the 222 different words dropped that a paper uses once, none is an ordinary word;
  about five are a name misspelt, for none of which the checker had offered the name.

- **Held by** two tests in `grammar.test.ts` and one against the real checker in
  `grammar-benchmark.sandbox.test.ts`, run on the development machine (the benchmark document came
  out unchanged); one in `grammar.sandbox.test.ts`, written but not run on the development machine
  (the local blob store refuses writes), so run only in CI. No existing expectation was changed
  and no browser test was added.
- **Not done.**
  - A made-up name misspelt (a letter missing in a model's name) is no longer listed. The checker
    never offered the right name for one.
  - A slip that puts a capital after a small letter in an ordinary word (`tHe`) is no longer
    listed; `THe` and `ANd` still are.
  - A name joined to an ordinary word (`DBN-based`, `ResNet-like`) is still listed: 163 findings in
    the corpus, none a mistake in the sample read. Telling a right ordinary part from a wrong one
    needs a second question to the checker.
  - A name with one capital (an author, a town, an institute) is still listed until it is made a
    word of the paper: 770 findings, 403 of them in two papers. 139 of the 770 are a word of the
    paper's own reference list.
  - A word the paper uses many times is listed each time; "It is a word of this paper" takes all
    of them at once. After this change a median paper's 52 spelling findings are 26 different
    words.
  - Every imported paper is checked as British English until someone changes it on the paper's
    page. 20 of the 28 corpus papers are written in American English and show 291 more spelling
    findings for it (median 9 a paper, at most 52); the 7 British ones would show 252 more if the
    default were American. Choosing the spelling at import from the paper's own words is the
    natural next step.
  - The panel, the paper's page and the benchmark document do not say that such names are not
    checked.
  - Not tried: a real browser on this machine (nothing in the browser changes).
  - Carry over, unchanged: everything in the "Not done" of "Captions and footnotes in the grammar
    check".

## An imported paper starts in the spelling it is written in

- **What was wrong.** Every imported paper was checked as British English until someone changed it
  under Language on the paper's page. Of the 29 corpus papers that have a root file and a checker
  answer, 19 are written the American way and showed 279 spelling findings that are not mistakes
  (24 % of theirs; median 8 a paper, at most 52). 6 are written the British way and would show 251
  more under a default of American.
- **Now** (`spellingOf` in `packages/latex/src/spelling.ts`, called by `describeImport`;
  `importZip` stores the result in `projects.language`, as it does the compiler).

  | The paper that is imported                                                                                 | Before  | Now                                          |
  | ---------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------- |
  | More words spelt the American way than the British (`color`, `behavior`, `modeling`, `center`, `analyze`)  | British | American English; the report says so and why |
  | More words spelt the British way (`colour`, `centre`, `analyse`, `normalisation`)                          | British | British; the report says so and why          |
  | As many each way, or none, and the preamble names a variant (`[american]{babel}`, `[UKenglish]`, `main=…`) | British | what the preamble names; the report says so  |
  | As many each way, or none, and no such option (plain `[english]` is none)                                  | British | British, as before; the report says nothing  |
  | Any paper, after someone chooses under Language on its page                                                | choice  | their choice: nothing reads the paper again  |
  | A paper started empty or from a template; a paper imported before this change                              | British | British, unchanged                           |

  Only the prose of the files the root reads in its body is read (a command, a formula, a comment
  and a label count for nothing; a caption and a footnote count). Only words of four or more small
  ASCII letters count, so names and sentence openers say nothing. The words decide, then the
  preamble, else nothing is known. The choice is made once at import and stored; nothing reads
  the paper again. Counted: `-or`/`-our` words, `center/centre`, `analyze/analyse`, `labeled`,
  `modeling`-type words with `mis`/`re`, `-isation`, `-ise` verbs, `fiber/fibre`, `defense/defence`
  and the like. Not counted: `-ize` (Oxford spelling), `-lled`/`-lling`, `grey`, `gray`, `math`,
  `program`, `license`, `practice`. The corpus result: 2,147 spelling findings, was 2,426; none of
  the 25 choices was the worse one; 4 papers of 29 got none. The dictionary check: the American
  pattern takes 229 of the checker's words and the British one 4,096, and the live checker calls
  every one misspelt in the other spelling and right in its own.

- **Held by** four tests in `packages/latex/src/spelling.test.ts`, three in
  `packages/server/src/compiler.test.ts` and two against the real checker in
  `packages/server/src/grammar-benchmark.sandbox.test.ts`, all run on the development machine; one
  in `packages/server/src/grammar.sandbox.test.ts` and one in `tests/e2e/grammar.spec.ts`, written
  but not run on the development machine (the local blob store refuses writes, and no browser was
  tried), so run only in CI. No existing expectation was changed.
- **Not done.**
  - A paper started empty or from a template, and every paper imported before this change, is
    British until someone chooses. Nothing reads a paper again after import: a paper whose text is
    replaced or written later keeps what it has.
  - With no evidence, and with as many words each way, a paper is British. The owner has not chosen
    a default; this change does not choose one.
  - A paper that mixes both spellings (3 of 29) is checked in the one it uses more and shows the
    others as findings. No "the paper mixes spellings" note.
  - Words spelt with ae/oe (`anaemia`, `haemoglobin`, `oestrogen`), `theatre`, `mould`, `plough`,
    `practise` and the like are not counted; nor are `-ize` and `-lled`, which the checker accepts
    in both. A medical paper is still decided by its `tumour`, `colour`, `centre`, `analyse`.
  - Only the root's preamble and the files it reads there are asked about babel; a class or style
    of the paper that loads `[british]{babel}` is not. `\babelprovide`, `\selectlanguage` and
    Canadian English are not read. A paper whose main language is not English is still checked as
    English.
  - The root an archive's review data names (`carriedRoot`) can differ from the importer's; the
    spelling is the importer's root's.
  - A paper exported and imported again is read again: a choice made on the first does not travel
    (language settings never did).
  - The report keeps "Spelling was set to …" after the person changes the setting; it is a record
    of the import.
  - Not tried: a real browser on this machine.
  - Carry over, unchanged: the "Not done" of "Abbreviations and made-up names are not misspelt
    words", but for its line on British English, which this section replaces.

## Comments and proposed changes come before the spelling list

- **What was wrong.** Under the text the page drew Spelling and grammar, then Proposed changes,
  then Comments, and the first has no end: every finding of the file, up to five buttons each.
  "Propose a change here" and "Comment on the selected text", the only way to start either, and
  every open proposal and thread, lay under it. Measured on the corpus (31 papers, 118 body files;
  counts only):

  | Findings                                   | Median | Upper quartile | Most |
  | ------------------------------------------ | ------ | -------------- | ---- |
  | In a file (118 files)                      | 8      | 24             | 380  |
  | In the largest file of a paper (29 papers) | 48     | 76             | 192  |

  | A window of 1280×800                       | "Comment on the selected text" below the text | Tab presses |
  | ------------------------------------------ | --------------------------------------------- | ----------- |
  | A file with nothing found                  | 268 px (0.3 of a window)                      | 2           |
  | The median file (8 findings)               | 1,646 px (2.1 windows)                        | 32          |
  | The median main file (48 findings)         | 8,172 px (10.2 windows)                       | 196         |
  | The upper-quartile main file (76 findings) | 12,071 px (15.1 windows)                      | 242         |
  | The largest main file (192 findings)       | 33,015 px (41.3 windows)                      | 721         |

  More than one window below the text in 74 of 118 files (more than three windows in 43); at
  320×480, 93 of 118 (67), and 24.5 windows in the median main file. No test saw it because the
  test papers have one to three findings. The pixel figures are from the app's CSS on static
  markup, not from the running page.

- **Now** (`FileEditor.tsx`: the `<Language>` panel is drawn after `<Threads>`).

  | Under the text of a `.tex` file           | Before                                | Now                                                                    |
  | ----------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
  | First panel                               | Spelling and grammar                  | Proposed changes                                                       |
  | Second                                    | Proposed changes                      | Comments                                                               |
  | Third                                     | Comments                              | Spelling and grammar                                                   |
  | Tab from the text                         | every finding's buttons, then Propose | "Propose a change here", "Comment on the selected text", then the rest |
  | A file that is not LaTeX (`.bib`, `.sty`) | Proposed changes, Comments            | the same                                                               |
  | A finding in the text                     | underlined; listed                    | the same                                                               |

  Both buttons are 57 and 181 px below the text in every file at both sizes; two Tab presses.
  Nothing is folded or capped; nothing about a finding changes.

- **Held by** one test in `tests/e2e/grammar.spec.ts`, written but not run on the development
  machine (the local blob store refuses writes), so run only in CI. The unit suite, typecheck and
  lint ran on the development machine. No existing expectation was changed.
- **Not done.**
  - The list of findings is as long as it was: 51 % of a paper's spelling lines repeat a word
    already listed in the same file (1,089 of 2,147 in the corpus; a median paper 45 lines for 25
    words). One line per word is the natural next step; what "Change to" then acts on is the
    owner's to say.
  - With many open proposals the Comment button is below them (decided proposals and resolved
    threads are folded; open ones are not). The two buttons are not in the toolbar or the menu at
    a place, and there is no key for either.
  - With many open threads the spelling list is far down, and nothing at the head of the page says
    how many findings there are or leads to them; a finding is still underlined in the text.
  - Nothing at the text says that there are open proposals or comments further down, or how many.
  - A name with one capital is 749 of the 2,147 spelling lines (`Eq`, `Eqs`, `Eqn`, `Alg` before a
    reference: 103); `conv.\ layers` and `where` after a display formula are reported as a
    sentence that starts without a capital (about 37 of 51 such findings).
  - Not tried: a real browser on this machine; a screen reader.
  - Carry over, unchanged: the "Not done" of "An imported paper starts in the spelling it is
    written in".

## A misspelt word is one line of the spelling list

- **What was wrong.** The panel drew a line for every finding, and a paper misspells the same word
  again and again (a name, a method). Measured on the corpus (31 papers, 118 body files; counts
  only, by the same grouping code this change ships):

  | Corpus, 118 files                         | Before | Now   |
  | ----------------------------------------- | ------ | ----- |
  | Lines in the panel                        | 2,869  | 1,781 |
  | of which spelling                         | 2,147  | 1,059 |
  | Buttons (Tab stops)                       | 10,684 | 6,281 |
  | Lines in a paper's main file, median      | 48     | 32    |
  | Lines in a paper's main file, upper quart | 76     | 45    |
  | Tab stops in a main file, median          | 188    | 117   |

  A line goes in 59 files, in 28 of 29 papers. 26 lines stand for ten places or more, the most 164. The panel's height, median main file: 10.2 windows to 6.2 at 1280×800, 24.6 to 14.6 at
  320×480. Those heights are from the app's CSS on static markup, not from the running page.

- **Now** (`apps/web/lib/findings.ts`, `Language.tsx`).

  | In the panel                    | Now                                                                                               |
  | ------------------------------- | ------------------------------------------------------------------------------------------------- |
  | A word misspelt in seven places | One line, where the first stood; it ends "Place 1 of 7."                                          |
  | A word once; grammar or style   | The same line as before                                                                           |
  | "Change to" / "Propose"         | Changes (or proposes for) the place the line stands at, and no other; the line stays for the rest |
  | "Show in the text"              | Selects the place the line stands at; again, the next, and round                                  |
  | "It is a word of this paper"    | Unchanged: every place leaves the list                                                            |
  | The text                        | Unchanged: every place is still underlined                                                        |
  | The keyboard after "Change to"  | Stays on the button while places are left                                                         |

  One press changes one place, the one the line stands at. Places are one line only when the
  checker says the same about each (same words, reading, rule, message and drawn suggestions); in
  the corpus that never separates two places of a word: 1,059 lines either way.

- **Why one place and not all.** The same letters are not always the same mistake (`teh` in a
  quoted string or a name), so changing all at once edits places nobody looked at. One press with
  seven edits is hard to take back, files seven proposals for a reviewer and changes seven words
  under a collaborator. One place a press is what the button did before, and costs little, since
  the line and its button stay put (Enter seven times). A "Change all" can be added later without
  taking anything back. The owner had not answered and may overrule.
- **Held by** `apps/web/lib/findings.test.ts` (7 tests; run on the development machine with the
  unit suite, typecheck and lint) and one test in `tests/e2e/grammar.spec.ts`, written but not run
  on the development machine (the local blob store refuses writes), so run only in CI. No
  existing expectation was changed.
- **Not done.**
  - No "Change all": a word in seven places takes seven presses (the button stays under the pointer
    and keeps the keyboard). The owner's to say.
  - "Show in the text" puts the keyboard in the text, as it always did; stepping through seven
    places by keyboard means coming back to the button each time.
  - The line does not say where a place is (a line number, the words around it); the text shows it.
  - Which place a line stands at is kept in the page only: opening the file again starts every line
    at its first place.
  - One line per word in a file, not in a paper: a word misspelt in five files is five lines
    ("It is a word of this paper" takes all five).
  - Grammar and style findings are not put together: 64 "three sentences begin with the same word",
    44 "all of the" and the like are a line each.
  - An unbroken word of thirty letters or more in a "Change to" button makes the page scroll
    sideways at 320 px, before and after this change alike; the longest in the corpus has 18.
  - The largest main file still has 155 lines (34 windows at 1280×800): its words are mostly
    different ones.
  - Not tried: a real browser on this machine; a screen reader.
  - Carry over, unchanged: the "Not done" of "Comments and proposed changes come before the
    spelling list", except its first line, which this section answers.

## What changed since a revision you choose

- **What was wrong.** Every build of changed text makes a revision, about a hundred an hour of
  writing, and "Changes since N" on a row compares with the row below. For a paper with one named
  revision ("Sent out") and an hour of writing after it: 101 revisions, 51 rows on the page, 50
  comparisons offered, 49 of them of a single build (about eight keys), "Sent out" to now not
  offered, and 5,050 pairs of revisions there are. Measured by applying the page's own rule to what
  `listRevisions` returns for a paper made in the real database, by a probe that is not kept.
- **Now** (`apps/web/lib/compare.ts`, `compareAction`, `revisionOfNow`, the paper's page). Above
  the table of revisions, a form: "Changes from" (a list), "Changes up to" (a list), and a button
  "Show the changes". Both lists hold every revision the table shows, newest first, as number, name
  (cut at 40 characters) and time. "Changes from" starts at the newest revision somebody named or
  restored, or the oldest listed when none is; for a reviewer or viewer the newest revision of all
  is passed over, since their comparison ends there. "Changes up to" starts at "The paper as it
  is now" for an owner or editor: pressing the button then makes a revision of the paper as it is,
  unless the latest one is it already (as a download and a build do), and shows the comparison. A
  reviewer or viewer can only choose revisions and cannot make one. "Changes since N" on each row
  and the comparison page are unchanged.
- **Held by** `apps/web/lib/compare.test.ts` (7 tests, run on the development machine with the unit
  suite, typecheck and lint); one test in `revisions.sandbox.test.ts` and one in
  `tests/e2e/revisions.spec.ts`, both written but run only in CI (the local blob store refuses
  writes). The sandbox test's body and the browser test's steps were tried on the development
  machine against the real database with a file store kept in memory; the layout figures (three
  rows and 181 px at 320x480, no sideways scroll) are from the app's CSS on static markup. No
  existing expectation was changed.
- **Not done.**
  - A comparison gives up on a file when the stretch from its first changed line to its last is
    over about 2,000 lines on each side, however few lines changed in between: with sixty scattered
    changes, 2 of 101 corpus files (the largest files of 2 of 29 papers, 2,547 and 3,079 lines;
    four papers have a file over 2,000). The page says so and links both ZIPs. Raising the limit or
    comparing another way touches the restore, which uses the same comparison.
  - A reviewer or viewer cannot compare with the paper as it is now, only with the newest
    revision; text typed since the last build or save is not in it, and nothing says so.
  - A revision made for a comparison is listed as "Unnamed ... by" the person who compared, though
    they wrote nothing; a download and a build do the same.
  - Only the revisions on the page can be chosen: the named ones and fifty automatic ones at a time.
  - The comparison does not say who changed what, only who made each revision; a file that was
    added shows "Added" and none of its text; a moved paragraph is a removal and an addition.
  - The comparison page's title in the browser tab is "Revision ? to revision ?" for every real
    comparison (it reads the numbers from the address, which holds ids), today as before; its
    heading is right.
  - Chosen the other way round (from a later revision to an earlier one), the comparison is shown
    that way, with added and removed exchanged; the heading says which.
  - Nothing compares two PDFs, and nothing leads from a changed line to its place in the editor.
  - Not tried: a real browser on this machine; a screen reader.
  - Carry over, unchanged: the "Not done" of "A misspelt word is one line of the spelling list".

## A long file whose changes lie far apart is compared line by line

- **What was wrong.** The line comparison fills a table of the stretch from a file's first changed
  line to its last, and gives up over 4,000,000 cells (about 2,000 lines on each side), however few
  lines changed in between. Measured on the corpus (101 files of 29 papers, 20 draws each; a word
  changed on 2, 5, 20, 60 and 300 prose lines): with 60 changed lines the main files of two papers
  (2,547 and 3,079 lines) were never shown, and a third (2,176 lines) failed one time in three; four
  papers have a file over 2,000 lines. Over all 2,020 comparisons per row, the table declined 1, 12,
  29, 47 and 55 times for 2, 5, 20, 60 and 300 changed lines; with this change, never. The figures
  come from the product's own functions run on corpus files changed at random by a probe that is not
  kept.
- **Now** (`diffLinesFar` in `textdiff.ts`, called by `diffRevisions` only). The table's own answer
  wherever the table gives one; otherwise a shortest edit script (Myers) whose cost grows with the
  number of changed lines, up to 2,000 lines removed and added together (`FAR_EDITS`; 16 MB, the
  table's own ceiling) and 20,000,000 line comparisons; past that the page's sentence and ZIP links
  as before. Removals come before additions within a run, as in the table's answer.
- **Held by** five tests in `textdiff.test.ts` (run on the development machine with the unit suite,
  typecheck and lint) and one in `revisions.sandbox.test.ts` (written but run only in CI; the local
  blob store refuses writes). No browser test: the page is unchanged. No existing expectation was
  changed.
- **Not done.**
  - Done since: the restore (`restoreEdits`, so also a file replace) and the PDF's line map
    (`lineMap` in `builds.ts`) now call `diffLinesFar`. In a long file, a restore across changes
    that lie far apart replaces each changed run on its own (it used to delete and retype the whole
    stretch between them, a median 84% of the file in the two corpus papers above), so comments and
    proposals between the changes keep their place, and a jump from the PDF lands on the exact line.
    Where the table answers, the result is as before.
  - More than 2,000 lines removed and added, in a stretch too long for the table, is still "too much
    changed": the restore then replaces one span from the first to the last changed line, and the
    PDF's line map keeps the line number as it is, marked moved.
  - A file that was added still shows "Added" and none of its text; a moved paragraph is a removal
    and an addition.
  - Not tried: a real browser on this machine.
  - Carry over, unchanged: the rest of the "Not done" of "What changed since a revision you choose".

## The list of papers says what waits, and a name without spaces fits the screen

- **Found by** walking the first-run flow in the real app at 320×480 and 1280×800 (sign in, import,
  edit, build, invite, comment, propose, revision, checks, downloads). The flow itself held: no
  page scrolled sideways and every step worked. Two things at its edges did not.
- **What was wrong.** (1) The list of papers gave a name and a role. A proposal or a comment that
  mentions nobody sends no email, so with several papers the only way to find one was to open each
  paper. (2) A paper takes its ZIP's name, and a name with underscores has no place to break: at
  320 px the paper's page was 818 px wide for a 68-character name, the editor 646, the list 528; at
  768 px the paper's page and the checks were still 818. About 23 characters is enough at 320 px.
- **Now.** `listProjects` returns `threads` and `proposals` for each paper, from `openThreadsSql`
  and `openProposalsSql` in `projects.ts`, which `submissionChecks` uses too: open threads with a
  comment left and undecided proposals, in files not deleted. The list shows them as one link to
  the paper's "Review" section, worded by `reviewWaiting` (`apps/web/lib/review.ts`); nothing is
  shown when nothing waits. Everyone on the paper sees the same numbers. In `globals.css`,
  `.list li` and every `h1` have `overflow-wrap: break-word`, and `h1` has `max-width: 100%`. Not
  `anywhere`: a heading in a `.bar` would be squeezed to the space its neighbours leave, and
  ordinary names would break mid-word where today the row wraps.
- **Held by** `review.test.ts`, one test in `threads.sandbox.test.ts`, a step in `proposals.spec`
  and a test in `a11y.spec`. Ordinary names were measured to lie exactly where they lay (seven
  pages, three widths).
- **Running store-backed tests where the blob store is broken.** `S3_ENDPOINT` pointed at a server
  that keeps files in memory lets the sandbox tests and Playwright run on the development machine.
  This is how they were run here; CI ran them against the real store.
- **Not done.**
  - The list does not say what is new since the person last looked, who is waiting for whom, or
    when a paper last changed; it is not sorted by what waits.
  - No email for a reply or a proposal (the owner's decision).
  - A file's name with no place to break was not looked at here (the files table scrolls within
    itself; the editor's file list already wraps).
  - An invitation link opened signed out shows the plain sign-in page, with nothing about the
    invitation.
  - Back/Forward with the sync service away can still drop edits that were never confirmed.

## "Show in PDF" in a narrow window

- **Found by** walking two people through one paper and the PDF pane at 320 px. Two editors in one
  paragraph, a build broken by a co-author, a file renamed or deleted under someone typing, the
  template-to-submission path and the data-to-chart path all held.
- **What was wrong.** Under 60rem the PDF is under the editor. "Show in PDF" scrolled the PDF's own
  box to the line and marked it, but the box was off the screen (the band 600-800 px below the
  bottom of the window at 320, 768 and 959 px wide), so nothing was seen to happen. Half a laptop
  screen, a tablet held upright and a 1280 px window at 150% zoom are all under 60rem.
- **Now** `PdfView` asks `intoWindow` (`apps/web/lib/pdfsync.ts`) how far the window must go for
  the band to be on the screen, and scrolls it by that: nothing when the band is already there,
  otherwise its top a third of the way down. Focus stays on the button. The way back was already
  there: a double-click on the page or "Go to the text for the middle of the pages shown" puts the
  caret in the text and the window follows it.
- **Held by** `pdfsync.test.ts` and a test in `synctex.spec` at 700 and 320 px, both views. In a
  wide window the band was measured at the same pixel before and after.
- **Not done.**
  - Nobody with the paper open is told when someone restores a revision: words typed just before
    go with the restore (they are in the revision it keeps) and the page says only "All edits
    saved." The sync server already sends each editor the restore's number; the editor shows
    nothing for it.
  - A renamed file keeps its old name in a co-author's open editor until they reload.
  - A paper made from a template passes the checks before submitting with the template's
    placeholder sentences still in it.
  - The toolbar's own note says nothing after a press; what is said ("Shown on page N of the PDF.")
    is in the pane.
  - An invitation link opened signed out; Back/Forward with the sync service away (as before).

## A restore is said to everyone who has the paper open

- **Found by** the walk of plan 207: an editor typed while the owner restored a revision. The words
  from before the restore went with it, the tail of a word typed during it stayed
  (`...narrow ring2 during3...`), and the page said only "All edits saved." The sync server already
  sent each editor the restore's number; the editor showed nothing for it. The same when coming back
  online with nothing unsent.
- **Now** the sync server sends, with the number, who restored the paper, to which revision, and
  which revision holds the paper as it was (`restoreNote` in `packages/server/src/revisions.ts`;
  always the revision numbered one below the restore). The ticket route returns the same for someone
  coming back online. The editor shows it directly above the text, in both views
  (`apps/web/lib/restored.ts`, `.editor-notice`): the sentences, a link to the comparison from the
  kept revision to the restore, and "Dismiss", which returns the keyboard to the text. It is a
  polite live region, not a second status: the status line still says whether the person's own
  edits are saved. Where edits typed offline are held for the person's decision, the note stands
  beside the choice.
- **The words typed just before are not put back for the person.** They had reached the paper, and
  the restore replaced them on purpose; they are in the kept revision, and the comparison shows them
  as removed, to copy. Words still on their way at that moment are in the text, and the note says so.
- **Held by** `restored.test.ts`, `revisions.sandbox.test.ts`, `sync.sandbox.test.ts` and two tests
  in `recover.spec` (connected; back online with and without unsent edits; the person who restored;
  visual view; 320 px; dismissed and not said twice).
- **Not done.**
  - A file that the restore removes (it was added after the restored revision) closes in its
    editors with "You no longer have access to this file, or it has been deleted.", without saying a
    restore did it.
  - The list of files beside the editor, and the paper's own page in another tab, are not told:
    files a restore brought back, removed or renamed show after a reload.
  - The note is not kept across a reload, and there is no email about a restore.
  - A renamed file keeps its old name in a co-author's open editor until they reload; an invitation
    link opened signed out; Back/Forward with the sync service away (as before).

## An open editor follows the paper's files

- **Found by** the walks of plans 207 and 209: the list of files beside the text, the open file's name and the build pane's files were the ones the page was made with. A file a co-author added was not in the list; a renamed file kept its old name everywhere; a file deleted, or taken out by a restore, closed with "You no longer have access to this file, or it has been deleted." either way, as it did for someone taken off the paper.
- **Now** `createFile`, `putFile` (when it adds), `removeFile` and `renameFile` announce `files` (`filesChanged` in `packages/server/src/files.ts`); the sync server passes `{ files: true }` to everyone with the paper open, and the editor asks the web app for the list (`GET /projects/:id/files`, `apps/web/lib/paperfiles.ts`). It asks again after a restore, on reconnecting, and when its file is refused. The list (`Files.tsx`), the build pane and the editor's own name for its file (above the text, the tab's title, both views' names) follow. The editor is not rebuilt for a rename: `props.path` is no longer a dependency of the effect that makes it.
- **Not a page refresh.** One that fails makes the browser load the page afresh (see `Fresh.tsx`), and one that works hands the editor new `canWrite`/`visual` props, which rebuild it under the person.
- **A file that is gone says why**, above the text where a restore is said: taken out by a restore (who, to what, the revision that keeps it, and the comparison), deleted, or the person is no longer a member. Which restore took a file out is the server's answer (`restoreThatRemoved`: the file's removal and the restore's revision carry the same transaction time), not a guess from what the editor has heard. The status line keeps its sentence.
- **Held by** `restored.test.ts`, `revisions.sandbox.test.ts`, `sync.sandbox.test.ts`, `files.sandbox.test.ts` (the list is for people on the paper only) and `recover.spec` (added, renamed with Undo kept, deleted, taken out by a restore, taken off the paper).
- **Not done.**
  - The paper's own page in another tab is still not told; it shows the change after a reload or on coming back to it.
  - A rename is not announced, and who renamed or deleted a file is not said.
  - ~~The comparison a restore's note links to lists a removed file as "Removed" without its lines.~~ Done: see "The comparison shows the text of added and removed files".
  - A file renamed from `.tex` to something else keeps its visual view until reload; a file that stopped being text (replaced by a picture, or by a restore) closes with the either-or sentence alone.
  - The root file's folder in the build pane, the paper's macros and the people who can be mentioned are still as the page was made.
  - An invitation link opened signed out; Back/Forward with the sync service away (as before).

## An invitation opened before signing in says that it is one

- **Found by** the planner in the real app: the link in an invitation email, opened by someone
  not signed in, led to the plain sign-in page. Nothing said it was an invitation or which
  address to use; another address ended, two emails later, at "This invitation is for someone
  else"; a used, cancelled or expired invitation asked for a sign-in before saying so.
- **Now** the sign-in page, when it is on the way to an invitation, says "You have been invited
  to a paper on PaperWeave. The invitation is for r…@example.org: sign in with that address, and
  the next page lets you join the paper." For an invitation that can no longer be used it says
  that instead, and signing in leads to the person's papers. The same after "Sign out" on the
  "for someone else" page and after a sign-in link that had expired.
- **How** `invitationToken` and `hiddenAddress` (`packages/server/src/auth.ts`) and
  `invitedAddress` (`projects.ts`): a read by the invitation's token that returns the address as
  its first letter and domain, the rule the confirm page already had, and nothing of the paper.
  No new route or action.
- **Held by** `auth.test.ts`, `projects.sandbox.test.ts` and `projects.spec` (valid, used, and
  an address that only looks like an invitation; both states audited).
- **Not done:** the address is not filled in for the person; the paper's name, the role and who
  invited are shown only after signing in; the person still gets a second email to sign in; the
  invitation email's own text is unchanged.

## A paper can be deleted

- **Found by** the planner, stepping back from the walks: nothing could take a paper out. No
  function, page or command deleted one, so a wrong ZIP, a trial paper or a manuscript someone
  wanted gone stayed for ever, for everyone invited to it; the operator had nothing to run either.
  And deleting the row, which every foreign key was written for, took 45 s for a paper of 5,000
  revisions and 10 s for one of 2,000 files on the development database (17,000 papers): eight
  columns that point at a paper, file, revision or build had no index.
- **Now** the owner finds "Delete this paper" at the foot of the paper's page. It leads to a page
  that says what goes (files, revisions, every build, comment, proposed change and chart; who
  else is on the paper; invitations not taken up), offers the ZIP with its review data, and has
  a field for the paper's exact name and one button, "Delete this paper for everyone".
  Afterwards the list of papers says so.
  `deleteProject` (`packages/server/src/projects.ts`) deletes the paper's row in one statement,
  which asks again whether the person is the owner and whether the name typed is the paper's
  current name (a wrong or missing name deletes nothing and says so on the page); everything else goes with it through the
  foreign keys. Migration `0033` adds the eight indexes (0.6 s and 0.3 s for the same two papers).
- **People with the paper open** are closed at once, as when someone is removed (`acl`); the note
  above the text now reads "You are no longer a member of this paper, or its owner has deleted
  it." The two are not told apart: a paper that is not yours and one that is not there answer
  the same, by design.
- **A build or chart being made** holds its row until it is done. The delete waits three seconds
  and then says the paper is being built or changed, that nothing was deleted, and to try again.
- **Why the name is typed.** Deleting cannot be undone from the service (no period to bring a
  paper back, no email to co-authors), so the owner must type the paper's exact name, checked
  on the server. This is the conservative default; the owner of the product can relax it to a
  single press by dropping the name from `deleteProject` and the page.
- **Who may:** the owner alone (`project.settings`, as for renaming). Anyone else on the paper is
  refused; anyone not on it is told "not found".
- **Held by** `projects.sandbox.test.ts` (every role; a wrong or missing name; a held row; all rows gone; another paper
  with the same bytes untouched; every such column indexed), `sync.sandbox.test.ts` (editors
  closed, the server serves on) and `projects.spec` (the page, the press, the co-author's open
  editor, and nobody able to open it again).
- **Not done.**
  - The bytes in the object store are not removed. They are named by their content and can be
    another paper's too; nothing in the database points at them once the paper is gone, so no
    page or route can reach them. Removing them is a sweep of objects nothing refers to, and
    backups keep what they held: both wait on the retention decision.
  - What a worker kept from the paper's last build (headings, captions, the reference list)
    stays on its disk until 200 other papers have built, as before.
  - Nobody is sent an email, and there is no period in which a deleted paper can be brought
    back.
  - A deleted paper leaves the product metrics: papers made, downloads and two-author papers are
    counted from the rows that are there.
  - There is no way to delete an account, and the operator has no command of their own: they
    delete as the owner would, or in SQL (`delete from projects where id = …` is now safe to run).
  - Measured while choosing this, not changed: typing in the visual view of one 150 KB file took
    a median of 56 ms a key (p95 80) in the real editor, against 24 ms in a 33 KB file and 16 ms in
    the source view of either. One machine, once.
  - The paper's own page in another tab; ~~a restore-removed file's lines in the comparison~~
    (done, see "The comparison shows the text of added and removed files"); a file renamed away
    from `.tex` (as before).

## Typing in the visual view of a long file is fast again

- **What was wrong.** In the visual view of a 150 KB file a key took a median of 48 to 80 ms
  (p95 72 to 112) and up to 21 of 48 keys were a long task; the spec asks for 50. Two causes:
  every key paid for every block of the file, on screen or not (the editor is one `contenteditable`
  of some 35,000 elements: the browser's own text insertion, hit testing and paint grew with the
  file); and once a comment, proposed change or spelling finding stood after the caret in the same
  paragraph, each key drew that paragraph twice (the marks were placed from source offsets that
  were one letter behind, and again a moment later when they were set), and the second drawing
  wrote the selection to the screen again, which costs about 20 ms in a long editable document.
- **Now** the blocks of the editor that are out of sight are not laid out or painted until they
  come near (`content-visibility: auto` on `.visual .ProseMirror > *`, `apps/web/app/globals.css`),
  and the marks are kept in plugin state and moved through each transaction
  (`apps/web/lib/visual.ts`, `marks`, `drawMarks`). They are still placed afresh when they are set
  (after every change to the text) and when the document is drawn from the source, so the
  mapping only makes the first drawing of a key the right one; the second finds nothing to change
  and leaves the selection alone. A block's height is remembered once seen (4em until then), and
  `overflow-clip-margin: 1.5em` keeps another person's name above their caret from being cut off
  by the paint containment that comes with the rule.
  A formula or table wider than the pane would be cut off by the same rule (the pane used to
  scroll sideways to reach it), so the editor's top-level `div` blocks (display formulas, figures,
  tables, raw LaTeX) now scroll sideways on their own.
- **Found after CI failed on this change** (`insert.spec.ts` "a list is started from the toolbar…",
  `toHaveCount(3)` received 1). The rule also skips a block the browser has not yet laid out in a
  frame: a paragraph just opened with Enter is one, and a key typed into it in that frame is put in
  by the browser, which finds the caret by that layout, and leaves the caret before the letter
  (typing "After" gave "fterA"; Enter in a list item typed fast after the view switch did not
  split). It showed on a fast machine and not under `E2E_CPU_THROTTLE`: with it, 0 of 10 at 4,
  0 of 8 at 8 and 0 of 6 at 12 failed (CI's own run was at normal speed, 7.5 s); at normal speed
  the same test failed 6 of 20 and 1 of 12 on this change and 0 of 20 on its parent. Only the CSS
  rule does it: this change with the rule's `content-visibility` taken out, 0 of 20 (the marks in
  plugin state are not involved). So the blocks the selection is in are now left out of the
  rule: a plugin (`caretBlocks`, `apps/web/lib/visual.ts`) puts the class `caret-block` on the
  top-level block with the selection and on the last seven it was in, and the rule is
  `.visual .ProseMirror > *:not(.caret-block)`. The class is on a new block in the same drawing
  that makes it, so it is never skipped. It stays on a block the selection has left because a
  first version that took it off at once failed `keys.spec` "a reviewer selects words…" (3 of 4
  runs): a block given the rule again is skipped for a frame, takes the guessed 4em, and the
  blocks below it jump (tops 324 to 374 px) while the next key is on its way. With the last eight
  kept, the list test passed 40 of 40, against 6 of 20 before, and that `keys.spec` test 15 of 15. Typing
  speed is unchanged (150 KB: median 16–24 / p95 32–40 ms, no long task; 33 KB: 16 / 16–32).
  Run locally, the sign-up limits (`INVITATIONS_PER_HOUR`, `SIGN_IN_EMAILS_PER_HOUR`) had to be
  raised for so many runs of one test.

  Keydown time in the real editor (production build, 48 keys 70 ms apart in the middle of the
  file, the planner's `rounds` approach), median / p95 in ms and keys that were a long task, before
  and after:

  | File   | Round                           | Before              | After             |
  | ------ | ------------------------------- | ------------------- | ----------------- |
  | 33 KB  | 1–3, no finding after the caret | 16–24 / 24–32 / 0   | 16 / 16–32 / 0    |
  | 33 KB  | 4–5, a finding after the caret  | 24 / 32–40 / 0      | 16 / 24 / 0       |
  | 150 KB | 1–3                             | 48–56 / 72–88 / 2–5 | 16–24 / 24–32 / 0 |
  | 150 KB | 4–5                             | 72–80 / 112 / 14–21 | 24 / 32 / 0       |

  One machine, headless Chromium, one run of each. The browser's event timing rounds to 8 ms and
  does not report keys under 16 ms, so 16 is its floor.

- **Held by** `tests/e2e/large.spec.ts` (a long file in the visual view: blocks far down have
  `content-visibility: auto`, a formula wider than the pane scrolls in its own block and the pane
  does not scroll sideways, and a word typed before a marked finding in the same paragraph leaves
  the mark on its own word and is saved). No timing is asserted, as it would flake in CI; the
  numbers are in `docs/benchmarks.md`. The speed limits of `spike.spec` still apply.
- **Not done.**
  - React still commits two or three times a key (`setSync`, and `setOthers` with a new array at
    every awareness change, the person's own caret included), and each commit reads the
    selection by walking the text up to the caret: 6 to 7 ms a key in the middle of a 150 KB
    file. Fewer commits would take most of it; it needs a decision on whether "All edits saved."
    may lag a moment. Left for later.
  - Selecting everything, or finding in the page, makes every block count as seen: typing with
    the whole file selected is as slow as before.
  - Until a block has been seen its height is a guess of 4em, so the scroll bar's thumb moves a
    little while a long file is first scrolled through.
  - A formula inside a paragraph that cannot be broken and is wider than the pane is cut off at
    the pane's edge (plus 1.5em), where the pane used to scroll sideways to it. A paragraph
    cannot scroll on its own without cutting off the name above a caret on its first line. Such
    a formula breaks after each plus or equals sign, so it takes one with no operator in it,
    which is rare. Another person's name above their caret in the first line of a table cell
    or figure may be cut off by that block's own scroll (not checked).
  - Measured on one machine, in headless Chromium only.

## Back and Forward ask before dropping what has not been saved

- **What was wrong.** With the web app answering and the sync service away (restarting, the line
  to it dropped, no network), the editor keeps what is typed and says it is waiting to be saved.
  Back or Forward to another page of the app then threw the editor away with the only copy, and
  asked nothing: the link guard hears clicks, and the browser's own prompt is not raised when
  the page is swapped in place. Shown in the real app: Back, Forward, the service back, and the
  file did not hold what had been typed.
- **Now** Back and Forward ask what a link asks ("What you typed in main.tex has not been saved
  yet… Leave anyway?") under the same rule (`atRisk`). Leaving goes where the browser was going.
  Staying keeps the page, its editor and the words, and puts the address and the history back.
- **How.** The browser has already moved when it says so, and cannot be refused; but the router
  has not yet acted. Listeners on the window are called in the order they were added, and the
  router adds its own when the page's scripts start, so a third constant script in
  `app/layout.tsx` (`WENT_FIRST`) listens from the moment the page is read and hands the event
  to the open editor (`wentTo` in `apps/web/lib/leaving.ts`). To stay, the editor keeps the event
  from the router and steps the history back by as many entries as the browser moved
  (`history.go`, the index from the Navigation API); in a browser without that API it puts the
  page after the one arrived at (`pushState` with the entry's own state). A listener added by
  the editor itself was tried first and is never called: the router has unmounted the editor by
  then.
- **Held by** `leaving.test.ts` and four tests in `recover.spec` (Back refused twice, then saved
  and allowed; Back agreed to; Forward; a browser without the Navigation API).
- **Not done.**
  - Back to a page that is not this app's document (another site, or an entry from before a
    reload) is the browser's own "Leave site?" prompt, as before.
  - Closing the tab offline still loses unsaved edits after the browser's prompt; keeping them
    on the device is an owner decision (Conventions).
  - Where the browser gives no index, staying after Forward leaves the file's page after the
    page that was ahead, instead of before it; and Chrome may skip an entry made without a
    press when Back is next used. Neither loses anything.
  - After steps within the page (a `#` link), a jump of several entries at once that is refused
    comes back to the file's page without the `#`.
  - Tried in headless Chromium only. Firefox and Safari call window listeners in the order
    added too (it is the standard's rule), but neither was run.

## A tar archive imports

- **What was wrong.** The `.tar.gz` arXiv gives and the archive a Git host gives were refused
  with "Unpack it and make a ZIP" (see "A real paper brought in").
- **Now** (`packages/server/src/archive.ts`; `apps/web/app/projects/page.tsx`,
  `apps/web/app/api/projects/import/route.ts`): `.tar.gz`, `.tgz` and `.tar` are imported
  directly, with no new dependency (`node:zlib` and a tar reader written here). What an archive is
  is told by its first bytes, never its name: gzip (`1f 8b`) or `ustar` at offset 257 is read as
  a tar, anything else as a ZIP. The page's file field, label and help say so, and the paper is
  named after the file without `.zip`, `.tar.gz`, `.tgz` or `.tar`. Who may import is unchanged
  (same origin, signed in, the upload taken once from `tmp/<userId>/`, the papers-per-hour limit;
  the importer is the sole owner).
- **One set of rules.** The per-entry rules and the `.bbl` and file-or-folder step at the end are
  one `Intake` that the ZIP and the tar readers both use, so a tar keeps and leaves out exactly
  what a ZIP does. The ZIP's behaviour is unchanged. Entries left out are never held: a tar is
  read from the inflated stream, 512 bytes at a time, and only the files a paper keeps are put
  together.
- **Read:** ustar headers (the `prefix` field only where the magic is POSIX, not GNU's), GNU long
  names (`L`), pax `path=` and `size=`; names go through the same NFC and `./` clean-up as a ZIP's.
  Folders, pax global headers and GNU long link names are passed over.
- **Refused, the whole archive, each with its own sentence ("This archive cannot be imported:
  ..."):**
  - the dialects that are not read: old V7 headers (no `ustar`), sparse files (type `S` and pax
    `GNU.sparse.*`), and sizes in base-256 (files over 8 GB). Multi-volume and other special
    types are refused too when named as a file of a paper;
  - a bad header checksum; an archive that ends before its last file or its end blocks do (a
    gzip cut short is the same);
  - a symbolic or hard link, or a device or pipe, whose name is of a type a paper keeps (one with
    a name that is left out is only listed or passed over);
  - an absolute name, one that starts with a drive letter (`C:`), or one with `..` in it (any
    entry, whatever its type), and a name that is not UTF-8; a pax `path` that is empty or has a
    NUL in it; a pax record whose length is not plain decimal digits (`0x10` is refused);
  - a GNU long name or pax header over `META_BYTES` (4 KB: a path of 255 characters is about 1 KB
    in UTF-8, and the records around it are short; it was 1 MB, enough for 598 headers to cost
    37 s of CPU);
  - the same file twice, and anything over `LIMITS` (files, entries, a file, the total, a path).
    Every header counts toward `entries`, the metadata ones (`L`, `x`, `g`, `K`) too. The reader
    gives way to the event loop every 256 headers, so a plain tar in one chunk cannot starve it.
- **A new limit, `LIMITS.inflatedBytes` (600 MB).** A ZIP passes over an entry it leaves out
  without reading it; a tar.gz has to inflate everything to get past it, so `totalBytes` (which
  holds only kept files) cannot stop a gzip bomb. The cap is twice `totalBytes`: room for the
  largest paper allowed and as much again of left-out files, headers and padding, and no more.
  The inflated stream is cut at the cap, so a bomb of zeros costs a chunk of memory, not the
  bomb.
- **A gzipped single file** (`paper.tex.gz`) is still refused, with its own sentence.
- **Held by** `archive.test.ts` (a tar.gz and a plain tar read as the same files zipped; `../`
  and `/`; links; 300-character paths by GNU `L` and by pax; a bad checksum; a cut-short archive;
  the refused dialects; a gzip bomb; `.git` counting only toward `entries`), the sandbox tests in
  `import.sandbox.test.ts` (an arXiv-shaped tar.gz; another person's key; a hostile tar makes no
  rows) and three browser tests in `import.spec.ts`. Tars in tests are built from bytes
  (`packages/server/src/tarbuild.ts`), never with the `tar` program.
- **Not done.**
  - The refusals above are of the archive, not the file: a tar written in a dialect that is
    refused has to be repacked (`tar --format=ustar`) by the person.
  - The words of other refusals that say "ZIP" (a paper with no main file, more than 50 papers,
    an upload over 100 MB) are the same for a tar.
  - `.tar.bz2`, `.tar.xz`, `.7z` and `.rar` are not read.

## The comparison shows the text of added and removed files

- **What was wrong.** A file a co-author added, or a restore took out, was listed as "Added" or
  "Removed" with no lines, so there was nothing to copy from the comparison a restore's note links to.
- **Now** `diffRevisions` gives an added file's lines as `+` (from the newer revision's digest) and a
  removed file's as `-` (from the older one's), by `wholeFile` in `textdiff.ts`, so `diffHunks` and the
  page take them as they take a changed file's. A last newline starts no line; an empty file has none
  and the page says "This file is empty."
- **Reading.** `store.size` is asked first and a file over 1 MB is not fetched (`tooLarge`, "too large
  to show here"). Text that is not editable (a picture, Latin-1) is `lines: null`, "not text that can
  be shown here". Size and fetch are both inside `mapLimit(READS)`. Changed files are read as before.
- **Caps.** 2,000 lines of one file (`FAR_EDITS`; `more: n` says how many are left) and 10,000 of all
  added and removed files together, spent in the order of their paths. Past either, the page links the
  ZIP of the one revision that holds the file, unless the file is held data (`held: true`: a ZIP leaves
  it out). Lines of held data are shown, as they already were for a changed one.
- **Deleted and made again at one path** (a new `file_id`) was two entries, "Removed" and "Added", with
  the same path: a duplicate React key and two regions of one name. It is now one "Changed" file,
  compared line by line like any; the same bytes again is no difference. Authorization is as before
  (`project.read`, each revision tied to the paper by `load`); no new route.
- **Held by** `textdiff.test.ts`, `revisions.sandbox.test.ts`, `batching.sandbox.test.ts` (twenty added
  files, at most `READS` fetches at once) and the comparison test in `revisions.spec.ts`.
- **Not done.**
  - A file deleted and made again as text on one side only is "Changed" with no lines.
  - A changed file's own "too much changed" sentence still links both ZIPs even for held data.

## A person's edits have a budget

Built from the security review's first open item: how often someone edits was not limited, and
one writer could send 2 MB edits without pause, each stored as a `file_updates` row while
compaction runs only every 500 edits.

- **The budget.** A token bucket for each signed-in person, in the sync server's memory
  (`editBudget` in `packages/server/src/limits.ts`): 20 MB at once, 2 MB a minute given back
  (`SYNC_EDIT_BURST_BYTES`, `SYNC_EDIT_BYTES_PER_MINUTE`). It is kept by the user ID in the
  ticket, so two files, or two tabs, share it, and nothing the client sends changes whose it is. A
  person who is back to a full budget is forgotten, so the map holds only people who edited
  lately. The sync server will not start with a burst below the largest edit.
- **What costs.** Each saved edit costs its size, or 512 bytes if that is more. Each structural
  edit asked for over the connection costs its size or 512 bytes, whichever is more: the
  replacement's length is charged before anything is done, and what the edit comes to beyond that
  is charged inside the transaction that appends it, which is undone if it is not there. Edits
  refused as too large are refused first and cost nothing. Only people who may write (by their
  role, not by whether the connection was since made read-only) are charged; the question "do
  you have all my changes?" and an empty edit are free. A connection closed for an edit it sent
  takes nothing more: edits and commands already queued on it are refused.
- **What the server does.** An edit over budget is not saved, not applied and not passed on. The
  connection is made read-only, so the library answers "not saved" and applies nothing, and is
  closed with the code 1013 and the reason `over-budget`. A structural edit over budget is
  answered with "Too many edits at once. Try again in a moment." and changes nothing. Both are
  counted as `paperweave_sync_edits_over_budget_total`.
- **What the editor does.** The status line says "Saving is paused for a moment: too many edits
  at once. Your edits are kept and will be saved." Nothing is discarded: the editor keeps what
  it has not sent and sends it when it connects again. The library does not connect again by
  itself after the server's close message (it leaves the socket open and the file unsynced),
  so the editor closes the socket and connects again after 10 seconds. The wait is there
  because an immediate connect sends the same edit and is refused again, and a loop of that
  would cost a ticket and a database look-up each time. The line goes when the server holds
  everything again.
- **Held by** `limits.test.ts` and the budget tests in `sync.sandbox.test.ts` (an edit over
  budget is refused and later saved with nothing lost, one person on two files has one budget, a
  structural edit over budget is answered with the error, and the metrics count it).
- **Not done.** The budget is not shared between sync servers (there is one) and starts afresh
  when the server restarts. Edits made by the web app's own requests are not counted.

## Restores and replaced files have a budget too

The sync budget did not count what the web app writes as edits itself, so alternating two
restores of a large paper got round it (`docs/security-review.md`, Open 1).

- **The budget.** `WEB_EDIT_BYTES_PER_USER_HOUR`, default 100 MB, summed for each person over all
  their papers for the last hour. Kept in the database (`web_edits`, migration 0036), because
  two web apps may run. A row keeps the person, the paper (left empty if the paper is deleted)
  and the bytes; nothing of the text.
- **What costs.** A restore or a replacement costs the bytes of edit it appends, at least 256 KB.
  The floor also applies to a restore that changes nothing and to a replaced picture or other
  file that is not text. `editLocked` now returns the bytes it appended. A replace that finds no
  file at the path adds a file and is not charged. A file uploaded to replace one
  (`addUploaded` with `replace`) goes through `replaceFile` and is charged.
- **How.** `mayRewrite` runs after the permission check and before any blob is read or stored,
  and refuses if even the floor no longer fits. `chargeRewrite` runs in the transaction, after
  the edits are appended (in `within` for a replace), under `pg_advisory_xact_lock` on the
  person, and deletes rows a day old. Over budget it throws `conflict`, "You have changed too
  much in the last hour. Try again in a little while.", and the transaction ends: no edits, no
  revision, no notice. A viewer or someone not on the paper is refused first and not charged.
  The budget is an optional last argument (`restoreRevision`, `replaceFile`, `addUploaded`) so
  tests can use a small one.
- **Held by** `limits.sandbox.test.ts` (sums per person, a charge 61 minutes old, two at once),
  `revisions.sandbox.test.ts` and `files.sandbox.test.ts`.
- **Not done.** Accepting and undoing proposals, renaming labels and renaming files also edit
  text from the web app and were not counted (done below). Imports are not counted. A refused
  request has already done its reading and, for a restore, its storing of edited text, before
  the charge; only the early check is free.

### Accepts, undos and renames are counted, and a rename is capped

- **A fault found.** `applySplices` appended its edit with no size check. A label can be renamed
  to 200 characters, so a file dense with `\ref{a}` could be taken past `MAX_FILE_TEXT` (50 MB)
  in one request. A sandbox test with a lowered limit (`renameLabel` and `applySplices` take
  an optional `maxText`) took a file from about 900 characters to about 20 000 under a limit of
  about 6 000, and failed on the old code. Now a file that would pass the limit refuses the whole
  rename with `invalid_input`, "That rename cannot be made: it would make a file too large.",
  and the transaction ends: no file is changed. A file renamed to a longer path is capped the
  same way.
- **What is counted now.** Accepting a proposal, undoing an accept, renaming a label, and
  renaming a file _with_ the lines that name it (the digest branch). The cost is the bytes
  appended, at least `WEB_EDIT_SMALL_FLOOR` (4 KB; 256 KB would have refused a bulk accept of
  about 380 in an hour of the 100 MB). It is charged to the person acting, not the proposal's
  author, in the transaction that made the edit, by `chargeRewrite` with the new `floor` option
  of `RewriteOpts`. `runCommand` now passes `appended` (the update's length) to `within`; the sync
  server passes no `within` and keeps its own budget.
- **Over budget.** `conflict` with the same sentence, and everything rolls back: the edit, the
  proposal's status, the file's name. `mayRewrite` runs first (after the permission check, and
  for a proposal after the free cases below), so a person with no room left for the smallest
  edit is refused before the file is read.
- **Free.** Accepting a proposal that is already accepted, undoing one that is open, an accept or
  undo that answers `conflict` (the edit was not made), a request refused for permission, a
  rename that only changes the name (no digest), and a rename with a digest that names no
  lines (no text is edited).
- **Held by** new cases in `proposals`, `labels`, `files` and `limits` sandbox tests. Fifty
  accepts in a row by one person took 630 ms (13 ms each), each charged the floor.
- **Still not counted.** Imports (ZIP and the like), creating or uploading a file that does not
  replace one, deleting, saving a revision, comments and proposals (limited separately by
  `mayWrite`). The budget is kept per person over all their papers.
