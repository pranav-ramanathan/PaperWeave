# Deploying on Railway (an option)

This is an option next to `docs/deploy.md`, not a replacement. Where PaperWeave is hosted is the
owner's decision, and no default changes because of this page. Every setting is in
`docs/settings.md`; this page says where each goes on Railway, and what differs from the
Vercel plan.

Railway's pages and threads were read on 2026-11-25 (list at the end). Several of the facts below
come from community and support threads, not from Railway's own documentation, and are marked.
Limits change: read them again before relying on one. **Nothing here was tried on Railway.** What
was tried is said where it is said.

## What runs where

| Where              | What                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Railway            | The sync server (exactly one), PostgreSQL (managed), a Bucket (the S3 store), LanguageTool |
| Railway, or Vercel | `apps/web`. Either works; see "The web app" below                                          |
| A machine you own  | The workers. Any machine with Docker: your own, or a small VM                              |
| A mail provider    | Sign-in links and invitations (`SMTP_URL`). Not Mailpit.                                   |

- **The workers cannot run on Railway's ordinary services.** They start a Docker container for
  every build and chart (`apps/workers/src/compile.ts`: `--network none`, `--read-only`,
  `--cap-drop ALL`, a pids limit and a memory limit). Threads on Railway's support site say that
  services cannot run privileged containers or reach a Docker daemon, so Docker-in-Docker is
  unsupported. These are community and support threads, not an official page:
  - https://station.railway.com/feedback/docker-in-docker-d07c4730
  - https://station.railway.com/feedback/allow-services-to-be-run-in-privileged-m-8c66b22b
