# Settings

What each service reads from its environment. `packages/server/src/settings.test.ts` fails if
the code reads a setting that is not in this table, or the table names one nothing reads.

For local work none of this needs setting by hand: `pnpm e2e` and the tests carry values for
the services in `infra/compose.yaml`.

| Setting                                           | Read by            | Needed                  | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                    | web, sync, workers | yes                     | The PostgreSQL database. Migrations: `pnpm --filter @paperweave/server migrate`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DATABASE_POOL_MAX`                               | web, sync, workers | no                      | How many connections one process keeps to the database at most. Default `10`. A positive whole number; anything else stops the process at start, saying so. Read by `connect`, so also by `migrate` and `check-blobs`, which use one connection. The sync server's two long-lived connections (listening, and its lock) are not in the pool. On Vercel behind pgbouncer: `3` (`docs/deploy.md`).                                                                                                                                                                                           |
| `DATABASE_POOL_IDLE_MS`                           | web, sync, workers | no                      | How long a connection nobody is using is kept before it is closed, in milliseconds. Default `10000`. A positive whole number. On Vercel behind pgbouncer: `5000` (`docs/deploy.md`).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `S3_ENDPOINT`                                     | web, sync, workers | yes                     | The object store, any that speaks S3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `S3_BUCKET`                                       | web, sync, workers | yes                     | Its bucket. Made on first use if it is not there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `S3_ACCESS_KEY`                                   | web, sync, workers | yes                     | The name it knows this service by.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `S3_SECRET_KEY`                                   | web, sync, workers | yes                     | The secret that goes with it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `S3_REGION`                                       | web, sync, workers | no                      | Default `us-east-1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `S3_PUBLIC_ENDPOINT`                              | web                | no                      | The object store's address as browsers reach it, if that is not `S3_ENDPOINT`. Default `S3_ENDPOINT`. Uploads, large downloads and large pictures go between the browser and the store at this address; the pages' content policy allows it (`connect-src` and `img-src`). The store needs CORS for the web app's address (`docs/deploy.md`).                                                                                                                                                                                                                                              |
| `BETTER_AUTH_SECRET`                              | web, sync          | yes                     | Signs sessions and the tickets the editor shows the sync server. **The same value in both.** Long and random.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `BETTER_AUTH_URL`                                 | web                | yes                     | The web app's address as people reach it. Links in emails start with it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SMTP_URL`                                        | web                | yes                     | Where sign-in links and invitations are sent from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `EMAIL_FROM`                                      | web                | no                      | Default `PaperWeave <no-reply@localhost>`. A deployment will want its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SYNC_URL`                                        | web                | yes, outside local work | The sync server's address as browsers reach it (`wss://…`). Default `ws://localhost:4100`. The editor connects to it, and the pages' content policy allows only it.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SYNC_PORT`                                       | sync               | no                      | Default `4100`. Not a port browsers refuse to connect to, such as 5060, 5061, 6000 or 6665–6669: every editor would show "Offline" with a healthy server.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SYNC_COMPACT_EVERY`                              | sync               | no                      | A file's log is rewritten as one entry every this many edits. Default `500`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `METRICS_TOKEN`                                   | sync               | no                      | Whoever sends it may read `/metrics` on the sync server. Without it there is no such page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PAPERWEAVE_TEX_IMAGE`                            | workers            | no                      | The image builds and charts run in. Default `paperweave-tex` (`infra/tex`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GRAMMAR_URL`                                     | web                | no                      | A LanguageTool server of your own. Without it the language panel says checking is not available. No text goes to anyone else's.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CROSSREF_URL`                                    | web                | no                      | The DOI registry. Default `https://api.crossref.org`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CROSSREF_MAILTO`                                 | web                | no                      | A contact address for the DOI registry's polite pool, sent in the User-Agent of lookups. Without it none is sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DOI_LOOKUPS_PER_USER`, `DOI_LOOKUPS_PER_PROJECT` | web                | no                      | Lookups one person may make in ten minutes (default 30) and one paper in a day (default 500).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SIGN_IN_EMAILS_PER_HOUR`                         | web                | no                      | Sign-in emails the whole service sends in an hour, to anyone. Default `500`. Past it people are told sign-in emails are at the hour's limit. Sized to what the mail service allows, not to your users: one address is separately held to a burst of three links and then one every six minutes.                                                                                                                                                                                                                                                                                            |
| `TRUSTED_IP_HEADER`                               | web                | no                      | Name of a header your own proxy sets, replacing any value from the client, to the client's address (for example `x-real-ip`, `cf-connecting-ip`). With it, the sign-in library limits each client address (five sign-in requests a minute), counted in the database, so every instance shares the count. **Without it nothing is read from the request: there is no limit by client address.** `x-forwarded-for` as a browser sends it must not be named here unless the proxy overwrites it. A request without the header, or with more than one address in it, is not limited by client. |
| `MODEL_PROVIDER`                                  | web                | no                      | `anthropic` lets a paper's owner turn model reviews on for that paper. **Leave unset until the owner has decided what the provider may keep** (`docs/plan.md`).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ANTHROPIC_API_KEY`                               | web                | with `MODEL_PROVIDER`   | Read by the provider's own library, not by this code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SPIKE`                                           | web                | never in a deployment   | `1` brings back the Phase B workbench at `/spike` and an endpoint that compiles LaTeX for anyone. The tests set it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `NODE_ENV`                                        | web                | set by the framework    | In development the pages' content policy is looser: it also allows `eval` and style sheets it did not send.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Fixed in the code

- **The session cookie cache, 60 seconds.** Better Auth keeps a copy of the session in a cookie
  for this long, so pages and actions do not ask the database who is signed in each time. A
  session ended from another device keeps working in this browser, for pages and actions, for up
  to 60 seconds. Editing in the editor stops at once, and who may do what on a paper is read from
  the database every time. Not a setting: it is `SESSION_CACHE_SECONDS` in
  `packages/server/src/auth.ts`. `docs/deploy.md` has the rest.
- **Limits on a line that has gone quiet.** None is a setting.
  - A transaction that sits 15 seconds between two statements is ended by the database, which
    frees the rows it held (`transaction` in `packages/server/src/db.ts`). The build and chart
    workers' transactions are exempt: they hold their row through a compile or a render, and it
    is taken `skip locked`, so nobody waits on it.
  - A database statement gets 30 seconds and a connection, or a wait for a free one, 10; TCP
    keepalive is on. The migrator has no limit, as it waits on another migrator.
  - Every request to the object store has 10 seconds to answer, and then its body is allowed to
    move at 100 kB/s at least (`ask` in `packages/server/src/blobs.ts`).
  - In the browser, the request for an upload address is given up after 15 seconds, and the
    upload of a large file after 30 seconds in which no byte has gone
    (`apps/web/app/DirectUpload.tsx`).

## What must be reachable from where

- Browsers reach the web app, the sync server and the object store (`S3_PUBLIC_ENDPOINT`): a file is
  put there by the browser, and a large PDF or picture is fetched from there. Nothing else.
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
  new version takes over from an old one: start the new one, then stop the old. Tried by
  hand on one port with an editor open, which was saving again 1.4 seconds later.
- **Any number of workers.** Each build and each chart is taken by one worker. A test has two
  workers reach for one build at the same moment, and then build two papers side by side
  (`builds.sandbox.test`).
- **Any number of web apps, with three things to know.** Two at once were tried behind a
  proxy that gave each request to the other in turn, and the browser tests passed through it;
  one replacing another was tried too.
  - The proxy in front must pass the `Host` header as it came, or put the host people use in
    `X-Forwarded-Host`. With neither, every button on a page fails with "This page could not
    be shown": the framework will not run a form it cannot tell came from its own page. Both
    ways were tried by hand, and so was the failure.
  - Every web app must be the same build, or built with the same key. The buttons on a paper's
    page are forms whose arguments the framework encrypts with a key it makes at each build
    and keeps in that build's cache.
    - Tried by hand: with a page open, the web app was built again without the kept key and
      started in the old one's place. A button pressed on the open page did nothing, and the
      person saw the service's "This page could not be shown". Loading the page again showed
      it from the new build, with nothing changed by the press. (That is what the page's "Try
      again" does; here the page was loaded again directly.)
    - Built again on the same machine with its cache, the key is kept and the open page's
      button simply worked. So one machine replacing its own build does not show this; builds
      made on fresh machines do, each time a new version replaces an old one.
    - The framework reads a key of your choosing from `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` at
      build time; its own guide to self-hosting says how. Tried by hand: with that set the
      same for both builds, and no cache kept between them, the button on the page that was
      already open worked across the change. So set it, the same for every build.
    - Not tried: the framework's `deploymentId`, its own way of telling an old page that the
      version has changed.
  - Sign-in limits are all counted in the database, so every instance counts the same. The
    limit by client (five links a minute) exists only where `TRUSTED_IP_HEADER` is set; hosting
    and the proxy in front are the owner's choice, and without that setting the limits that hold
    are the per-address spacing and the hourly cap on all sign-in emails.

## When something is away

What people see, and what recovers by itself, when one of these stops and comes back. Each
was tried by hand on one machine, except where it says otherwise; the details are in `docs/status.md`.

- **The database.** Editors say "Saving your edits…" and go on taking typing. Pages show the
  service's error page. The sync server and the workers keep running, make their connections
  again and look up what they missed. Typing is saved within seconds of the database being
  back.
- **The line goes quiet** (a connection to the database or the store that stops answering
  without being closed, as when something between loses it). A transaction is ended by the
  database after 15 seconds, a statement fails after 30 and a store call after 10 (see "Fixed in
  the code"), and the person gets the service's error page or a message instead of a page that
  never finishes. A write that timed out may still have been made, and the error page says
  so. While a form or a link waits, the page says "Working…" after a second and "No answer
  from the server yet" after eight; while a large file goes up, it says how far it has got.
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
