# Security review

A review of the code as it stands at the end of Phase F, done by reading it and by a few
mechanical checks. It is not a penetration test and nobody outside the project has looked.
What it found is fixed in the same change, or listed under "Open" with what to do.

## What was checked, and how

| Area                                                                      | How                                                                                                      | Result                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every page and route asks who is signed in                                | A script over every `page.tsx` and `route.ts`                                                            | One exception found: the workbench. Fixed.                                                                                                                                                                                                                                                                         |
| Every route that changes something checks the request came from this site | The same script, over every POST handler                                                                 | The same exception. Fixed.                                                                                                                                                                                                                                                                                         |
| Who may do what                                                           | Read `authz.ts` and its callers; every server function has a test for viewer, outsider and another paper | Holds. A non-member is told "not found", never "forbidden". A comment is changed by its author and deleted by its author or the paper's owner; deleting keeps the row, so the mention-email limit is not reset (held by a test).                                                                                   |
| Raw HTML                                                                  | Searched for `innerHTML`, `dangerouslySetInnerHTML` and the like                                         | Three uses of `dangerouslySetInnerHTML`, in `app/layout.tsx`: three constant scripts (no value from a request or a person) that carry the request's nonce. Everything else reaches the page through React or `textContent`.                                                                                        |
| Formulas                                                                  | Read the KaTeX options                                                                                   | `trust` is off (no links, no HTML); macro expansion is bounded.                                                                                                                                                                                                                                                    |
| Uploaded files shown back                                                 | Read the picture and download routes                                                                     | Served with `nosniff`; download names are reduced to plain characters. The two picture routes answer with `default-src 'none'; sandbox`, set in `next.config.ts`. A picture over 4 MB is answered by the store on another origin, with its image type signed into the address and without the route's own headers. |
| Archives                                                                  | Read `archive.ts`; its tests feed it hostile ZIPs                                                        | Size, count, path, link and encryption limits, all-or-nothing, for every file that is read. Entries left out by type are never opened, so only the 50,000-entry and 100 MB bounds apply to them.                                                                                                                   |
| Compiling                                                                 | Read `compile.ts`; its tests try to reach the network and the shell                                      | No network, no shell escape, no capabilities, read-only root, memory, process and time limits; a `latexmkrc` is never run.                                                                                                                                                                                         |
| SQL                                                                       | Read every query built from a string                                                                     | All values are parameters. The three places a name is put into SQL take it from a fixed list.                                                                                                                                                                                                                      |
| Outbound requests                                                         | Read `evidence.ts`, `grammar.ts`, `critique.ts`                                                          | Fixed hosts from configuration; only a DOI, or the text the feature is for, is sent.                                                                                                                                                                                                                               |
| Sending people elsewhere                                                  | Read `safePath`; a test tries other sites                                                                | Only paths on this site: no space, control character or backslash, and the parsed result must still be on this site.                                                                                                                                                                                               |
| Email                                                                     | Read what is sent                                                                                        | Sign-in links, invitations, mentions. A mention carries none of the comment or the text.                                                                                                                                                                                                                           |
| Logs and metrics                                                          | Searched for logging; read `metrics.ts`                                                                  | IDs, counts and error kinds. Tests seed a secret in a paper and hold that it is on no metrics page.                                                                                                                                                                                                                |
| Secrets                                                                   | Searched the tree for keys, and the history for environment files                                        | None. `.env*` is ignored; the credentials in `infra/compose.yaml` are for local use and say so.                                                                                                                                                                                                                    |
| Dependencies                                                              | `pnpm audit --prod`, `pnpm audit`                                                                        | None in what the service runs. One in a development tool, see Open.                                                                                                                                                                                                                                                |

## Found and fixed

