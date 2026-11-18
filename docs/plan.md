# PaperWeave: implementation plan (ponytail applied)

> **About the skill.** I read `skills/ponytail/SKILL.md` from `dietrichgebert/ponytail` and applied its rules here. Plan mode blocks installing anything, so the install is step 1 below. I will copy only that one skill file (with its MIT notice) into `.claude/skills/ponytail/` in this repo, so every later Claude session on PaperWeave loads it. I have not reviewed the plugin's hooks, so I am not installing the full plugin; you can do that yourself with `/plugin marketplace add DietrichGebert/ponytail` then `/plugin install ponytail@ponytail`.

## Context

The spec describes a collaborative LaTeX workspace: visual editor over LaTeX source, source editor, PDF preview, live co-editing, review threads and proposed edits, sandboxed builds, CSV charts, grammar and evidence-linked scientific critique. Beta succeeds when a team can import a project, co-author it, and ship a ZIP and PDF from the same revision.

The repo is empty. You chose: work is done mostly by Claude sessions, and this session builds the scaffold plus the Phase B editor spike that the spec uses as its go/no-go gate.

## What ponytail removed

Engineering only. Every spec feature, security boundary and accessibility item is still in the work plan.

| Removed | Now |
|---|---|
| Queue wrapper interface | pg-boss called directly |
| Model provider interface | Anthropic SDK called directly |
| Two blob store implementations | One S3 client; an S3-compatible container in dev |
| Query builder and migration library | `pg` with numbered `.sql` files and a short runner script |
| Turborepo and package-boundary lint rules | Plain pnpm workspaces |
| Property-testing library | Seeded random loops that print the failing seed |
| Separate throwaway spike app | A `/spike` page inside the real web app |
| Per-file epoch and reserved organisation ID "for later" | Dropped until something needs them |
| Custom sync server by default | Hocuspocus if it can save before acknowledging; a small custom server only if it cannot |
| ADR folder and conventions docs | One gate report and one `docs/status.md` hand-off file |

## What I need from you

1. **Capture a Prism export before 1 January 2027.** The spec says Prism retires then. I cannot operate accounts on Prism, Overleaf or Grammarly, so the Phase A replays are yours; I supply the synthetic files, a checklist and the results matrix.
2. **A base branch.** The remote has none and I may only push `claude/blissful-mendel-unz9kz`. Unless you object, I push one bootstrap commit (README, `.gitignore`) to `main` so a draft PR has a target.
3. **Decisions, none blocking this session:**
   - Tracked changes are stored beside the source, not inside it, so the PDF never shows pending proposals. Confirm before Phase E.
   - Model retention defaults. Model processing stays off until you confirm.
   - Hosting, which fixes the production build sandbox.
   - Who builds the human-reviewed corpus and the challenge set.
   - Whether replaying competitor products is cleared against their terms.

## Design in brief

**Layout.** Three apps, three packages.

```
apps/web        Next.js UI and HTTP API (route handlers)
apps/sync       WebSocket sync server
apps/workers    compile, import, chart, assist; one entrypoint each, deployable separately
packages/latex     lossless parser, include graph, label/citation/BibTeX indexes
packages/bridge    LaTeX tree to visual document, and visual edits back to source
packages/server    SQL, blob store, roles, write path, revisions, message schemas
fixtures/  tests/  infra/  docs/
```

**Tools.** pnpm workspaces, TypeScript, Vitest, Playwright, ESLint and Prettier, PostgreSQL through `pg`, pg-boss, S3, Zod at every trust boundary, a maintained auth library for email magic links, the Anthropic SDK, GitHub Actions. Everything else is the stack the spec already names.

**Editing LaTeX visually.**

