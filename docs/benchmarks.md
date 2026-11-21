# Benchmarks

How long the things people wait for take. Measured by
`apps/workers/src/bench.sandbox.test.ts` on one machine, once, so read them as sizes and not
as promises:
4 cores of Intel(R) Xeon(R) Processor @ 2.10GHz, Node v22.23.4, with the
services of `infra/compose.yaml` on the same machine. The same test runs in CI and fails if
any of these passes its ceiling, which is set far above the measurement so that only a
large slowdown trips it.

| What | Took | Ceiling |
| --- | --- | --- |
| Parse a 150 KB file | 5.47 ms | 500 ms |
| Parse it again after one keystroke | 0.07 ms | 100 ms |
| Import a six-file paper | 76.7 ms | 5000 ms |
| Import a paper of 2,000 files | 3.24 s | 60 s |
| Read all its files for their labels | 1.10 s | 30 s |
| Read a bibliography of 8,000 entries | 0.11 s | 3 s |
| Save a revision of the 2,000-file paper | 76.7 ms | 30000 ms |
| Read how its builds stand, as every open editor does every two seconds | 62.0 ms | 2000 ms |
| Download the six-file paper as a ZIP | 29.3 ms | 5000 ms |
| Save one keystroke | 1.65 ms | 50 ms |
| Open a file with 1,000 edits in its log | 2.27 ms | 2000 ms |
| Compact that log | 23.1 ms | 5000 ms |
| Build the paper to a PDF | 1.06 s | 120 s |
| Build it again, nothing changed | 21.7 ms | 5000 ms |
| List a paper's revisions, of 5,000 | 45.6 ms | 2000 ms |
| Read how a paper's builds stand, after 10,000 | 5.68 ms | 2000 ms |
| Check the spelling and grammar of a section | 54.7 ms | 20000 ms |
| Check it again, nothing changed | 4.21 ms | 2000 ms |
| Draw a chart of 200 points to PDF and PNG | 0.84 s | 60 s |

In the browser, from `tests/e2e/spike.spec.ts` on a 150 KB file: a keystroke reaches the
source text within 40 ms and the screen within 150 ms at the 95th percentile, and another
person's edit is on screen within 250 ms. Those are that test's limits; it prints what it
measured on each run.

A paper whose .bib file holds 8,000 entries and which cites one of them, in a browser,
measured once by hand: the paper's page is 254 KB and loads in 0.4 s. Before the table of
references was limited to what the paper cites, and each entry's line was found by reading
the file from its top: 22.8 MB and 12.1 s (5.9 MB and 1.9 s with 2,000 entries).

A paper's page with 5,000 revisions, in a browser, measured once by hand: 183 KB and a
quarter of a second. Before the list of revisions was limited to the newest fifty automatic
ones and those people named: 15.8 MB and 8.4 s (1.6 MB and 0.9 s with 500).

A PDF read through in the pane, in a browser at a pixel ratio of 2, measured once by hand
with a window of 1440 x 900: 30 pages held 230 MB of canvases and 120 pages 920 MB, since every
page read kept its picture. Now a page that leaves the window lets go of its picture: 15 MB
for either (two pages).

## Not measured

- Many files open at once on one sync server. (Many people in one file is held by a test,
  `sync.sandbox.test`: thirty connections making 600 edits to one file were all saved and
  agreed in about a second, with nothing lost. It is a test of nothing being lost, with a
  loose limit on time, not a measurement of how many people a server can carry.)
- Papers much larger than the fixtures: hundreds of files, or the build time of a hundred pages and typing in such a paper.
- Anything over a real network. Everything here ran on one machine.
- A build queue under load: one worker built one paper at a time here.