- **Rewriting the worker to sandbox without Docker is not recommended.** A thread about Chromium
  suggests Railway services block Linux user namespaces
  (https://station.railway.com/questions/chromium-sandbox-blocked-by-linux-user-n-49da4437), which
  is what most such sandboxes rest on. And it would weaken the isolation the security review
  relies on (`docs/security-review.md`). Not tried.
- **Railway Sandboxes have Docker, and are untested here.** Railway's changelog of 2026-06-12
  says Docker was added to its separate Sandboxes product
  (https://railway.com/changelog/2026-06-12-docker-in-sandboxes.md). Whether a Sandbox suits a
  worker that runs for weeks and takes jobs all the time has not been checked. It is the first
  thing to look at if the owner wants the workers on Railway too.
- **The sync server must be one instance.** It keeps the open files in its own memory and holds
  a lock in the database for as long as it runs (`docs/settings.md`, "How many of each"). On
  Railway, keep it at one replica, and do not turn on anything that starts a second one.
  A new deploy that starts the new one before stopping the old one is fine: the new one waits for
  the lock. Whether Railway's deploys overlap that way was not checked.

## Why the workers are off Railway, and what that costs

The workers only make outbound connections: to Postgres and to the bucket. So the machine they
run on needs **no tunnel and no open port**.

- Postgres: through Railway's public TCP proxy, with TLS. This is Railway's feature for reaching
  a database from outside; read its page before using it. Use the proxy's address as the
  workers' `DATABASE_URL`, with `?sslmode=verify-full`. The `pg` library in this repository
  (8.23.1) treats `sslmode=require` as `verify-full` already (`docs/deploy.md`); write
  `verify-full` so it does not change meaning in its next major version. Whether the proxy's
  certificate is one that library trusts was not tried. If it is not, the workers will fail to
  connect, saying so.
- The bucket: its public endpoint, with the bucket's keys.
- The workers need `DATABASE_URL`, the `S3_*` settings and Docker with the `paperweave-tex` image
  (`docker build -t paperweave-tex infra/tex`). `infra/systemd/` has a unit for them, as in
  `docs/deploy.md`, "The sync server and the workers" (the step about the sync server does not
  apply: it is on Railway).
- **The proxy exposes Postgres to the internet.** Railway's TCP proxy is a public address. It
  needs the same care as in `docs/deploy.md`: a long random password, and nothing else relying on
  the address being secret. The difference from the Vercel plan is that this is Railway's
  proxy in front of a managed database, not Postgres on your own machine behind a port you
  opened. Not reviewed beyond that.
- If the owner would rather have no public Postgres address at all, the workers would have to
  run where Railway's private network reaches them. That means a Sandbox or another way on
  Railway, which is the untested option above.

## What it removes, compared with the Vercel plan

- **The Cloudflare tunnel.** The bucket and LanguageTool have addresses of their own on Railway,
  and the sync server is a Railway service with a public domain. Nothing of yours needs a
  tunnel for them.
- **The Postgres port that `docs/deploy.md` opens on your own machine.** The web app and the
  sync server reach the database over Railway's private network. The one remaining public
  address is the TCP proxy the workers use (above), which is Railway's, and which can be turned
  off if the workers move.
- Your machine no longer has to be reachable from outside at all.

What it does not remove: the mail provider, the workers' Docker, and the need for something to
restart the workers if their process ends (`docs/settings.md`, "When something is away").

## Postgres, and the pooler

- Use Railway's managed Postgres. The web app and the sync server on Railway use its private
  address as `DATABASE_URL`. A private address is for services in the same Railway project and
  environment; check that for the project you make.
- **The pooler question depends on where the web app is.**
  - Web app on Railway: it is one long-running process, not many function instances, so the
    pool in `packages/server/src/db.ts` behaves as on any server. The defaults
    (`DATABASE_POOL_MAX` 10, `DATABASE_POOL_IDLE_MS` 10 seconds) are fine. pgbouncer is not
    needed. This was reasoned from the code, not tried on Railway.
  - Web app on Vercel: nothing about "The pooler" in `docs/deploy.md` changes, and Vercel's
    functions would need Railway's public TCP proxy, which is then used by more than the workers.
    That puts back most of what this plan removes. If the web app stays on Vercel, the
    plan gets smaller gains: the sync server, the bucket and LanguageTool still move, but the
    database is exposed as in `docs/deploy.md`.
- The sync server, the workers and `migrate` connect to Postgres itself, never through a pooler
  (`listen` and advisory locks; `docs/deploy.md`, "The pooler").

## The object store

Railway Buckets (https://docs.railway.com/storage-buckets and
https://docs.railway.com/guides/storage-buckets-guide) are, as those pages say:

- S3-compatible and private;
- able to give presigned URLs;
- addressed in virtual-hosted style (`https://bucket.host/key`), and older buckets may need
  path-style;
- configurable for CORS, for uploads from a browser.

**What the code did before.** `packages/server/src/blobs.ts` builds every address as
`<endpoint>/<bucket>/<key>`: path style, always. The client is `aws4fetch`, which has no
path-style option of its own; the path was put together in the code. So a store that accepts
only virtual-hosted style would have refused every call.

**What is now there.** `S3_PATH_STYLE` (`docs/settings.md`). Unset or `true`: exactly as before,
so no existing setup changes. `false`: the bucket's name goes in the host name,
`https://<bucket>.<host>/<key>`, for `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` both. The
page's content policy (`apps/web/proxy.ts`) names the bucket's own host in that case, as that
is the one browsers reach. A unit test (`packages/server/src/blobs.test.ts`) holds that the
addresses are path-style by default and virtual-hosted when the setting says so.

**Presigned uploads need nothing path-style.** The upload address is signed by `signed()` in
`blobs.ts`, with `X-Amz-Expires` in the query and `content-length` as a signed header. Neither
depends on how the bucket is named; the host is part of what is signed, and is the bucket's host
when `S3_PATH_STYLE=false`.

Settings for the bucket on Railway:

- `S3_ENDPOINT`: the bucket's endpoint as Railway shows it, without the bucket's name in it.
- `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`: from the bucket's page.
- `S3_PATH_STYLE`: `false` for a bucket that wants virtual-hosted style; leave it unset for one
  that takes path style. Which a given bucket takes is not known from here.
- CORS on the bucket: as in `docs/deploy.md`, "Making the store reachable from browsers", for
  Amazon S3 and others: the web app's origin; `GET`, `PUT`, `HEAD`; headers `*`; expose
  `Content-Length`, `Content-Range`, `ETag`.

**Not tried:**

- Any call against a Railway bucket. The unit test uses a stand-in HTTP server, not the real
  thing.
- Whether the first call's `PUT` on the bucket (it makes the bucket "on first use", and ignores
  the answer) is harmless on a bucket that already exists in virtual-hosted style. The code does
  not look at the status. Make the bucket in Railway first.
- Listing (`uploadSweep`, which the workers run every hour) against Railway's bucket. It uses
  the S3 `list-type=2` call on the bucket's address.
- Whether the bucket's address is reachable by browsers directly, which large downloads and
  uploads need (`docs/deploy.md`, "Large uploads and downloads").

## LanguageTool

A container service on Railway, from the image `infra/compose.yaml` names, on port 8010, with
`Java_Xms` 256m and `Java_Xmx` 1g. It takes about a gigabyte of memory (`infra/compose.yaml`);
check that the plan has it. Give the web app its private address as `GRAMMAR_URL`. Only the web
app calls it, so it needs no public domain. No text then leaves for anyone else's service.
Not tried on Railway.

## The web app

It may stay on Vercel (`docs/deploy.md`) or move to Railway. Either way:

- `BETTER_AUTH_SECRET` is the same as the sync server's.
- `BETTER_AUTH_URL` is the one name people use. The forms refuse another (`docs/deploy.md`).
- `SYNC_URL` is the sync server's public `wss://` address on Railway.
- `SMTP_URL`, `EMAIL_FROM`: the mail provider's.
- `SPIKE` is never set.

**What changes if it moves to Railway:**

- `DATABASE_URL` is Railway's private address; no pgbouncer; the pool defaults stay.
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` matters less with one instance, but it still matters when
  a new build replaces an old one on a fresh machine, which each Railway build is
  (`docs/settings.md`, "How many of each"). Set it the same for every build, as in
  `docs/deploy.md`.
- None of Vercel's limits apply: not the 4.5 MB body, not `maxDuration`. The signed uploads and
  downloads still work as written, and stay worthwhile because they keep large files off the
  web app. Not tried without them.
- The proxy in front must pass the `Host` header as it came (`docs/settings.md`). Railway's was
  not checked.
- How to build and start it (a Dockerfile or Railway's own build, the install filter, the Node
  version, the start command) is not written. `apps/web/vercel.json` is Vercel's; nothing here
  says what to put in its place. Node 22.18 or later is needed (`engines`).

**What changes if it stays on Vercel:**

- Everything in `docs/deploy.md`, with the S3 and Postgres addresses now Railway's public ones:
  `S3_ENDPOINT` is the bucket's, and Vercel's functions need a Postgres address they can reach,
  which is Railway's TCP proxy and then the pooler as in `docs/deploy.md`. That keeps the
  exposure this plan is meant to remove. The Cloudflare tunnel still goes.
- `GRAMMAR_URL` needs a public address for LanguageTool then, since Vercel's functions cannot
  reach Railway's private network.

## Deploy order

Carried over from `docs/status.md` (the connection-cap work, "PR notes"): **the web app first,
then the sync server.** A page loaded before the web app is deployed treats an authentication
failure it does not know as "you no longer have access", which is final, and would lock the
editor of someone who is over the cap. So whenever a change adds or changes a refusal reason,
deploy the web app first and wait for it to be live. On Railway that is two services in one
project: deploy them one after the other, not together.

Migrations run before the new web build goes live, as in `docs/deploy.md`, against Postgres
itself (the TCP proxy's address from your machine; `migrate` takes an advisory lock):

```
DATABASE_URL=postgres://… pnpm --filter @paperweave/server migrate
```

Then the sync server, then the workers (restarted on the new code).

## Settings on Railway

| Setting                                                                   | Value                                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                            | Web and sync on Railway: Railway's private address. Workers: the TCP proxy's, `?sslmode=verify-full` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | The bucket's, as Railway shows them. The same for all three                                          |
| `S3_PATH_STYLE`                                                           | `false` if the bucket wants virtual-hosted style                                                     |
| `BETTER_AUTH_SECRET`                                                      | Long and random. **The same value for web and sync.**                                                |
| `BETTER_AUTH_URL`                                                         | The address people use                                                                               |
| `SMTP_URL`, `EMAIL_FROM`                                                  | The mail provider's                                                                                  |
| `SYNC_URL`                                                                | The sync server's public `wss://` address                                                            |
| `GRAMMAR_URL`                                                             | LanguageTool's private address (web on Railway)                                                      |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`                                      | Set once, the same for every build (`docs/deploy.md`)                                                |
| `MODEL_PROVIDER`, `ANTHROPIC_API_KEY`, `CROSSREF_URL`                     | Leave unset                                                                                          |
| `SPIKE`                                                                   | **Never set**                                                                                        |

## What is not known

- **Everything that needs a Railway project.** No service, bucket, proxy or deploy here was made.
- Whether a Sandbox could run the workers, and at what cost.
- Whether the TCP proxy's certificate passes `verify-full` for `pg`.
- Whether a bucket takes path style, virtual-hosted style, or both, and whether CORS on it
  behaves as the pages say.
- Railway's prices, and how its limits compare with the machine you already own. Not read.
- How `/metrics` on the sync server (`METRICS_TOKEN`) is kept off the public address on Railway.
- Whether Railway keeps the sync server at one instance during a deploy.
- The sources for the Docker and user-namespace facts are community threads. If it matters,
  ask Railway.

## Pages read

All read on 2026-11-25.

- https://station.railway.com/feedback/docker-in-docker-d07c4730 (community)
- https://station.railway.com/feedback/allow-services-to-be-run-in-privileged-m-8c66b22b (community)
- https://station.railway.com/questions/chromium-sandbox-blocked-by-linux-user-n-49da4437 (community)
- https://railway.com/changelog/2026-06-12-docker-in-sandboxes.md
- https://docs.railway.com/storage-buckets
- https://docs.railway.com/guides/storage-buckets-guide
