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
