# Academic writing workspace
## Implementation specification · 16 November 2026

### 1. Product and release boundary

Build a workspace for small research teams to draft, review and submit a paper together. Authors can write in a visual editor with Grammarly-style feedback, switch to LaTeX source and inspect the compiled PDF. Reviewers can see the evidence behind a proposed scientific edit and whether it changes the strength of a claim. Editors can use equations, citations, figures, tables and data without interrupting their writing flow.

The release target is one corresponding author and 2–10 collaborators working on a real multifile manuscript. Support desktop web and English academic prose with UK/US spelling. Success means importing a supported project, co-authoring it, and shipping a submission ZIP and a PDF from the same revision. Track successful imports/exports per template, two-author activation, and the rate of useful suggestions that preserve meaning.

| Ship in private beta | Follow after beta |
|---|---|
| Visual, source and PDF views. File tree, project ZIP import/export and compile diagnostics. | Broader visual template coverage, Word interoperability, mobile editing, Git sync. |
| Live co-editing, presence, inline threads, proposed changes, revision diff and restore. | SSO, institutional policies, section approvals and enterprise deployment. |
| Equations, BibTeX, labels, references, figures, tables and CSV-backed charts. | Live Zotero sync, notebooks and supplementary artifact publishing. |
| Grammar, clarity and evidence-linked scientific critique. | Opt-in literature discovery, journal-specific packs and multilingual checks. |

### 2. Research and product decisions

| Reference | Documented capabilities | Design consequence |
|---|---|---|
| Prism | LaTeX-native scientific collaboration, manuscript-aware AI, equations, figures, citations and in-place edits. OpenAI announces retirement on 1 January 2027. Its migration guide distinguishes exported project files from collaboration state. | Offer straight ZIP import with a preview of what the archive contains. Import the review data present in the archive and report missing history/comments. Store review activity created in the new workspace and offer a separate export. |
| Overleaf | Visual/source editing, live collaboration, tracked changes, history, grammar, project-aware AI, rewrites, equation/table generation and citation review. Its dedicated unsupported-statement scan can find publications via Dimensions. | These are baseline capabilities. Compete on meaning-preserving edits, review control and verifiable exports. |
| Grammarly | Inline grammar, clarity and tone feedback, paragraph rewrites, and style guidance. | Carry over quick in-context review, explanations and actionable diffs. Introduce scientific categories for claim strength, uncertainty, attribution and terminology. |

REA was exercised against the public Overleaf visual-editor documentation with no credentials or network-body collection. The navigation completed, but the accessibility capture returned only the document root. Evidence ID ev_8afec4f7c120fd28bb493d03229838903dbf0571fbd0b36cb49efa43301b735c. The comparison above is documentation-backed. Live product parity and private architecture are unverified.

### 3. Author workflows

1. **Import.** Upload a ZIP or use a supported template. Identify the root file, report file/encoding issues, select a compiler profile and build. Report which regions can be edited visually and what requires source mode. For Prism, summarise what the uploaded archive contains.
2. **Draft.** Open visual + PDF or source + PDF. Preserve selection across modes through source maps where feasible. Insert numbered maths, references, citations and figures via toolbar, keyboard and contextual commands. Allow selection-based source/PDF navigation when SyncTeX supports it.
3. **Improve.** Show spelling and grammatical findings inline. An explicit Review action suggests clearer contributions, tighter argument structure or better-calibrated conclusions. Each suggestion shows its diff, reasoning, relevant evidence and changed-claim flags. Provide accept, reject, edit and dismiss actions.
4. **Collaborate.** Invite a co-author, share cursor presence, start an anchored thread and mention a teammate. Propose a tracked change, reply, resolve and restore earlier work as a new revision. Display stale suggestions, unsynced edits and the revision behind the preview.
5. **Submit.** Check missing assets, undefined labels, unresolved citations, compiler warnings and stale charts. Download the submission ZIP, PDF and optional toolchain manifest. Offer an explicit export of review metadata.

