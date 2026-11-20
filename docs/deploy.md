# Deploying on Vercel

The web app runs on Vercel. Everything else runs on one machine you own, and Vercel reaches it
over the internet. Every setting is in `docs/settings.md`; this page says where each goes.

Vercel's pages were read on 2026-11-20 (list at the end). Where a limit is quoted, it is quoted
from there. Limits change: read them again before relying on one.

## What runs where

| Where           | What                                                                 |
| --------------- | -------------------------------------------------------------------- |
| Vercel          | `apps/web`                                                           |
| Your machine    | PostgreSQL, the S3 store, LanguageTool, the sync server, the workers |
| A mail provider | Sign-in links and invitations (`SMTP_URL`). Not Mailpit.             |

- **The sync server cannot run on Vercel.** It keeps the open files in its own memory and holds
  a lock in the database for as long as it runs. A function that ends after a request does
  neither. There must be exactly one.
- **The workers cannot run on Vercel.** They start a Docker container for every build and chart,
  with no network, in the `paperweave-tex` image. A function cannot start containers.
- LanguageTool and the S3 store could run elsewhere. They are on your machine because
  `infra/compose.yaml` already has them, and because no text should leave for anyone else's service.

## Making your machine reachable

Browsers reach the web app and the sync server. Vercel's functions reach Postgres, the S3 store,
LanguageTool and the mail provider. The workers and the sync server reach Postgres and the S3
store on your machine directly, and need nothing from outside.

- **A tunnel** (for example Cloudflare Tunnel, run as `cloudflared` on your machine) gives a
  public `https://` name to a service on your machine without opening a port. Use it for three:
  - the S3 store (`S3_ENDPOINT`),
  - LanguageTool (`GRAMMAR_URL`),
  - the sync server, as `wss://` (`SYNC_URL`). Cloudflare's page on WebSockets says it supports
    them "without additional configuration", and that a connection is closed "when no data is
    transmitted in either direction for a period of time". Not tried here with the sync server.