- The LaTeX text in Yjs is the only source of truth. The visual document is derived from it and never saved.
- The parser is hand-written and lossless: the tree's text always equals the file, even for broken LaTeX. No existing parser keeps whitespace exactly.
- The bridge never regenerates LaTeX. Each visual edit is a small splice at known offsets, checked against the text it expects, so untouched bytes cannot change.
- Typing merges through Yjs like source typing. Structural edits (toggle a style, change a heading, accept a suggestion) go through a server command that is rejected if the text has moved.
- Anything outside the supported subset is a raw block with an "edit in source" action and a compiled preview. Broken LaTeX freezes only its own region.
- Files keep their original bytes until edited. Newline style and BOM are recorded and reapplied on export. Non-UTF-8 files stay read-only.

**Syncing and saving.**

- One Yjs document per file. The server saves each update to Postgres, then acknowledges, then broadcasts.
- Role is checked on every update, so revoking access stops writes immediately. Reviewers can comment and propose but not write.
- A revision is a consistent cut of all files, stored as immutable blobs. Builds and exports read only revisions.
- Restore creates a new forward revision. A client with unsynced edits is offered them back.

## Work plan

Each item is one or two PRs with the exit test shown.

### This session

| # | Work | Passes when |
|---|---|---|
| 1 | Install the ponytail skill into `.claude/skills/`. Scaffold, CI, spec and plan in `docs/`. Fixtures written in-repo: article, IEEE and AMS multi-file papers with custom macros, comments and bibliography variants, plus encoding variants. | Lint, typecheck and tests green locally and in CI |
| 2 | Parser: lossless tree, blocks, incremental reparse, error recovery, include graph | Tree text equals source on every fixture and on random input; incremental matches full parse |
| 3 | Bridge: projection, typing edits, one command edit, remote updates, freeze and recover, selection mapping, undo | A visual edit changes only its intended bytes; random races between a visual and a source edit converge |
| 4 | `/spike` page: both editors on one document, two simulated users | Browser test: type visually, race a source edit, break and repair LaTeX, switch modes, IME input |
| 5 | Compile entrypoint (no network, no shell escape, limits, diagnostics, SyncTeX) and the gate report | Fixtures compile; escape probes fail; report written |

**Go/no-go gate**

| Gate | Pass | If it fails |
|---|---|---|
| Lossless | Tree text equals source everywhere | Stop and fix the parser |
| Byte-safe | Unedited export is identical; 10,000 generated edits stay in range | Stop; a CodeMirror-based visual mode is the fallback and needs your sign-off |
| Race-safe | 10,000 interleavings converge with nothing lost | Visual editing limited to typing; structure in source mode |
| Recovers | A broken brace freezes only its region and recovers on repair | Freeze the whole file for beta |
| Useful | At least 70% of body prose is visually editable; edits feel instant on a 150 KB file | Publish a narrower template list |

### Phase A: reference behaviour (yours, in parallel)

The six replays from spec §9, recorded in `docs/rea/matrix.md` as observation, design decision and acceptance test, marked observed or docs-derived. Prism first.

### Phase C: collaboration foundation

C1 to C5 at single-user depth give the first end-to-end slice: import, edit, build, export. A second session can start them while the spike runs.

| # | Work | Passes when |
|---|---|---|
| C1 | Database, blob store, sign-in, invitations, owner/editor/reviewer/viewer roles, one `authorize()` used everywhere | Every role tested against every action; cross-project access denied |
| C2 | Import: ZIP safety limits, encoding and root detection, compiler profile, import report (what is visual, what is source-only), archive inventory for Overleaf and Prism ZIPs | Hostile ZIPs rejected; fixtures re-export byte-identical |
| C3 | Sync server (Hocuspocus check first), presence, offline queue with an unsynced-edits indicator, source editor and file tree in the app | Three users converge; killing the server mid-save loses nothing acknowledged; revoked user cannot write |
| C4 | Build service: queue, sandbox, cache, auto-build coalescing, quotas, diagnostics, PDF view with last good PDF and its revision shown | Cache hit and miss tests; another project's PDF or log cannot be fetched |
| C5 | Revisions: cut, name, diff, restore, rename that keeps file IDs; export ZIP, PDF and optional toolchain manifest | ZIP and PDF share a revision; the ZIP rebuilds outside the app to a matching PDF |
| C6 | Command path for structural edits, plus log compaction | Stale command rejected with current text; retry applies once; reconnect after compaction converges |
| C7 | Visual editor in the app, with mode switching that keeps the selection | Visual edit against a concurrent source edit through the real server |
| C8 | Fault suite and monitoring (queue age, build failures, rejected writes, reconnects) | Zero lost acknowledged updates across disconnect, duplicate, restart, revocation and restore |

