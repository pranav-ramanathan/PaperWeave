# Status

Read this first. Update it in every pull request.

## Done

- **Scaffold.** pnpm workspace, TypeScript, ESLint, Prettier, Vitest, Playwright, CI.
- **Fixtures.** `fixtures/`: article, IEEE and AMS multi-file papers, encoding variants, a
  shell-escape probe. `fixtures/digests.json` pins their bytes; run `node fixtures/digest.mjs`
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
- **C7: the visual editor in the app.** A .tex file opens in the visual view, with a switch to
  the source view. Both are views of the same text (`FileEditor.tsx`, `apps/web/lib/visual.ts`,
  which `/spike` now shares).
  - Switching views carries the selection across. Undo is one history per person for both views.
  - Emphasis is a structural edit. The editor asks the sync server over its live connection; the
    server runs `runCommand`, answers the author with the edit, and only then sends it to
    everyone. The author applies the answer as their own edit, so it is an undo step of theirs.
    C6's HTTP route could not guarantee that order (the broadcast sometimes won, and Undo then
    took back the wrong thing), so it was removed.
  - Found and fixed on the way: after a file's text first arrived, the visual editor's selection
    was the whole document, and keys pressed before the first click registered were refused.
  - Not built: other people's carets in the visual view (the source view has them), structural
    edits other than emphasis, and remembering which view a person last used.
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
  - Restores replace whole lines. An edit made offline before a restore is merged in at an edge
    of the replaced part, and used to be able to land in the middle of a line.
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
  - "Rename only" is offered too, and says the paper will not build until the lines are fixed.
  - Not handled: moving the root file to another folder, which changes what every relative
    path in the paper means.
- **D1, fourth part: editing a formula in place.** A double click on a formula in the visual
  view, or Enter when it is selected, opens its LaTeX with a preview that follows what is typed.
  - Apply goes through the server (`Bridge.atomCommand`, then `runCommand`). What the formula
    said when it was opened is what the server must find: a formula someone else changed
    meanwhile is not overwritten, and the person is told. The edit can be undone.
  - The preview draws the paper's own macros: `\newcommand` and relatives, plain `\def`, and
    `\DeclareMathOperator`, read from the root file's preamble and the files it reads
    (`macroDefs`, `paperMacros`). So does the visual view itself.
  - Macros are read when the page loads. A macro defined since shows after a reload.
  - A formula the browser cannot draw can still be applied: the PDF is what decides.
- **D1, fifth part: inserting references and equations.** In the visual view, three ways each:
  the toolbar ("Reference", "Equation"), the keyboard (Alt+R, Alt+=), and a menu at a place in
  the text (right click, or the menu key). With that, D1 is done.
  - A reference is chosen from the paper's labels, each shown with its number in the PDF and
    its file; typing narrows the list. A label that starts `eq:` is inserted as `\eqref`.
  - An equation goes in the line (`$...$`) or on a line of its own, numbered
    (`\begin{equation}`), with a preview as it is typed.
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
  - Text that would break the grid (an unescaped `&`, a row break, a `%`) is refused.
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
  - Not yet: editing or deleting a comment.
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
  - Not yet: accepting several at once; a word-by-word diff inside a proposal (it shows the old
    and the new text whole).
