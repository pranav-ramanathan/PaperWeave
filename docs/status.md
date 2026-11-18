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

Phase C (C1 to C8) is done. C1 to C5 complete the first end-to-end slice: import a ZIP or start from
nothing, edit it together, build it, and download a ZIP and a PDF that belong to the same revision.

Next, in this order:

1. **D5.** Submission: SyncTeX navigation both ways, templates, pre-submit checks (missing
   asset, undefined label, unresolved citation, compiler warning, out-of-date chart), and the
   published import matrix.
2. **Phase E** onward, as in the plan.

The Phase A replays are waiting on a person with accounts: `docs/rea/matrix.md`. The Prism one is
optional: its export was researched from public sources (`docs/rea/prism.md`) and is a plain LaTeX
ZIP with no comments or history, so C2 imports it like any other ZIP.

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