- **Comments, invitations and grammar checks had no limit.** Shown with `testDb` and the real
  functions. (1) A reviewer posted 2,000 replies of 5,000 characters in 1.1 s and the owner's
  thread listing became 10.4 MB. Now one person may write 60 comments, replies and proposals on
  a paper in ten minutes (`COMMENTS_PER_USER`) and a paper takes 2,000 a day
  (`COMMENTS_PER_PAPER`), counted from the rows (a deleted comment stays a row); 5,000
  characters a comment was already the cap. Mention emails were already held to 60 an hour for a
  person (the comment is saved). (2) One account sent 30 invitations an hour to one stranger and
  six accounts sent 180. Now one address gets a burst of three and then one an hour, whoever
  sends (`INVITATIONS_PER_ADDRESS_BURST`), and the service sends 200 an hour
  (`INVITATIONS_PER_HOUR`); the per-person 30 stays. (3) 50 simultaneous checks of one
  unchanged file made 50 requests to the checker. Concurrent identical checks now share one
  request, and one person may cause 60 requests to the checker a minute (`GRAMMAR_CHECKS_PER_USER`, migration
  0032); viewers may still check, since they can read all of it. (4) A sign-in `name` could hold
  CR and LF; it is now cleaned of control characters on create and update (nothing sends it in
  a header today). Held by the new sandbox tests; the mention-email test and the test
  fixtures that invite the same addresses over and over were given room on purpose
  (`vitest.config.ts`). **Not covered:** the counts are read then written, so a burst of
  parallel requests can pass a limit by a few.

- **One account could fill the build queue and make everyone wait.** Shown with the real worker:
  100 papers and 100 builds queued in under a second, none refused; two papers of
  `\def\x{\x}\x` each ran the 60 s limit and the next person's 1 s build waited 121 s (100 such
  papers, about 100 minutes). Builds were limited per paper only, taken oldest first, and charts
  were drawn only when no build was queued. Now one person may have 3 builds waiting or running
  and ask for 120 an hour over all papers (`BUILDS_WAITING_PER_USER`, `BUILDS_PER_USER_HOUR`),
  counted under a lock so simultaneous requests cannot pass together; the worker takes the
  build of whoever has had the fewest done in the last hour, and builds and charts take turns.
  The editor's own automatic builds stop 20 short of each hourly limit (`BUILDS_RESERVED_FOR_PRESSED`)
  and are spaced once half the hour is used, so they cannot use up what people press for.
  Service tests hold each and failed on the old code. Still true: accounts share one worker in
  proportion, and a build may run 60 s; more workers are a deployment decision.
- **Sign-in limits could be turned against people and walked around.** Four faults, shown with
  the real handler in production mode. (1) Ten sign-in requests for an address, from any
  clients, refused the owner's own request for most of the hour, because ten per hour were
  counted for the address whoever asked and a link lives 15 minutes. Now one address gets a
  burst of three, then one every six minutes, so whoever is refused has a live link at most six
  minutes old, and there is an hourly cap on all sign-in emails (`SIGN_IN_EMAILS_PER_HOUR`,
  default 500, its own message). (2) With no `x-forwarded-for`, the library put every request in
  one shared bucket per path: five anonymous requests in a minute and an unrelated person was
  refused. (3) A single-value `x-forwarded-for` was believed as sent, so 40 spoofed addresses
  got 40 emails to one address. Now no address is read from a request unless an operator names
  the header their proxy sets (`TRUSTED_IP_HEADER`); without it the library's by-client limit
  is off (no shared bucket, nothing to spoof), with it the count is kept in the database and a
  request without a usable address is not counted. (4) Login CSRF: `/sign-in/confirm?token=` named
  no account, so an attacker's own link, forwarded, would sign a person in as the attacker. The
  page now says which address it signs in (first letter and domain, since anyone holding the
  link can open the page), read without using the token up. Held by `auth.sandbox.test.ts` and
  `projects.spec`. **Not covered:** a person who has the link and the page open is still signed
  in as whoever it names if they press the button without reading.

