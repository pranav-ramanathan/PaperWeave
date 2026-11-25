# PaperWeave

A collaborative academic writing workspace: a visual editor over LaTeX source, a source editor and a compiled PDF, for small research teams.

- Spec: `docs/spec.md`
- Plan: `docs/plan.md`
- Where things stand and what is next: `docs/status.md`
- What happens to each kind of paper on import: `docs/import-matrix.md`
- How the spelling and grammar checker does on labelled sentences: `docs/grammar-benchmark.md`
- Accessibility, and what has not been checked: `docs/accessibility.md`
- Backing up and restoring, and what a drill showed: `docs/restore-drill.md`
- How long things take: `docs/benchmarks.md`
- Security: what was reviewed, fixed and left open: `docs/security-review.md`
- Tectonic compared with the TeX Live toolchain: `docs/tectonic-comparison.md`
- What each service reads from its environment: `docs/settings.md`
- Faults in the sync library that are worked around here, ready to report: `docs/upstream.md`

## Develop

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

Run the app at http://localhost:3000. It needs the local services, a migrated database and its
settings:

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

Sign-in links are emailed; locally they arrive at http://localhost:8025. The editor workbench from
Phase B is at `/spike` when the server is started with `SPIKE=1`; it needs none of this, and
is switched off otherwise because it compiles LaTeX for anyone without signing in.

Compiling, the database and the object store need Docker:

```bash
docker build -t paperweave-tex infra/tex
docker compose -f infra/compose.yaml up -d --wait
pnpm test:sandbox
pnpm e2e
```

### Test slots

`pnpm e2e` uses ports 3100 (web) and 4100 (sync) and the database `paperweave`. To run browser tests
at the same time as another run, use another slot: its own ports and its own database.

| Slot | `E2E_WEB_PORT` | `E2E_SYNC_PORT` | Database       |
| ---- | -------------- | --------------- | -------------- |
| A    | 3100 (default) | 4100 (default)  | `paperweave`   |
| B    | 3200           | 4200            | `paperweave_b` |
| C    | 3300           | 4300            | `paperweave_c` |

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
