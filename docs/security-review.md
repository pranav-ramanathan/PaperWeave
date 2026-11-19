# Security review

A review of the code as it stands at the end of Phase F, done by reading it and by a few
mechanical checks. It is not a penetration test and nobody outside the project has looked.
What it found is fixed in the same change, or listed under "Open" with what to do.

## What was checked, and how

| Area                                                                      | How                                                                                                      | Result                                                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Every page and route asks who is signed in                                | A script over every `page.tsx` and `route.ts`                                                            | One exception found: the workbench. Fixed.                                                                                 |
| Every route that changes something checks the request came from this site | The same script, over every POST handler                                                                 | The same exception. Fixed.                                                                                                 |
| Who may do what                                                           | Read `authz.ts` and its callers; every server function has a test for viewer, outsider and another paper | Holds. A non-member is told "not found", never "forbidden".                                                                |
| Raw HTML                                                                  | Searched for `innerHTML`, `dangerouslySetInnerHTML` and the like                                         | None. Text reaches the page through React or `textContent`.                                                                |
| Formulas                                                                  | Read the KaTeX options                                                                                   | `trust` is off (no links, no HTML); macro expansion is bounded.                                                            |
| Uploaded files shown back                                                 | Read the picture and download routes                                                                     | Served with `nosniff` and, for pictures, a sandboxing policy; download names are reduced to plain characters.              |
| Archives                                                                  | Read `archive.ts`; its tests feed it hostile ZIPs                                                        | Size, count, path, link and encryption limits, all-or-nothing.                                                             |
| Compiling                                                                 | Read `compile.ts`; its tests try to reach the network and the shell                                      | No network, no shell escape, no capabilities, read-only root, memory, process and time limits; a `latexmkrc` is never run. |
| SQL                                                                       | Read every query built from a string                                                                     | All values are parameters. The three places a name is put into SQL take it from a fixed list.                              |
| Outbound requests                                                         | Read `evidence.ts`, `grammar.ts`, `critique.ts`                                                          | Fixed hosts from configuration; only a DOI, or the text the feature is for, is sent.                                       |
| Sending people elsewhere                                                  | Read `safePath`; a test tries other sites                                                                | Only paths on this site.                                                                                                   |
| Email                                                                     | Read what is sent                                                                                        | Sign-in links, invitations, mentions. A mention carries none of the comment or the text.                                   |
| Logs and metrics                                                          | Searched for logging; read `metrics.ts`                                                                  | IDs, counts and error kinds. Tests seed a secret in a paper and hold that it is on no metrics page.                        |
| Secrets                                                                   | Searched the tree for keys, and the history for environment files                                        | None. `.env*` is ignored; the credentials in `infra/compose.yaml` are for local use and say so.                            |
| Dependencies                                                              | `pnpm audit --prod`, `pnpm audit`                                                                        | None in what the service runs. One in a development tool, see Open.                                                        |

## Found and fixed

- **An endpoint that compiled LaTeX for anyone.** `/api/spike/compile`, left from the Phase B
  editor workbench, took no sign-in and no origin check. The sandbox was the only thing between
  an anonymous visitor and the build machine, and nothing limited how often they asked. The
  workbench page and its endpoint now exist only where the server is started with `SPIKE=1`,
  which the tests set and a deployment must not. A unit test holds the switch.
- **No security headers.** Every answer now carries `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, a policy with
  `frame-ancestors 'none'; base-uri 'self'; form-action 'self'`, and a permissions policy that
  turns off camera, microphone and location. A browser test holds them.
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

## Open

In rough order of how much they matter.

1. **Limits on requests in general.** What costs most is limited: sign-in links (five a
   minute for a client, ten an hour to an address), builds (120 an hour for a paper), chart
   drawings (120 an hour for a paper), model reviews (30 an hour for a paper), invitations
   (30 an hour for a person), and papers started (100 an hour for a person, which with 300
   MB a paper is what bounds how fast one account can fill the store). Reading pages,
   checking grammar, uploading within a paper's limit and typing are not, beyond needing to
   be signed in. A proxy in front should limit requests per person. There is no limit on
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
