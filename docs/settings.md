# Settings

What each service reads from its environment. `packages/server/src/settings.test.ts` fails if
the code reads a setting that is not in this table, or the table names one nothing reads.

For local work none of this needs setting by hand: `pnpm e2e` and the tests carry values for
the services in `infra/compose.yaml`.

| Setting                | Read by            | Needed                  | What it is                                                                                                                                                          |
| ---------------------- | ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | web, sync, workers | yes                     | The PostgreSQL database. Migrations: `pnpm --filter @paperweave/server migrate`.                                                                                    |
| `S3_ENDPOINT`          | web, sync, workers | yes                     | The object store, any that speaks S3.                                                                                                                               |
| `S3_BUCKET`            | web, sync, workers | yes                     | Its bucket. Made on first use if it is not there.                                                                                                                   |
| `S3_ACCESS_KEY`        | web, sync, workers | yes                     | The name it knows this service by.                                                                                                                                  |
| `S3_SECRET_KEY`        | web, sync, workers | yes                     | The secret that goes with it.                                                                                                                                       |
| `S3_REGION`            | web, sync, workers | no                      | Default `us-east-1`.                                                                                                                                                |
| `BETTER_AUTH_SECRET`   | web, sync          | yes                     | Signs sessions and the tickets the editor shows the sync server. **The same value in both.** Long and random.                                                       |
| `BETTER_AUTH_URL`      | web                | yes                     | The web app's address as people reach it. Links in emails start with it.                                                                                            |
| `SMTP_URL`             | web                | yes                     | Where sign-in links and invitations are sent from.                                                                                                                  |
| `EMAIL_FROM`           | web                | no                      | Default `PaperWeave <no-reply@localhost>`. A deployment will want its own.                                                                                          |
| `SYNC_URL`             | web                | yes, outside local work | The sync server's address as browsers reach it (`wss://…`). Default `ws://localhost:4100`. The editor connects to it, and the pages' content policy allows only it. |
| `SYNC_PORT`            | sync               | no                      | Default `4100`.                                                                                                                                                     |
| `SYNC_COMPACT_EVERY`   | sync               | no                      | A file's log is rewritten as one entry every this many edits. Default `500`.                                                                                        |
| `METRICS_TOKEN`        | sync               | no                      | Whoever sends it may read `/metrics` on the sync server. Without it there is no such page.                                                                          |
| `PAPERWEAVE_TEX_IMAGE` | workers            | no                      | The image builds and charts run in. Default `paperweave-tex` (`infra/tex`).                                                                                         |
| `GRAMMAR_URL`          | web                | no                      | A LanguageTool server of your own. Without it the language panel says checking is not available. No text goes to anyone else's.                                     |
| `CROSSREF_URL`         | web                | no                      | The DOI registry. Default `https://api.crossref.org`.                                                                                                               |
| `MODEL_PROVIDER`       | web                | no                      | `anthropic` lets a paper's owner turn model reviews on for that paper. **Leave unset until the owner has decided what the provider may keep** (`docs/plan.md`).     |
| `ANTHROPIC_API_KEY`    | web                | with `MODEL_PROVIDER`   | Read by the provider's own library, not by this code.                                                                                                               |
| `SPIKE`                | web                | never in a deployment   | `1` brings back the Phase B workbench at `/spike` and an endpoint that compiles LaTeX for anyone. The tests set it.                                                 |
| `NODE_ENV`             | web                | set by the framework    | In development the pages' content policy also allows `eval`.                                                                                                        |

## What must be reachable from where

- Browsers reach the web app and the sync server. Nothing else.
- The web app, the sync server and the workers each reach the database and the object store.
- The web app reaches the mail server, the grammar server and the DOI registry, and the model
  provider if model reviews are on.
- The workers need Docker on their machine. A build or a chart runs in a container with no
  network.
- `/metrics` is on the sync server. Keep it off the public address or behind the token.

## Not settings yet

Decisions that will become settings or infrastructure once hosting is chosen:
`docs/security-review.md`, "What only a deployment can settle".