### 4. Architecture

| Area | Initial decision |
|---|---|
| Client | React/Next.js, Tiptap/ProseMirror visual projection, CodeMirror 6 source editor, KaTeX inline math and PDF.js preview. Parse in a worker with incremental invalidation. |
| Authority | Versioned source files with Y.Text for collaborative buffers. Visual transactions become minimal source patches. The visual document is a projection. A second editable canonical document would make synchronization and arbitrary LaTeX round-tripping brittle. |
| Realtime | TypeScript WebSocket sync and awareness. Assess Hocuspocus against durable acknowledgements and per-update role checks. Persist updates and revision metadata in PostgreSQL. |
| Storage | PostgreSQL for roles, manifests, revisions, review state, updates and jobs. Object storage for archive bytes, snapshots, datasets, figures and build outputs. Start with a durable Postgres-backed queue. |
| Build | Pinned TeX Live and latexmk images with BibTeX/Biber profiles and SyncTeX support. Compare Tectonic using the same fixtures after the baseline. |
| Workers | Independently deployable compilation, document import, chart rendering and writing-assistance workers. Use server-side policy and tenant-scoped access. |

The hardest engineering decision is preserving existing LaTeX source while enabling rich editing. Prove the bridge on an IEEE/AMS or equivalent multifile paper before committing to broad visual coverage.

### 5. LaTeX compatibility contract

- Parse a documented subset into lossless tokens and source spans. Support sections, paragraphs, inline styling, lists, common maths, references, citations and simple figures/tables first. Preserve comments, indentation, raw unknown constructs, labels, macro definitions and file boundaries.
- Keep uploaded bytes for untouched files, including unsupported encodings. Initially edit UTF-8/ASCII and preserve existing newline style. For edited files, preserve bytes outside authorised patches where possible and verify this property on fixtures.
- Map visual nodes to file ID, anchored range and parse generation. A visual action emits a minimal patch with stale-text preconditions. Unsupported material becomes a raw LaTeX block with a direct source-edit action. Show a compile view for custom macro rendering.
- Invalid source remains editable. Freeze the affected visual region, keep the last valid projection for orientation and explain how to recover. Resume once parsing succeeds. Preserve unaffected regions where the boundary is reliable.
- Build a project include graph and stable indexes for labels, citation keys and assets. Report missing paths and cycles. Treat dynamic includes as source-only. Rename requests show proposed reference updates and keep file IDs stable.
- Overleaf ZIP and Prism ZIP imports enter the same pipeline. Publish supported document classes and constructs from real fixtures. A ZIP that compiles may still contain source-only regions. Rich Word conversion has a separate compatibility contract, especially for OMML equations and custom LaTeX.

### 6. Collaboration, storage and API contracts

| Entity | Required fields and invariant |
|---|---|
| Project manifest | Project ID, ACL, manifest version, file IDs and paths, root file, compiler profile and immutable asset digests. File IDs survive rename. |
| Text update | Project/file ID, dedupe ID, author, durable log sequence and CRDT bytes. Persist before acknowledging. |
| Revision | A consistent manifest version, asset digests and per-file acknowledged checkpoints. Build/export always use this immutable view. |
| Anchor and thread | Yjs relative start/end positions, boundary affinity, excerpt, fingerprint and state. Deleted targets become detached and retain context for re-anchoring. |
| Proposed edit | Origin, author, base revision, anchor, expected source hash, patch, reason, claim-change tags, evidence, status and optional model/rule version. |
| Build | Revision, profile/image digest, cache key, status, logs, PDF and SyncTeX object IDs. Cache keys include every input that can affect output. |
| Dataset and figure | Raw CSV digest, schema, units, missing-value rules and attribution. Chart stores dataset version, declarative transform/render spec, generator version and generated asset digest. |