- **Postgres needs a TCP address that Vercel's functions can connect to.** A tunnel for a TCP
  service needs a program running on the caller's side, and a function cannot run one. So
  Postgres is the one service that must be open to the internet, on a port of its own.
  (That a TCP service behind a tunnel needs a client program on the caller's side is not from
  Cloudflare's pages: the page that would say so could not be fetched.)
- **That exposes the database.** Anyone who can reach the port can try to sign in. Restrict it:
  - Require TLS, and refuse every connection that is not TLS (`hostssl` lines only in
    `pg_hba.conf`).
  - One strong random password, at least 32 characters, for one role. The role owns only this
    database.
  - Do not give it the `superuser` or `createdb` rights.
  - If Vercel's addresses can be fixed for your plan, allow only those. Without that, anything
    can connect, and the password and TLS are all that stand in the way.
  - Put pgbouncer (below) on that port, not Postgres. Postgres itself stays on the machine's
    inside address.
- **The certificate must be a real one.** The `pg` library in this repository (8.23.1) treats
  `sslmode=require` as `verify-full`: the certificate must be from an authority it trusts and
  must be for the name used. Checked by parsing the address, which gave an empty `ssl` setting
  (verify) for `require` and for `verify-full`, and `rejectUnauthorized: false` only for
  `no-verify`. The library warns that this will change to the weaker libpq meaning in its next
  major version. Write `sslmode=verify-full` so it does not.
  A self-signed certificate will be refused. Not tried against a server with TLS.

## The pooler

Every function instance opens its own connections. Vercel's page on connection pooling says
that opening a connection on each request "can exhaust server memory usage and hit the maximum
number of connections allowed", and recommends a pooler that "keeps an active connection to the
database".

Run pgbouncer in front of Postgres, in transaction mode, and give its address to the web app as
`DATABASE_URL`. The sync server, the workers and the migrations use Postgres's own address.

What the web app does with the database (`packages/server/src/db.ts`, and a search of
`apps/web` and `packages/server`):

- It makes a `pg.Pool` with the library's defaults (at most 10 connections for one instance).
  Every query is `pool.query(sql, params)` and every transaction is `begin` … `commit` on one
  connection. It never names a prepared statement, never uses `listen`, and takes no advisory
  lock.
- **Safe through a pooler in transaction mode:** all of that. Tried with pgbouncer 1.26.1: 60
  transactions at once through a pooler with 5 server connections all worked, and the built web
  app started against it and answered `/sign-in` and `/api/auth/get-session`.
- **Not safe through it:** `listen` and advisory locks, which the sync server (`onlyOne`,
  `listen`), the workers (`listen`) and `migrate` use. Tried: two notifications sent through the
  pooler were heard by no listener, and a lock taken twice by two clients was given to both.
  Those three must connect to Postgres itself.

Not tried: Vercel's `attachDatabasePool`, which its page says "ensures idle connections are
closed before suspension". The web app does not use it. If idle connections to the pooler cause
trouble, it is the first thing to look at.

## Settings on Vercel

Set these in the project's environment variables, for Production. `docs/settings.md` says what
each is.

| Setting                                                    | Value                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                             | The pooler's address, `?sslmode=verify-full`                                                |
| `S3_ENDPOINT`                                              | The S3 store's tunnel address, `https://…`                                                  |
| `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | As on your machine                                                                          |
| `BETTER_AUTH_SECRET`                                       | Long and random. **The same value as the sync server's.**                                   |
| `BETTER_AUTH_URL`                                          | The address people use: the Vercel address, or your own domain on it                        |
| `SMTP_URL`, `EMAIL_FROM`                                   | The mail provider's. `EMAIL_FROM` should be an address you may send from                    |
| `SYNC_URL`                                                 | The sync server's public address, `wss://…`. The pages' content policy allows only this one |
| `GRAMMAR_URL`                                              | LanguageTool's tunnel address                                                               |
| `CROSSREF_URL`                                             | Leave unset                                                                                 |
| `MODEL_PROVIDER`, `ANTHROPIC_API_KEY`                      | Leave unset until the owner has decided (`docs/settings.md`)                                |
| `SPIKE`                                                    | **Never set.** It opens an endpoint that compiles LaTeX for anyone                          |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`                       | Set once, the same for every build. See below                                               |

`NODE_ENV` is set by the framework.

**The encryption key.** Next.js's guide to self-hosting says: "By default, a unique encryption
key is generated for each build", and "all instances must use the same encryption key. Otherwise
a Server Function encrypted by one instance cannot be decrypted by another". It must be base64
of 16, 24 or 32 bytes, and is read at build time. Builds made on fresh machines get a new key each
time (`docs/settings.md`), so without it a deploy can break the buttons on pages people already have open (`docs/settings.md`
has the hand test). Make it once, keep it, and do not change it:

```
openssl rand -base64 32
```

Put it in the project's variables for the Production and Preview builds. Rotating it is the
same as a build without one, once.

**`BETTER_AUTH_URL`.** The route handlers that take a posted form refuse it unless its `Origin`
is the origin of `BETTER_AUTH_URL` (`sameOrigin` in `apps/web/lib/server.ts`). If people reach
the app by another name (the `*.vercel.app` one, say) those forms are refused. Give out one
name only.

## The Vercel project

- Root Directory, in the project's settings: `apps/web`. Vercel's page on builds says that by
  default "your build can access files outside of that directory", which the workspace packages
  need. Leave "Include files outside the root directory" on.
- `apps/web/vercel.json` sets the framework, the install command and the region. Vercel's page
  on monorepos shows `installCommand` in the app's own `vercel.json`, with a filter.
  The install is filtered to the web app and what it depends on:
  `pnpm install --frozen-lockfile --filter @paperweave/web...`
- The build is the app's `build` script, which Vercel's page says it uses for Next.js.
  Run from a clean `node_modules` with that install, `pnpm run build` in `apps/web` succeeded.
- Node: the repository needs 22.18 or later (`engines`). Set the project's Node.js version to 22.x
  or later in its settings.
- **A top-level `"services"` key is not used.** It exists: Vercel's page on Services calls it
  Beta, and says that once it is present `functions`, `installCommand`, `buildCommand`,
  `framework` "should be moved into the relevant service". Its page on `vercel.json` does not
  define it. It is for several backends in one project; this is one app.
- Function time: the four routes that read or write a whole archive set `maxDuration` in their
  files (Vercel's page: for the App Router, "a named maxDuration export"). Import and export
  120 seconds, a revision 120, a build's PDF or log 60. Hobby and Pro both default to 300 s with
  Fluid compute, so these are lower, not higher, than what Vercel would allow.
- Region: `iad1` in `apps/web/vercel.json`. Vercel's default is also `iad1`. **Change it to the
  region nearest your machine.** One region only: Hobby is limited to one, and several would put
  some functions far from the database.

**Why the region matters.** A page makes several round trips to the database one after the
other. Each costs a full round trip, so each millisecond between the function and the database
is paid several times on every page. Browsers being far from the region costs one round trip per page. The database
being far costs several. Put the function by the database.

## Migrations

From your machine, against Postgres's own address, not the pooler (`migrate` takes an advisory
lock):

```
DATABASE_URL=postgres://… pnpm --filter @paperweave/server migrate
```

Tried against an empty database: it applied all 25 migrations. Run it before the new web build
goes live, and the sync server and workers are then restarted on the new code. There is no
step on Vercel that migrates.

## The sync server and the workers

On your machine, with the repository checked out at `/opt/paperweave` and `pnpm install
--frozen-lockfile` run in it. A filtered install for the web app does not install them: the
sync server failed to start after one, with its `node_modules` missing.
Node 22.18 or later runs the `.ts` files as they are.

`infra/systemd/` has a unit for each. They are the simplest thing that restarts a service when
its process ends, which `docs/settings.md` says something must do. No Dockerfile was made for
them.

1. Make a user: `useradd --system paperweave`. Add it to the `docker` group (the unit does).
2. `docker build -t paperweave-tex infra/tex`
3. Put the settings in `/etc/paperweave/env`, as `NAME=value` lines, readable by the user only.
   The sync server needs `DATABASE_URL` (direct), the `S3_*` ones, `BETTER_AUTH_SECRET` (the
   same as Vercel's) and, if wanted, `SYNC_PORT`. The workers need `DATABASE_URL` (direct) and
   the `S3_*` ones.
4. `cp infra/systemd/*.service /etc/systemd/system/`, then
   `systemctl daemon-reload && systemctl enable --now paperweave-sync paperweave-workers`.

What was tried, and what was not:

- `systemd-analyze verify` accepted both units. The only complaint was that `/usr/bin/node` does
  not exist on the machine it was run on: change `ExecStart` to where `node` is.
- The two programs were started by hand with the same commands against a database and a store
  made for the test. The worker logged `build worker ready` and the sync server logged
  `sync server listening`.
- **The units themselves were not started:** the machine had no systemd running.

To put a new version in place: update the checkout, migrate, then `systemctl restart
paperweave-sync paperweave-workers`. A second sync server waits for the first (`docs/settings.md`),
so a new one may also be started before the old one is stopped.

## Large uploads and downloads

Vercel's page on function limits says: "The maximum payload size for the request body or the
response body of a Vercel Function is **4.5 MB**. The response body limit doesn't apply to
streamed responses." Over it, the function "will return an error 413: `FUNCTION_PAYLOAD_TOO_LARGE`".
This app allows a ZIP up to 100 MB and a file up to 50 MB (`packages/server/src/archive.ts`), so
none of those bytes pass through a function in one piece. Vercel's own advice (its page on
bypassing the limit) is to upload "directly to a media host from your browser" and to make assets
"retrievable with a pre-signed URL". That is what is done. The store stays private: only an
address signed by the app reads or writes it, and each is good for minutes.

- **Uploads** (a ZIP to import; a file added to a paper). The form asks `POST /api/uploads` for
  an address (`kind`, and for a file the paper, and the file's size). The app checks the person
  may do it (anyone signed in for a ZIP; someone who may write to the paper for a file) and that
  the size is within the limit, and returns a signed `PUT` address for a new key `tmp/<uuid>`
  that is good for 10 minutes and takes a body of exactly that size, and the key. The browser
  `PUT`s the file there, then posts the form to `/api/projects/import` or `/projects/[id]/files`
  with only the key and the file's name. That route asks the store for the object's size first and
  refuses one over the limit without reading it; then it runs the same code as before (`importZip`,
  `createFile`: the same checks, a hostile archive refused as a whole) and deletes the temporary
  object, whether or not that worked.
  - The old way is still there, and is what the forms do for a file of 4 MB or less
    (`apps/web/app/DirectUpload.tsx`): a form posted with the file in it (`zip`, `file`) is taken,
    with its `bounded()` cap. So does a browser without scripts. On Vercel that works up to 4.5 MB
    only.
  - **Objects nobody took** (the person closed the page after the `PUT`) are removed by the
    workers, which every hour delete what is under `tmp/` and over a day old (`apps/workers/src/main.ts`).
- **Downloads of one stored file** (a revision's PDF, a build's PDF and log). After the permission
  check the app asks the store for the file's size. At most 4 MB: sent from the app as before. Over
  that: a `303` to an address signed for 5 minutes, which makes the store answer with the paper's
  file name (`response-content-disposition`, `inline` for a build's PDF) and type. The pages'
  content policy names the store in `connect-src` so that the PDF pane's fetch follows it
  (`apps/web/proxy.ts`).
- **Downloads built from many files** (the paper's export, a revision's ZIP) are streamed: the
  ZIP is written to the response as it is made, not held and sent whole. The bytes are the same.
  (The files going into it are still read into the function's memory, one paper at a time.)

### Making the store reachable from browsers

Browsers now reach the store, so it needs an address they can use, and CORS.

- `S3_PUBLIC_ENDPOINT` is the store's address as browsers reach it, when that is not what the app
  uses (`S3_ENDPOINT`). On Vercel both are the tunnel's address, so it can stay unset. Signed
  addresses are made for this host, so a tunnel must pass the `Host` it was reached by on to the
  store. The app's own routes (`/api/uploads`, the downloads) need nothing else.
- **CORS.** The store must answer the web app's origin (`BETTER_AUTH_URL`'s) for `PUT` and `GET`
  and `HEAD`, allow the headers the request carries (`content-type`; pdf.js also sends `range`),
  and let the browser read `content-length`, `content-range` and `etag`.
  - SeaweedFS (as in `infra/compose.yaml`): the server's flag `-s3.allowedOrigins=https://your.app`.
    With the flag unset it is `*`, which also works but allows every site to try (it still cannot
    do anything without a signed address). The compose file lists the two local origins. It answers
    `GET, PUT, POST, DELETE, HEAD` and reflects the request's headers; tried with `OPTIONS` on
    version 4.54: an allowed origin gets `200` with `Access-Control-Allow-Origin` set to it, and
    any other `403`.
  - Amazon S3, R2 and others: the bucket's CORS rule, for example `AllowedOrigins` the app's
    origin, `AllowedMethods` `GET`, `PUT`, `HEAD`, `AllowedHeaders` `*`, `ExposeHeaders`
    `Content-Length`, `Content-Range`, `ETag`. Not tried here.
- **The bucket is never made public.** The local store in `infra/compose.yaml` has no identities
  and takes any request, signed or not. That is for local work only; production must have a
  store that checks signatures. Tried against a SeaweedFS started with `-s3.config` holding one
  identity: it refused a read with no signature and a `PUT` whose body was not the signed length.
  An expired address was not tried.

### What still goes through a function

- **Pictures and chart images** (`/projects/[id]/picture`, `…/pictures`, a chart's PNG) are still
  read into memory and sent whole. One over 4.5 MB fails on Vercel.
- **A paper's import still reads the whole ZIP into one function**, and a paper that is exported
  still reads its files into one function's memory. 100 MB and 300 MB are inside the memory Vercel
  gives a function, but not tried there.
- Anything else that sends more than 4.5 MB through a function.

Not tried on Vercel at all: everything on this page that needs a Vercel project. The build, the
pooler, the migrations and the two services were tried on one machine, and so were the signed
uploads and downloads, against a SeaweedFS on that machine.

## Pages read

- https://vercel.com/docs/project-configuration/vercel-json
- https://vercel.com/docs/services and https://vercel.com/docs/services/config-reference
- https://vercel.com/docs/monorepos and https://vercel.com/docs/builds/configure-a-build
- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/functions/configuring-functions/duration
- https://vercel.com/docs/functions/configuring-functions/region
- https://vercel.com/guides/connection-pooling-with-serverless-functions
- https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions
- https://nextjs.org/docs/app/guides/self-hosting
- https://nextjs.org/docs/app/api-reference/file-conventions/proxy
- https://nextjs.org/docs/app/api-reference/functions/after
- https://developers.cloudflare.com/network/websockets/
