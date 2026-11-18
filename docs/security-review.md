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
| Dependencies                                                              | `pnpm audit --prod`                                                                                      | One advisory, see Open.                                                                                                    |

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
- **A lost connection could lock the editor as if access had been refused.** Not a hole, but
  it was found the same way: see "A failed ticket fetch is not a refusal" in `docs/status.md`.

## Open

In rough order of how much they matter.

1. **A script policy.** The content policy does not yet restrict scripts, so it does not limit
   what injected script could do if a way to inject one were found. None was found. A strict
   policy needs a nonce on every script the framework emits; that is a change to how pages are
   served and wants its own testing.
2. **An edit can be any size.** The sync server takes an update of up to the WebSocket's own
   limit (100 MB) from anyone who may write to a file, and files have no size limit once they
   are being edited. A member could fill the database. Refusing an oversized edit needs the
   editor to say so and drop it, or it would retry for ever.
3. **Limits on requests in general.** Sign-in links, builds and model reviews are limited.
   Reading pages, checking grammar, drawing charts and importing archives are not, beyond
   needing to be signed in. A proxy in front should limit requests per person.
4. **`picomatch`, one high-severity advisory with no fixed version.** It is in the tree
   through the sign-in library's own development tooling, and is not reached with anything a
   visitor sends. To be looked at again when a fixed version exists.
5. **A PDF opened by itself is shown by the browser's own viewer from this site's address.**
   The PDFs are built here from the paper's LaTeX in the sandbox, so their content is the
   authors'. Serving them from a separate address would remove the question.
6. **The sync ticket names a person, not a file.** It lives for a minute and the sync server
   checks the person's role on the file when it is used, so it grants nothing the person does
   not have. Binding it to the file would be tidier.
7. **Model reviews read text an author did not write.** A passage can contain text meant to
   steer the model. What the model returns can only become a proposed change that quotes the
   passage exactly, or a question, and a person decides on each; it cannot act. Reviewers
   should still read a review's proposals as carefully as anyone else's.
8. **What only a deployment can settle:** TLS and HSTS, the production sandbox (the tests use
   Docker on one machine), where the object store and its backups live, retention at the
   model provider, and who can read the metrics page. These wait on the hosting decision.