### Phase D: scientific content

| # | Work | Passes when |
|---|---|---|
| D1 | Maths and cross-references: instant rendering, numbered equations, numbering from the compiled revision, label index, insert by toolbar, keyboard and context menu, rename with proposed reference updates | Numbers match the PDF; rename updates every reference |
| D2 | Bibliography: BibTeX and Biber, key index, missing and duplicate keys, citation insert, DOI lookup with source and time, separate statuses for metadata and claim evidence | The `.bib` file is byte-identical after indexing; bad keys flagged |
| D3 | Figures and tables: assets, captions, alt text, simple table editing | A cell edit changes only that cell's bytes |
| D4 | Data and charts: CSV with approved schema and missing-value rules, Vega-Lite scatter, line and bar, rendered to PDF and PNG, staleness tracking, opt-in dataset export | Quoted delimiters, units and gaps handled; changing data marks the chart stale |
| D5 | Submission: SyncTeX navigation both ways, templates, pre-submit checks, published import matrix | Checks catch a missing asset, undefined label, unresolved citation, warning and stale chart |

### Phase E: review and AI

E3 and E4 need only the parser, so they can start after step 2.

| # | Work | Passes when |
|---|---|---|
| E1 | Threads: anchored comments, replies, mentions, resolve | Deleting the anchored text detaches the thread and keeps its context |
| E2 | Proposed edits and tracked changes: accept, reject, edit, dismiss, undo an accept, stale flag, revision diff view | Reviewer can propose but not write; a proposal on changed text is flagged stale |
| E3 | Grammar: inline spelling and grammar, UK/US, glossary, rule suppressions, engine chosen by benchmark | No finding lands inside an equation, unit, code, path or citation |
| E4 | Scientific critique: the Review action, suggestions with diff, reasoning, evidence and changed-claim flags, a review question when evidence is thin, per-project off switch, minimal text sent, versions recorded | Zero unflagged changes to quantities, causation, negation or attribution on the challenge set; a disabled project sends nothing |
| E5 | Review metadata export, import of review data found in archives with a report of what is missing | Export round-trips threads and proposals |

### Phase F: beta

Accessibility (keyboard, screen reader, IME, colour-independent status), performance benchmarks, a real restore drill, product metrics (imports and exports per template, two-author activation, useful-suggestion rate), onboarding, security review, and the Tectonic comparison.

### Always

Authorization tests with every new endpoint. Logs carry IDs and counts, never manuscript text. `docs/status.md` updated in every PR so the next session knows where to start.

## Verification for this session

1. `pnpm install && pnpm lint && pnpm typecheck && pnpm test` from a clean clone.
2. The parser, byte-range and race suites, with the seed of any failure printed.
3. A browser run of the `/spike` page with screenshots.
4. Fixture compilation and the two escape probes.
5. Measured results in `docs/phase-b-gate.md`; anything not run is listed with the reason.

## Git

Commits per step on `claude/blissful-mendel-unz9kz`, pushed, with a draft PR against `main`.

## Skipped and risks

- Not checked here: Safari, Firefox and real Japanese or Chinese IMEs (only Chromium is available), and whether containers run in this session. If they do not, compilation uses a local TeX Live and the pinned image runs in CI.
- Risk: seeded random tests do not shrink failures the way a property-testing library would, so a race failure may take longer to reduce. Dropping the per-file epoch means a corrupted Yjs document would need a manual fix until something like it is added.
