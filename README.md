# PaperWeave

A collaborative academic writing workspace: a visual editor over LaTeX source, a source editor and a compiled PDF, for small research teams.

- Spec: `docs/spec.md`
- Plan: `docs/plan.md`
- Where things stand and what is next: `docs/status.md`

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

Sign-in links are emailed; locally they arrive at http://localhost:8025. The editor spike is at
`/spike` and needs none of this.

Compiling, the database and the object store need Docker:

```bash
docker build -t paperweave-tex infra/tex
docker compose -f infra/compose.yaml up -d --wait
pnpm test:sandbox
pnpm e2e
```