- **One account could fill the store through upload addresses.** `/api/uploads` took a size only
  if the browser offered one, and `startUpload` signed only `host` otherwise. One new account
  got 300 such addresses; three PUTs of 120 MB each returned 200 against a 100 MB ZIP limit,
  and the 360 MB stayed in `tmp/` until dropped by hand (an address is good for ten minutes and
  could be used again; the sweep ran for objects a day old). Now: `startUpload` requires a
  whole `size` of at least 1 and within the limit for that kind (ZIP or file), and signs it as
  `content-length`, so a store that checks signatures refuses another length. Verified with
  SeaweedFS started with an identity: a PUT of 1001 bytes to an address signed for 1000 is
  refused (403), 1000 is taken. The store in `infra/compose.yaml` has no identities and checks
  no signature, so there it takes any length; the test for the refusal runs only against a
  store that has them (`S3_ENDPOINT`), and an always-run test holds that the length is among
  the signed headers. Each address is recorded (`upload_addresses`, migration 0030): at most 10
  not taken in ten minutes and 2 GiB of declared bytes in an hour per person
  (`UPLOADS_OUTSTANDING_PER_USER`, `UPLOAD_BYTES_PER_USER_HOUR`), and a key is taken once. The
  sweep now removes untaken uploads half an hour after they were put. Not prevented: a second
  PUT to the same address before the take replaces the object (same length only); two requests
  at the very same moment may pass the count together, by a few. Held by
  `uploads.sandbox.test.ts` and `uploading.spec`.
- **Sign-in could send people to another site.** `safePath` only refused a second slash and a
  backslash, so `/<TAB>/evil.example` passed; browsers drop tab, newline and return from an
  address, so it became `//evil.example`. Both the sign-in page (when already signed in) and the
  emailed confirm page followed it. `safePath` now refuses spaces, control characters and
  backslashes, and the result must parse to a path on this site. Held by `auth.test.ts` and
  `projects.spec`. Other redirects were checked: the rest are built by the server from its own
  paths (`seeOther`, `requireUser`, `act`), never from a request's value.

- **An endpoint that compiled LaTeX for anyone.** `/api/spike/compile`, left from the Phase B
  editor workbench, took no sign-in and no origin check. The sandbox was the only thing between
  an anonymous visitor and the build machine, and nothing limited how often they asked. The
  workbench page and its endpoint now exist only where the server is started with `SPIKE=1`,
  which the tests set and a deployment must not. A unit test holds the switch.