Ordinary source typing merges through Yjs. A visual correction, tracked edit or suggestion uses a command with file ID, anchors, expected text hash, replacement and idempotency key. The server serializes all durable writes per file, resolves against the latest state, checks role and preconditions and commits the CRDT update before acknowledging. Reject a stale change as a conflict and offer review against current text. Broadcast after durability. Avoid sharing a local undo stack across users. Make accepted suggestions reversible.

Use optimistic visual previews with explicit rollback and reparse on conflict. Coordinate multi-file operations against a manifest version and publish atomic revision visibility. On rename, preserve file-specific streams. On restore, create a new forward revision and require open clients to rebase or explicitly recover unsynced changes. Snapshot compaction must retain sufficient state and dedupe metadata for reconnection and retries.

Use owner/editor/reviewer/viewer roles. Check ACLs on every project/file operation and stop writes after role revocation. Reviewers can comment and propose changes without permissions to edit the manuscript directly. API entry points cover import, roles and invitations, revisions, builds, export, comments, proposed edit application and datasets. Return clear permission, stale-version and invalid-input errors. Live presence is ephemeral.

### 7. Academic objects and writing assistance

- **Mathematics.** Keep equation LaTeX editable, render common expressions immediately, and tie displayed numbering to the compiled revision. Protect equations, units, code, paths and citation commands from automatic rewrite spans.
- **Bibliography.** Preserve BibTeX source while indexing entries by stable key. Detect missing and duplicate keys. An explicit DOI lookup records source and time. Verified bibliographic metadata and evidence supporting a particular claim have separate statuses.
- **Data and figures.** Import CSV with an author-approved schema and missing-value policy. Use declarative Vega-Lite for basic scatter, line and bar charts. Render PDF/PNG assets in a worker and track chart staleness when data changes. Include caption, alt text, units, transform history and exact dataset version. Let authors opt into including datasets in exported archives.
- **Grammar.** Evaluate self-hosted LanguageTool or an equivalent engine on a labelled academic corpus. Check stable paragraphs with debounce. Map prose offsets back to source anchors and ignore protected spans. Support UK/US spelling, an editable glossary and rule suppressions.
- **Scientific impact.** Start with contribution clarity, evidence alignment, paragraph cohesion and appropriately qualified conclusions. Supply the model with relevant manuscript spans, project glossary, approved figure captions and selected evidence from a specific revision. Require structured proposals with exact text diffs, explanations and evidence references. Compare numerals, units, direction, negation, hedges, citation keys and named entities before display. Flag changed novelty, causality, significance or scope. If the selected evidence is insufficient, pose a review question. Every rewrite requires explicit acceptance.
- **Controls.** Owners can disable model processing per project. Send the smallest relevant text, enforce tenant scope before retrieval and exclude private datasets unless explicitly selected. Record model/rule versions. Configure provider retention, handle deletion and keep manuscript text out of ordinary telemetry.

### 8. Build and operational boundaries

Validate ZIP expansion limits, normalized paths and allowed file types. Compile a clean immutable snapshot with read-only toolchains, no network, shell escape disabled, no host secrets and bounded CPU, memory, process count and runtime. Use isolated ephemeral jobs. Protect logs, assets, outputs and sync channels with tenant-scoped authorization. Render generated output in the browser with ordinary content isolation. Offer the last successful PDF alongside actionable failure diagnostics.

Coalesce repeated auto-build requests, impose per-project quotas and identify every result by revision. A stale result can still be inspected, while the selected current preview remains tied to the intended revision. Deploy web/API, sync and workers in one region for beta. Monitor queue age, build failure, rejected writes and reconnect rates. Use PostgreSQL backups and versioned object storage. Test restore regularly.

Proposed beta benchmarks: p95 editor response below 50 ms on reference hardware, same-region remote edit arrival below 500 ms, and warmed small-manuscript compile below 15 seconds. Instrument without collecting manuscript text. Measure under realistic paper sizes and collaboration load.

