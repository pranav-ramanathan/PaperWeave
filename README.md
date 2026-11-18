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

The editor spike runs at http://localhost:3000/spike:

```bash
pnpm dev
```

Compiling, the database and the object store need Docker:

```bash
docker build -t paperweave-tex infra/tex
docker compose -f infra/compose.yaml up -d --wait
pnpm test:sandbox
pnpm e2e
```