- **E3: spelling and grammar.** A "Spelling and grammar" panel under the editor of a LaTeX
  file, and a wavy line under each finding in both views. Checked when the file opens and again
  once what was typed is saved and has been left alone for a moment.
  - The engine is LanguageTool 6.8, run by us (`grammar` in `infra/compose.yaml`, `GRAMMAR_URL`).
    No text goes to anyone else's service. Without `GRAMMAR_URL` the panel says checking is not
    set up, and everything else works.
  - `packages/latex/src/prose.ts` turns a file into prose plus markup: running text is sent as
    text; formulas, references, citations, commands, code (`\texttt`, listings), comments and
    the preamble are sent as markup with a stand-in ("Dummy", "[1]") so that the sentence still
    reads. The checker answers in source positions.
  - A finding is shown only if all of it lies in prose (`inProse`). So none is ever in a
    formula, a unit, code, a path or a citation; a service test seeds the same misspelling in
    each of those and holds that.
  - A suggestion is one click: someone who may edit makes the change through the command path
    (so it is refused if the text has moved, and is theirs to undo); a reviewer's click makes a
    proposed change instead.
  - Per paper (migration 0016, "Language" on the paper's page): British or American spelling,
    the paper's own words (not reported as misspelt), and rules switched off. A finding offers
    "It is a word of this paper" or "Do not check this in this paper".
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
  - Not counted: spelling suggestions taken with one click by someone who may edit (they are
    edits, not proposals). Dashboards and alerts are still the owner's to choose.
- **F1: accessibility.** `docs/accessibility.md` says what is held by tests, what was found and
  fixed, and what nobody has checked (a real screen reader is the largest gap).
  - `tests/e2e/a11y.spec.ts`: an automated audit (axe, WCAG 2.1 A and AA) of seven pages
    including the editor in both views with everything showing, and one flow done with the
    keyboard alone.
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
    what did not, with the reason. Review data that cannot be read is reported and never stops
    the paper itself coming in.
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
   Chromium and real input methods (`docs/accessibility.md`); losing the object store
   (`docs/restore-drill.md`); real manuscripts for the grammar benchmark and the claim
   challenge set, which are synthetic today.
4. **The Phase A replays**, which need a person with accounts: `docs/rea/matrix.md`. The Prism
   one is optional: its export was researched from public sources (`docs/rea/prism.md`) and is
   a plain LaTeX ZIP with no comments or history, so it imports like any other ZIP.

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
- **Not limited:** how many files a paper holds, and how often someone edits. A member can
  still grow the log by adding and deleting. Those are the review's "limits in general".

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
  would be worth reporting to the library's authors; that has not been done.

A second failure of the fault suite, found while looking, was the suite's own mistake: it
recorded what a saved revision held from the text a moment before saving, and an edit still
on its way in could land between. The revision was right and the record wrong. The suite now
reads what the revision holds from the revision. One seed failed every time before this and
passes now.

When the suite fails with people apart, it now says who lacks what and who alone has what.

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

## A paper's size, and what a sync ticket opens

Two more of the security review's items.

- **A paper's added files** are held to what an imported paper already was: 2,000 files and
  300 MB in all (`LIMITS` in `packages/server/src/archive.ts`). The count was already checked
  when a file was added; the total was not. Sizes are those of files as they were added.
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
  keep the plain policy in `next.config.ts`. `docs/security-review.md` says why.
- `apps/web/app/not-found.tsx` is the app's own page for an address that leads nowhere or a
  paper that is not the person's to see. The framework's own page brings an inline style sheet.
- In development the policy also allows `eval`, which React uses there to show server errors.

## Browser tests that failed once in a while

Four browser tests failed once or twice in a full run and passed when run again. Two faults
in the editor were behind them. Both are fixed, and each has a test that fails without its fix.

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

- When a browser test fails in CI, the run now keeps `test-results/` for a week as an
  artifact named `browser-test-results`: for each failed test, what its page showed.
- **Keep the whole output of a full run.** One failure was lost to a filter that kept only the
  line saying it had failed. The explanation came from the first failure whose output was kept.
- Failures only in full runs, never alone, were a matter of timing: a step landing in one
  particular instant. More runs of the test alone would not have found it; tracing what the
  page did on the wire did.
- Locally, the database logs lock waits and statements over 150 ms. That is a setting of the
  local container (`alter system`), not of the repository.

## Decisions waiting on the owner

See "What I need from you" in `docs/plan.md`. None blocks C1.

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
- Names shown for other people in a file come from each client and are not verified.
- Commands asked for over the live connection reach other editors through the one sync server
  that ran them. Running more than one sync server needs that delivery to go through Postgres.
- A resent edit can be stored twice. That is harmless to the text and goes at the next compaction.
- The editor says "Offline" as soon as the browser does. It does not wait for the socket, which
  can take many seconds to notice.
- Sign-in is rate-limited per client address, read from `X-Forwarded-For`. In production the app
  must sit behind a proxy that sets that header itself, or the limit can be dodged. Browser tests
  give each simulated person their own address the same way.
- The web app reads its settings from `apps/web/.env.local` (copy `.env.example`). Email goes to
  the local mail catcher at http://localhost:8025; browser tests read sign-in links from it.
- The ponytail skill in `.claude/skills/` applies to all work here: the smallest complete change.