### 9. REA investigations and implementation milestones

| Phase | Work and release evidence |
|---|---|
| A. Reference behavior | Capture documented workflows in disposable, authorised accounts with synthetic artifacts. Use visible UI and exported files. Record exact steps, public feature/plan, fixture digest, timestamp, observations and limitations. |
| B. Editor spike | Import a real multi-file template, preserve custom macros and comments, patch one paragraph visually, race a source edit, recover from invalid LaTeX and compile. Gate scope on byte-level preservation and conflict handling. |
| C. Collaborative foundation | Build manifest, ACLs, durable sync, named revisions and isolated builds. Verify 3 clients, offline/reconnect, revocation and restart during save. |
| D. Scientific content | Add maths, cross-references, bibliography, tables, plots and templated exports. Rebuild the exported ZIP outside the app with its declared profile. |
| E. Review and AI | Add review threads, tracked edits and project-aware grammar and impact. Verify meaning preservation, stale ranges and auditability. |
| F. Beta | Exercise representative team workflows, onboarding targets, the import matrix and a real restore drill. |

Start REA with six replays: Overleaf visual editing around custom LaTeX, maths and citation insertion in both Overleaf modes, two-author tracked edit versus simultaneous source typing, Grammarly rewriting a paragraph with numbers and qualifiers, Prism ZIP export and inventory, and an unsupported scientific claim in Overleaf citation review. Mark which results are directly observed and which derive from public docs. Use a matrix of observation, design decision and acceptance test. Product code, prompts, schemas and interactions use independently authored implementations.

### 10. Verification and release gates

- **Source fidelity.** Golden fixtures across article, IEEE and AMS-style templates, nested inputs, comments, macros and bibliography variants. Immediate re-export preserves untouched files. Supported visual edits preserve bytes outside intended ranges. Compare independently rebuilt PDFs with normalized metadata.
- **Concurrent work.** Test overlapping source and visual edits, disconnected clients, duplicates, restart during acknowledgement, deletion of anchored text, permission revocation and revision restore. Require zero lost acknowledged updates in the release fault suite.
- **Scientific quality.** Use a human-reviewed corpus stratified by field. Track false positives, usefulness and fidelity by suggestion type. Require zero unflagged material changes on the fixed challenge set, including changed quantities, causation, negation and attribution.
- **Data and builds.** Verify missing values, units, quoted delimiters and chart lineage. Test worker timeouts, missing packages, retries, stale PDFs and cross-tenant authorization on assets/builds/sync.
- **Accessibility.** Run keyboard, screen-reader and IME coverage across text, equation entry, comments, suggestions, view switches and conflict recovery. Include colour-independent severity and suggestion status.
- **Open decisions.** Publish the initial template/package list after testing. Select queue and realtime library after measuring durability and auth controls. Benchmark grammar providers and confirm project-level data/retention defaults before enabling model processing in beta.

### Primary sources

- [OpenAI Prism announcement and retirement notice](https://openai.com/index/introducing-prism/)
- [Prism to Codex migration guide](https://help.openai.com/en/articles/20001615-prism-to-codex-migration-guide)
- [Overleaf editor and collaboration](https://www.overleaf.com/about/features-overview)
- [Overleaf AI Assistant and citation review](https://docs.overleaf.com/integrations-and-add-ons/ai-features/ai-assistant)
- [Grammarly features](https://www.grammarly.com/features)
- [Tiptap collaboration](https://tiptap.dev/docs/editor/extensions/collaboration)
- [Tiptap math conversion limits](https://tiptap.dev/docs/conversion/content-types/structures-and-media/math-equations)
- [Yjs and ProseMirror](https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror)
- [Tectonic compile configuration](https://tectonic-typesetting.github.io/book/latest/v2cli/compile.html)
- [REA installation](https://github.com/morluto/rea/blob/main/docs/getting-started/installation.md)
