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
| `NODE_ENV`             | web                | set by the framework    | In development the pages' content policy is looser: it also allows `eval` and style sheets it did not send.                                                         |

## What must be reachable from where

- Browsers reach the web app and the sync server. Nothing else.
- The web app, the sync server and the workers each reach the database and the object store.
- The web app reaches the mail server, the grammar server and the DOI registry, and the model
  provider if model reviews are on.
- The workers need Docker on their machine. A build or a chart runs in a container with no
  network.
- `/metrics` is on the sync server. Keep it off the public address or behind the token.

## How many of each

- **One sync server for a database, and no more.** Each keeps the files people have open in
  its own memory. With two, what is typed through one is saved and never reaches the people
  on the other: they would see different text until they loaded the page again. So a sync
  server takes a lock in the database before it serves, and a second one started against the
  same database waits, saying so in its log, until the first has stopped. That is also how a
  new version takes over from an old one.
- **Any number of web apps and workers.** Each build and each chart is taken by one worker. A
  test has two workers reach for one build at the same moment, and then build two papers
  side by side (`builds.sandbox.test`). Two web apps at once were not tried. One thing is known to differ with more than one:
  the sign-in library counts how often a client has asked in each web app's own memory, so
  its limit (five links a minute for a client) is that many times looser. The limit of ten an
  hour for an address is counted in the database, and is not.

## When something is away

What people see, and what recovers by itself, when one of these stops and comes back. Each
was tried by hand on one machine, except where it says otherwise; the details are in `docs/status.md`.

- **The database.** Editors say "Saving your edits…" and go on taking typing. Pages show the
  service's error page. The sync server and the workers keep running, make their connections
  again and look up what they missed. Typing is saved within seconds of the database being
  back.
- **The object store.** Typing into a file that is already open is still saved. Pages that
  read the paper's files show the error page; "Try again" works once the store is back.
- **The sync server.** Editors say "Offline" and keep what is typed. It is saved within
  seconds of the server being back.
- **The workers.** Builds and charts wait. After two minutes the pages that show them say the
  service may be busy or not running, and stop asking. (The workers themselves were not
  stopped: a waiting build was shown to the page as the server would report it, and a chart
  was held back from a worker that was running.)
- **The mail server.** A sign-in link or an invitation that cannot be sent is said to have
  failed on the page, is not counted against the hourly limits, and leaves nothing behind.
- **The grammar server.** The editor says "The spelling and grammar checker did not answer"
  and shows no findings. Typing is saved as usual.

None of the services needs to be started again by hand after any of these. They do need
something to start them again if their own process ends, which a fault in their own code
could still cause.

## Not settings yet

Decisions that will become settings or infrastructure once hosting is chosen:
`docs/security-review.md`, "What only a deployment can settle".
