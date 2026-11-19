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
| Parse a 150 KB file | 9.98 ms | 500 ms |
| Parse it again after one keystroke | 0.08 ms | 100 ms |
| Import a six-file paper | 75.5 ms | 5000 ms |
| Import a paper of 2,000 files | 3.24 s | 60 s |
| Read all its files for their labels | 1.05 s | 30 s |
| Save a revision of the 2,000-file paper | 64.2 ms | 30000 ms |
| Read how its builds stand, as every open editor does every two seconds | 57.7 ms | 2000 ms |
| Download the six-file paper as a ZIP | 31.0 ms | 5000 ms |
| Save one keystroke | 1.56 ms | 50 ms |
| Open a file with 1,000 edits in its log | 2.10 ms | 2000 ms |
| Compact that log | 19.7 ms | 5000 ms |
| Build the paper to a PDF | 1.11 s | 120 s |
| Build it again, nothing changed | 18.0 ms | 5000 ms |
| List a paper's revisions, of 5,000 | 44.1 ms | 2000 ms |
| Read how a paper's builds stand, after 10,000 | 5.69 ms | 2000 ms |
| Check the spelling and grammar of a section | 50.6 ms | 20000 ms |
| Check it again, nothing changed | 4.19 ms | 2000 ms |
| Draw a chart of 200 points to PDF and PNG | 0.76 s | 60 s |

In the browser, from `tests/e2e/spike.spec.ts` on a 150 KB file: a keystroke reaches the
source text within 40 ms and the screen within 150 ms at the 95th percentile, and another
person's edit is on screen within 250 ms. Those are that test's limits; it prints what it
measured on each run.

A paper's page with 5,000 revisions, in a browser, measured once by hand: 183 KB and a
quarter of a second. Before the list of revisions was limited to the newest fifty automatic
ones and those people named: 15.8 MB and 8.4 s (1.6 MB and 0.9 s with 500).

## Not measured

- Many files open at once on one sync server. (Many people in one file is held by a test,
  `sync.sandbox.test`: thirty connections making 600 edits to one file were all saved and
  agreed in about a second, with nothing lost. It is a test of nothing being lost, with a
  loose limit on time, not a measurement of how many people a server can carry.)
- Papers much larger than the fixtures: hundreds of files, or a hundred pages.
- Anything over a real network. Everything here ran on one machine.
- A build queue under load: one worker built one paper at a time here.
