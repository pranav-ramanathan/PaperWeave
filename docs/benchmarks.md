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
| Parse a 150 KB file | 9.80 ms | 500 ms |
| Parse it again after one keystroke | 0.08 ms | 100 ms |
| Import a six-file paper | 71.2 ms | 5000 ms |
| Import a paper of 2,000 files | 3.02 s | 60 s |
| Download it as a ZIP | 34.0 ms | 5000 ms |
| Save one keystroke | 1.69 ms | 50 ms |
| Open a file with 1,000 edits in its log | 2.45 ms | 2000 ms |
| Compact that log | 27.2 ms | 5000 ms |
| Build the paper to a PDF | 1.05 s | 120 s |
| Build it again, nothing changed | 14.2 ms | 5000 ms |
| Check the spelling and grammar of a section | 47.2 ms | 20000 ms |
| Check it again, nothing changed | 3.41 ms | 2000 ms |
| Draw a chart of 200 points to PDF and PNG | 0.77 s | 60 s |

In the browser, from `tests/e2e/spike.spec.ts` on a 150 KB file: a keystroke reaches the
source text within 40 ms and the screen within 150 ms at the 95th percentile, and another
person's edit is on screen within 250 ms. Those are that test's limits; it prints what it
measured on each run.

## Not measured

- Many people in one file at once, or many files open at once on one sync server.
- Papers much larger than the fixtures: hundreds of files, or a hundred pages.
- Anything over a real network. Everything here ran on one machine.
- A build queue under load: one worker built one paper at a time here.