- **No security headers.** Every answer now carries `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, a policy with
  `frame-ancestors 'none'; base-uri 'self'; form-action 'self'`, and a permissions policy that
  turns off camera, microphone and location. A browser test holds them.
- **The picture routes' own policy was never sent.** `picture` and `charts/[chartId]/png` set
  `Content-Security-Policy: default-src 'none'; sandbox` themselves, but a header already on the
  answer wins over a route handler's, and `next.config.ts` and then `proxy.ts` had put one there
  first: the pictures were sent with the page policy. `next.config.ts` now sets the policy for
  those two addresses and the proxy's matcher leaves them out. No SVG or HTML type is served
  (pictures are png, jpg or jpeg, by extension, with `nosniff`), so nothing was exploitable. A
  browser test holds both headers.
- **Upload size was taken on trust.** The upload and import routes compared the request's
  stated length with the limit and then read the whole body. A request that lied, or gave no
  length, was read in full. Bodies are now read with a cap, and reading stops when it is
  passed. The small JSON routes are capped too.
- **Nothing limited how often a paper asked for a model review.** Each request costs money and
  sends text out. A paper may now ask 30 times an hour; a test holds that nothing is sent past
  the limit. (The feature is off unless a deployment and the paper's owner both turn it on.)
- **Pages did not say which scripts may run on them.** Fixed after the first version of this
  review. Every page is now sent with a policy that allows only the scripts this server put
  on it for that request, each marked with a number made up for the request, and what those
  scripts load (`apps/web/proxy.ts`). A script that reached a page some other way would not
  have the number and would not run. The policy also limits where a page may connect (the app
  and the sync server), and allows no plug-ins.
  - A browser test holds that the number is new each time and is on every script of the page.
  - Every browser test now fails if a page is refused anything by its policy. That was tried:
    with the sync server left out of the policy, the first test to open an editor failed.
  - **Style sheets are held to the number too**, since a later change: an injected style sheet
    could read what is on a page and send it away. The editors are handed the number for the
    style sheets they add. The app has its own "nothing here" page, because the framework's
    brings a style sheet the policy refuses.
  - **Not covered:** styles set on a single element. The editors and the maths renderer set
    them as they draw. They can restyle that element, and cannot select or send anything.
  - **Not covered:** a PDF or ZIP asked for by its address, which is not a page.
  - No way to inject a script was found before or after. This limits the damage if one is.
- **An edit could be any size.** The sync server read a message of up to 100 MB from anyone
  who could connect, and took an edit of that size from anyone who could write. Fixed after the
  first version of this review:
  - Nothing over 4 MB is read off the wire. The connection is closed instead.
  - An edit over 2 MB is not saved and not applied.
  - A file's text cannot be made longer than 50 MB by editing, by typing or by a structural
    edit. That is the size of the largest file that can be imported.
  - The editor is told why, stops, says so, and offers to discard the unsaved edits. It does
    not connect again to send the edit again. A service test and a browser test hold all of it.
  - What this does not limit: how often someone edits. See "Limits on requests in general"
    below.
- **A paper's files had no limit on what they added up to.** A paper could be given 2,000
  files of 50 MB each, one upload at a time. Added files are now held to the limit an imported
  paper already had: 300 MB in all. (An earlier version of this review said there was no limit
  on the number of files either. There was: 2,000.)
- **A sync ticket named a person, not a file.** It now names the file too, and the sync server
  refuses it for any other. It granted nothing the person did not have, since their role on
  the file was and is checked when it is used; this is tidiness.
- **A lost connection could lock the editor as if access had been refused.** Not a hole, but
  it was found the same way: see "A failed ticket fetch is not a refusal" in `docs/status.md`.

- **A page left open by one person could carry on as the next person to sign in.** The editor
  asks for a fresh ticket each time it connects, and took whoever was signed in on the browser
  by then. On a shared computer: one person signs out with an editor still open, another signs
  in, the first one's page loses its connection and makes a new one as the second person, and
  what the first had typed and not yet saved is saved under the second's name. The ticket's
  answer now says whom it is for, and a page made for someone else stops. A browser test
  holds it, and fails with the check taken out. On the code before, the order had to be: the
  second person signs in, then the page reconnects. That exact order was not run. It needs
  both people to be on the same paper and the page to be left open.

- **Signing out did not end open editors.** An editor kept its connection to the sync server
  after its person signed out, and went on saving as them until the connection dropped. A
  ticket now names its sign-in, and the sync server closes that sign-in's connections when it
  is deleted. A sign-in that merely runs out is not covered: see "An editor whose sign-in has
  ended" in `docs/status.md`.

- **The browser handed over a paper's PDF without asking the server.** A build's PDF, its
  log and what goes with them were kept by the browser to be used unasked for an hour;
  pictures for a minute. Asked for again at the same address, they came from the browser's
  own copy, whoever was at the browser by then: after "Sign out", after the sign-in had run
  out, after the person had been taken off the paper. On a shared computer that is the next
  person, if they have the address, which the browser's history may hold. Two changes.
  - The browser may still keep these answers, and must now ask before each use
    (`private, no-cache` with an `ETag`; `askedForEachTime` in `apps/web/lib/server.ts`). The
    server sees who is asking and either refuses or says "as you have it", without sending
    the bytes again. This does not depend on how the sign-in ended.
  - The answer to signing out also tells the browser to throw its copies away
    (`Clear-Site-Data: "cache"`, in `apps/web/app/api/auth/[...all]/route.ts`). That part
    rests on the browser acting on the header, and was tried in Chromium only.
  - A browser test holds both: a second request is answered without the PDF being sent again;
    with the sign-in gone and "Sign out" not pressed, the server refuses; and the answer to
    signing out carries the header. It failed on the code before each change.

- **Nothing limited invitations.** Each one is an email from the service to an address the
  sender chose, and anyone can make an account and a paper. One person can now send 30 in an
  hour, over all their papers. The email names the inviter's address and nothing else of
  theirs: not the paper's name.

- **Nothing limited how many sign-in links one address was sent.** The sign-in library limits
  how often one client may ask (five a minute). That is 300 an hour to one inbox from one
  client, and more from several. One address is now sent at most 10 an hour, whoever asks. A
  browser test asks from three clients, each under its own limit, and sees ten emails arrive
  and the rest refused.

- **Someone taken off a paper could put themselves back.** Removing a person deleted their
  place in the paper but not the invitations they had not used: one sent twice left a spare
  link, valid for 14 days, and the person removed (or who had left) could join again with it,
  with the role it named, and nobody's say-so. Removing or leaving now ends a person's unused
  invitations to that paper in the same statement; an owner can see every invitation not yet
  used and cancel it; a second invitation to an address ends the first. A mistyped address no
  longer leaves an owner unable to stop whoever owns it from joining. Service tests hold each,
  and failed on the old code.

- **A mail scanner's fetch used up the sign-in link, and was handed the session.** The emailed
  link signed in on a plain GET. University mail gateways fetch links before delivery: the
  scanner got the session cookie, one session row existed for a person who had not yet seen the
  email, and their own visit found the link used. The email now leads to `/sign-in/confirm`,
  which shows a page and changes nothing; the button posts to a server action, and only that
  calls the library's verify. The library's GET `/api/auth/magic-link/verify` is switched off
  (`disabledPaths`, 404), so an old or crafted link cannot hand a session to a GET. The page
  does not sign in by script (scanners run scripts), is sent `Cache-Control: no-store`, keeps
  `Referrer-Policy: same-origin`, and loads nothing from another site. The token and the link
  are never logged. A service test and a browser test failed on the old code. Not covered: a
  scanner that submits forms.

- **Anyone who could comment could make the service ask the DOI registry without bound.**
  A lookup had no limit, so one person could use up the registry's patience with this service
  for everyone, and the registry was sent no way to reach the operator. The registry's answer
  was read whole, and a redirect was followed to wherever it led. Lookups are now counted
  before they are made (`doi_requests`, as model reviews are): 30 in ten minutes for a person
  and 500 in a day for a paper, set by `DOI_LOOKUPS_PER_USER` and `DOI_LOOKUPS_PER_PROJECT`;
  past either, nothing goes out. A contact address goes in the User-Agent only when an operator
  sets `CROSSREF_MAILTO`. At most 1 MB of the answer is read (and the language checker's is
  held to 8 MB), a redirect is not followed from either, and an answer too large or redirected
  is "could not look up". Service tests hold each, and failed on the old code. The counts are in
  the database, so they hold across processes. Other outbound requests: the object store (own
  timeouts, signed, a host from configuration) and the model provider's library.

- **Build outputs were read by plain path, which follows links.** After latexmk the worker read
  the log, the PDF, SyncTeX, the .bbl, the .fls and every .aux from the build directory, which
  the paper's own files can fill, and a chart's files from its own. Some of those reads had no
  size cap either. All of them go through one helper now, `readOwn`: the path must be inside
  the directory, every folder on the way must be a real folder, the file must be a regular file
  (not a link), it is opened with `O_NOFOLLOW`, and it is read only up to a cap (log 32 MiB, PDF
  256 MiB, SyncTeX 128 MiB, .bbl 5 MB, one .aux 16 MiB, .fls 32 MiB, a chart file 64 MiB). A
  link, a file over its cap, or any error means the output is absent: no log (latexmk's output
  stands in), no PDF (the build fails with the usual diagnostics). The copies into the output
  folder are made by reading and writing, not `cpSync`. Unit tests make the links themselves
  with `symlinkSync` in a temp directory and call `readOwn` directly; builds of ordinary papers
  are unchanged.

## Open

In rough order of how much they matter.

1. **Limits on requests in general.** What costs most is limited: sign-in links (five a
   minute for a client, ten an hour to an address), builds (120 an hour for a paper, and 3 waiting and 120 an hour for a person), chart
   drawings (120 an hour for a paper), model reviews (30 an hour for a paper), invitations
   (30 an hour for a person, a burst of three then one an hour to an address, 200 an hour in all), and papers started (100 an hour for a person, which with 300
   MB a paper is what bounds how fast one account can fill the store). Edits taken over the
   sync connection are now limited by size, for each person over all their files: a burst
   of 20 MB and 2 MB a minute given back, each edit costing at least 512 bytes
   (`SYNC_EDIT_BURST_BYTES`, `SYNC_EDIT_BYTES_PER_MINUTE`), so one account can no longer add
   2 MB edits without pause. It is kept in the sync server's memory, so it starts afresh
   when that restarts, and it counts bytes sent, not what they add up to once compacted.
   Restores and replaced files (by form or by upload), which the web app makes as edits, are
   limited the same way by size, for each person over all their papers: 100 MB an hour, each
   costing the bytes of edits it appends and at least 256 KB (`WEB_EDIT_BYTES_PER_USER_HOUR`),
   kept in the database (`web_edits`), so alternating two restores of a large paper no longer
   gets round the sync budget. Accepting and undoing proposals, renaming labels and renaming
   a file together with the lines that name it are limited the same way, each costing the bytes
   it appends and at least 4 KB; a label rename that would take a file past the 50 MB text limit
   is refused whole. Reading pages, uploading within a paper's limit, imports, creating or
   uploading a new file, deleting, and a rename that only changes a name are not limited this
   way, beyond needing to be signed in. A proxy in front should limit requests per person. There is no limit on
   what one person's papers add up to over time: that is a decision about accounts, not made
   here.
2. **One advisory in a development tool.** `pnpm audit` on 18 November 2026, and again on
   the 19th with the same result, reports nothing in what the service runs
   (`pnpm audit --prod`), and one moderate advisory overall: `minimatch`, through the linter.
   It is not part of the running service and is given only this repository's own file names.
   A fixed version exists (11.0.1) but the linter does not yet take it. An earlier version of
   this review listed a high-severity advisory in `picomatch`; the audit no longer reports it,
   and why it went was not looked into.
3. **A PDF opened by itself is shown by the browser's own viewer from this site's address.**
   The PDFs are built here from the paper's LaTeX in the sandbox, so their content is the
   authors'. Serving them from a separate address would remove the question.
4. **Model reviews read text an author did not write.** A passage can contain text meant to
   steer the model. What the model returns can only become a proposed change that quotes the
   passage exactly, or a question, and a person decides on each; it cannot act. Reviewers
   should still read a review's proposals as carefully as anyone else's.
5. **What only a deployment can settle:** TLS and HSTS, the production sandbox (the tests use
   Docker on one machine), where the object store and its backups live, retention at the
   model provider, and who can read the metrics page. These wait on the hosting decision.
   So do three things found since by running the services as a deployment would, each written
   up in `docs/settings.md`: something must start a service again if its process ends; only
   one sync server may serve a database, which the sync server now sees to itself; and every
   build of the web app should be given the same key for its forms, or a new version breaks
   the buttons on pages people already have open.
