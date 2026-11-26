<div align="center">

# PaperWeave

**Write the paper together. Keep the LaTeX.**

A collaborative writing workspace for small research teams: a visual editor over your LaTeX
source, a source editor, and the compiled PDF, side by side.

[![CI](https://github.com/pranav-ramanathan/PaperWeave/actions/workflows/ci.yml/badge.svg)](https://github.com/pranav-ramanathan/PaperWeave/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.18-5fa04e?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10-f69220?logo=pnpm&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)

[Quick start](#quick-start) · [Features](#features) · [How it fits together](#how-it-fits-together) · [Docs](#documentation) · [Testing](#testing)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/editor-source-dark.png">
  <img src="docs/images/editor-visual-light.png" alt="The PaperWeave editor: the file tree, the visual editor, the review panel with a proposed change and a comment, and the compiled PDF" width="100%">
</picture>

</div>

---

## Why PaperWeave

Most of a paper is written by several people, in LaTeX, with a deadline. PaperWeave keeps the
source as the one truth and puts everything a team needs around it: writing without markup when
you want to, the PDF always one glance away, and review that happens on the text rather than in
a separate thread of emails.

|                            |                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Your LaTeX stays yours** | The visual view is a projection of the source. What it cannot show stays as raw LaTeX, and files you did not touch are kept byte for byte. |
| **Review on the text**     | Comments are anchored to a passage. Proposed changes show their diff and flag what they change about a claim.                              |
| **Private by default**     | Spelling and grammar run on your own LanguageTool. Builds run in a container with no network.                                              |
| **Several versions**       | Start a linked version of a paper, work on it, and merge it back.                                                                          |

## Features

### Write

- **Visual editor, source editor, PDF.** Switch between the visual and source views of the same
  file; the PDF rebuilds as you write, or on demand, and you can jump from a place in the PDF to
  its line in the text.
- **Equations, citations, references, figures, tables.** Inserted from the toolbar, the keyboard
  or a menu at the caret. Maths is drawn with KaTeX.
- **Live co-editing.** Everyone on a paper edits the same files at once, with presence, and a
  line saying when your edits are saved.
- **Resizable panes.** From 60rem wide, drag (or use the arrow keys on) the handle between the
  text and the PDF. The sizes are kept in your browser.
- **Light and dark**, with self-hosted Literata and Atkinson Hyperlegible fonts.

### Review

- **Comments and threads** anchored to the selected text, with replies, resolve and delete.
- **Proposed changes** that show the old and new wording and the reason, and are accepted,
  rejected, changed or withdrawn by people.
- **Claim flags.** When a proposal changes numbers, units, negation, direction, certainty,
  causation, scope or citations, it says so before anyone decides.
- **Scientific critique by a model**, off by default. It is used only when a deployment names a
  provider and has credentials, and the paper's owner allows it for that paper. Nothing it
  suggests is applied without a person.
- **Spelling and grammar** from LanguageTool, run on your own machine.

### Build and submit

- **Sandboxed builds.** Every compile runs in a Docker container with no network, in the
  `paperweave-tex` image (TeX Live and latexmk), with BibTeX or Biber found for you.
- **CSV charts.** Describe a data file, pick a chart, and it is drawn for the paper with Vega-Lite.
- **Check before submitting.** Missing files, undefined labels, unresolved citations, compiler
  warnings and stale charts, in one place.
- **Import and export.** Start from a template (article, IEEE conference paper, AMS article) or
  import a ZIP, `.tar.gz`, `.tgz` or `.tar` of a LaTeX project. Download a revision's files and PDF.

### Versions

A **version** is a linked copy of a paper begun at one of its revisions, up to 10 for each paper.
Owners and editors can start one, work on it with the same review tools, and merge it back.
They are on by default; set `VERSIONS=0` to turn them off for everyone.

<details>
<summary><strong>What happens to each kind of paper on import</strong></summary>

<br>

Document classes tried from real and synthetic fixtures include `article`, `IEEEtran`, `amsart`,
`acmart`, `elsarticle` and `llncs`, with `pdflatex` or `xelatex` and BibTeX or Biber. How much of
each paper's prose can be edited visually, and which files are edited in source only, is listed
per paper in [`docs/import-matrix.md`](docs/import-matrix.md). That file is written by a test
from the papers themselves, so it cannot drift.

</details>

## Screens

<table>
  <tr>
    <td width="50%"><img src="docs/images/papers-list-light.png" alt="The list of papers, with a form to start a new paper from a template and a place to import a project"></td>
    <td width="50%"><img src="docs/images/chart-light.png" alt="A line chart drawn from a CSV file, with the controls for its kind and axes below it"></td>
  </tr>
  <tr>
    <td align="center"><sub>Your papers, a template or an import to start</sub></td>
    <td align="center"><sub>A chart drawn from a CSV file in the paper</sub></td>
  </tr>
</table>

<sub>Screenshots are of a test paper with no real manuscript content. Parts that change from run to run (addresses, times) are blanked.</sub>

## Quick start

You need Node 22.18 or newer, [pnpm](https://pnpm.io) and Docker.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

Run the app at http://localhost:3000. It needs the local services (PostgreSQL, an S3-compatible
object store, a mail catcher and LanguageTool), a migrated database and its settings:

```bash
docker compose -f infra/compose.yaml up -d --wait
```

```bash
cp .env.example apps/web/.env.local
```

```bash
pnpm --filter @paperweave/server migrate
```

```bash
pnpm dev
```

> [!NOTE]
> Sign-in links are emailed. Locally they arrive at http://localhost:8025.

### Live editing and the PDF

Live editing needs the sync server too, in a second terminal:

```bash
pnpm --filter @paperweave/sync start
```

The PDF beside the editor needs the build worker, in a third. It uses Docker and the TeX image:

```bash
docker build -t paperweave-tex infra/tex
```

```bash
pnpm --filter @paperweave/workers start
```

> [!WARNING]
> The editor workbench from Phase B is at `/spike` when the server is started with `SPIKE=1`. It
> needs none of the above, and is switched off otherwise because it compiles LaTeX for anyone
> without signing in. Never set it in a deployment.

## How it fits together

```mermaid
flowchart LR
  browser["Browser<br/>visual · source · PDF"]
  web["apps/web<br/>Next.js, sign-in, pages"]
  sync["apps/sync<br/>live co-editing"]
  workers["apps/workers<br/>builds · charts · imports"]
  tex["paperweave-tex<br/>Docker, no network"]
  pg[("PostgreSQL")]
  s3[("S3 object store")]
  lt["LanguageTool"]
  mail["Mail"]

  browser --> web
  browser <--> sync
  web --> pg
  web --> s3
  web --> lt
  web --> mail
  sync --> pg
  sync --> s3
  workers --> pg
  workers --> s3
  workers --> tex
```

| Part              | What it is                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web`        | The web app: Next.js and React, Tailwind CSS v4 and Radix, CodeMirror for source, Tiptap for the visual view, PDF.js for the preview |
| `apps/sync`       | The sync server. Holds the open files (Yjs) and keeps a lock in the database, so there must be exactly one                           |
| `apps/workers`    | Build, chart and import workers. They start a Docker container for every build and chart                                             |
| `packages/server` | Shared server code: access rules, revisions, versions and merging, review, claim flags, migrations                                   |
| `packages/latex`  | LaTeX parsing that keeps every byte of the source                                                                                    |
| `packages/bridge` | The link between the visual document and the source                                                                                  |
| `infra/`          | Local services (`compose.yaml`), the TeX image, backup and restore scripts, systemd units                                            |

Where it runs in production is the owner's choice. The web app can run on Vercel with the rest on
one machine you own ([`docs/deploy.md`](docs/deploy.md)), or the sync server, Postgres and the
store can run on Railway ([`docs/deploy-railway.md`](docs/deploy-railway.md)). Every setting each
service reads is in [`docs/settings.md`](docs/settings.md).

## Testing

Compiling, the database and the object store need Docker:

```bash
docker build -t paperweave-tex infra/tex
docker compose -f infra/compose.yaml up -d --wait
pnpm test:sandbox
pnpm e2e
```

[CI](.github/workflows/ci.yml) runs lint, typecheck and the unit tests, the sandbox tests, and the
browser tests in three shards, plus a dark-mode run.

<details>
<summary><strong>Test slots: running browser tests side by side</strong></summary>

<br>

`pnpm e2e` uses ports 3100 (web) and 4100 (sync) and the database `paperweave`. To run browser
tests at the same time as another run, use another slot: its own ports and its own database.

| Slot | `E2E_WEB_PORT` | `E2E_SYNC_PORT` | Database       |
| ---- | -------------- | --------------- | -------------- |
| A    | 3100 (default) | 4100 (default)  | `paperweave`   |
| B    | 3200           | 4200            | `paperweave_b` |
| C    | 3300           | 4300            | `paperweave_c` |
| D    | 3400           | 4400            | `paperweave_d` |
| E    | 3500           | 4500            | `paperweave_e` |

Start a slot with a fresh database (slot B shown), check that its two ports are free (`ss -ltn`),
and use `--project=e2e` (the `mail-down` project pauses the shared mail container):

```bash
docker exec infra-postgres-1 dropdb -U paperweave --if-exists paperweave_b
docker exec infra-postgres-1 createdb -U paperweave paperweave_b
E2E_WEB_PORT=3200 E2E_SYNC_PORT=4200 \
  DATABASE_URL=postgres://paperweave:paperweave@localhost:5432/paperweave_b \
  pnpm exec playwright test tests/e2e/files.spec.ts --project=e2e
```

The object store only accepts uploads from the web ports in `infra/compose.yaml`; after that list
changes, make the container again (`docker compose -f infra/compose.yaml up -d`) for `uploading.spec`
to pass on slots B and C.

</details>

## Documentation

| Read                                                                                   | For                                                             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`docs/spec.md`](docs/spec.md)                                                         | The specification                                               |
| [`docs/plan.md`](docs/plan.md)                                                         | The plan                                                        |
| [`docs/status.md`](docs/status.md)                                                     | Where things stand and what is next                             |
| [`docs/settings.md`](docs/settings.md)                                                 | What each service reads from its environment                    |
| [`docs/import-matrix.md`](docs/import-matrix.md)                                       | What happens to each kind of paper on import                    |
| [`docs/grammar-benchmark.md`](docs/grammar-benchmark.md)                               | How the spelling and grammar checker does on labelled sentences |
| [`docs/accessibility.md`](docs/accessibility.md)                                       | Accessibility, and what has not been checked                    |
| [`docs/restore-drill.md`](docs/restore-drill.md)                                       | Backing up and restoring, and what a drill showed               |
| [`docs/benchmarks.md`](docs/benchmarks.md)                                             | How long things take                                            |
| [`docs/security-review.md`](docs/security-review.md)                                   | Security: what was reviewed, fixed and left open                |
| [`docs/tectonic-comparison.md`](docs/tectonic-comparison.md)                           | Tectonic compared with the TeX Live toolchain                   |
| [`docs/deploy.md`](docs/deploy.md), [`docs/deploy-railway.md`](docs/deploy-railway.md) | Deploying on Vercel, or on Railway                              |
| [`docs/upstream.md`](docs/upstream.md)                                                 | Faults in the sync library that are worked around here          |

> [!IMPORTANT]
> Accessibility has been checked with an automated audit and by keyboard. Nobody has yet listened
> to it with a screen reader, and only Chromium has been run. [`docs/accessibility.md`](docs/accessibility.md) lists what is not checked.

---

<sub>PaperWeave has no licence file yet, so no licence is granted by this repository.</sub>
