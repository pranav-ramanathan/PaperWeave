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
- **Seen there and left as it is.** After a restore to a revision whose data is older than
  the chart's last drawing, the chart says "out of date" although the files that came back
  are of that older data, and it cannot be drawn again until the data is described again. The
  record of what a chart was drawn from is one row, not one for each revision. It errs towards
  asking a person to look.

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
- **Not covered:** a sign-in that runs out is not deleted, so nothing is told. Its editors
  keep their connections until they drop, and then find themselves signed out. The sync
  server checks a person's role on every edit, not whether they are still signed in.

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
- **Now** a file dropped anywhere but on a field for choosing one is refused (`Dropped` in
  `apps/web/app/Dropped.tsx`, in the root layout); the visual and source views say where
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
  without the line that loads it. Biber's errors are not read. The lists are not links to the
  lines. BibTeX's own words are not in the build log a person can open.
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
- **Not changed:** a thread on more than 500
  characters comes back on its first 500. The compiler is the one the importer read from the
  files, which the root may not decide. A review file at the top of an archive of several papers
  is given to none. There is no limit on how many comments a thread may have, and sign-in takes
  an address longer than the 320 characters an export keeps. No browser test makes the round
  trip; the page's sentences are not under test.
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

| Renamed                                                                           | Before                                                                                                             | Now                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| A section; a `.bib` in a list; a picture there as `.pdf` and `.png`               | the lines that name it follow; it builds                                                                           | the same                                                          |
| The paper's own `.sty`, `.cls` or `.bst`; a listing; an included PDF; a data file | **renamed at once, nothing said; the build broke**                                                                 | the page says it sees no line naming it, and what to check, first |
| A picture found through `\graphicspath{{figures/}}`                               | **not followed; the build broke**; called "not in the project" before any rename, and not shown in the visual view | followed; found; shown                                            |
| The root file into a folder                                                       | **never built, nothing said why**                                                                                  | builds ("A paper whose root file is in a folder")                 |
| A picture named `"my plot"`; `\input {a}`; `\input a`                             | **not followed; the build broke**                                                                                  | the same (below)                                                  |
| A label used by `\ref`, `\cref` (lists, spaces, line breaks), `\ref*`             | followed; `sec:ab` untouched; labels in comments and listings untouched                                            | the same                                                          |
| A label used by `\hyperref[…]`, `\fref`, `\Fref`, `\zcref`                        | **left behind; "up to date", with ?? in the PDF**                                                                  | followed; and a reference to nothing by `\hyperref` is listed     |

- **What was wrong.** A rename that found no line went through at once: the page asked only when
  it had lines to show, and a file named in a way it does not read was renamed without a word.
  The folders `\graphicspath` names were not looked in. Four ways of referring to a label were not
  read, and the build pane's list of what shows as ?? did not know the warning hyperref gives.
- **Now** every rename of a file shows what would change first, and when it sees no line naming
  the file it says that a package, class, bibliography style, listing or data file can be named
  in ways it does not read, and to check the paper still builds (`renameAction`, the rename
  page). `\graphicspath` is read wherever pictures are found and named
  (`graphicsPaths`, `resolveVia` in `packages/latex/src/graph.ts`; `renamePlan`, `picture` in
  `packages/server/src/files.ts`). `\hyperref[…]`, `\fref`, `\Fref`, `\zcref` and `\zcpageref` are
  read as references, by the rename and by the paper's list of references.
- **Held by** unit tests (`graph.test.ts`, `labels.test.ts`), service tests (a picture renamed
  under `\graphicspath`, then built; a label renamed through each new form) and browser tests
  (the sentence shown before renaming a style file; a `\hyperref` to nothing listed), each failed
  on the old code.
- **Not changed:** the ways of naming a file still not read: `\usepackage`, `\documentclass`,
  `\bibliographystyle`, `\lstinputlisting`, `\includepdf`, the data of a plot, a name in quotes, and
  `\input` with a space or without braces; what the paper's own `.sty` and `.cls` files name.
  Lines inside `verbatim`, and after `\\%`, are changed with the rest. A label made by a command
  of the paper's own with a parameter is not seen, so a reference to it is listed as to nothing,
  and renaming another label to its name is not refused. The list of pictures offered for
  insertion still names them from the root's folder, which builds.
- **How it was made.** Planned by one agent, probed and written by others, checked here.

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

### A sync test that failed once and is not explained

- On 19 November, in one of eight runs of the whole service suite that day, "what someone
  typed as they left reaches whoever opens the file next" failed at its first step: a client
  of the second server that test starts had still not connected after fifteen seconds
  ("socket connecting, closed 0 times, refused false"). Six runs of that file alone and five
  more of the whole suite then passed, and so did CI.
- Tried again with every processor kept busy: fourteen runs of that file, none failed.
- It first happened on the day the server's database connections were reworked (see "When the
  database is lost for a while"), so that change is not cleared. Nothing connecting the two
  was found: the ports the test files can pick do not overlap each other or the local
  services, and the test before it stops its server.
- The message is the one a client gives when nothing is listening at its address, which was
  checked by pointing one at an empty port. The test's failure message now also says whether
  anything accepts connections there, so the next one will say whether the server was up.
  On the machine this was run on, only the database listens anywhere in the range these
  tests take their ports from, and it is outside what this test can pick.

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

## Decisions waiting on the owner

See "What I need from you" in `docs/plan.md`. None blocks C1.

One more, found since:

- **How long to keep what builds make.** Every build's PDF, log and SyncTeX file is kept for
  ever, and so is every automatic revision. See "What a paper keeps for ever" above for how
  fast that adds up. The PDFs of old automatic revisions can be made again, so dropping them
  loses nothing a person wrote; nothing does so today.

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
