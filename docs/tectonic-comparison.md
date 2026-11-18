# Tectonic compared with the TeX Live toolchain

The spec asks for Tectonic to be compared on the same fixtures once the baseline works. This is
that comparison. **Recommendation: stay with TeX Live and latexmk.** Tectonic is smaller and
simpler to ship, but on these papers it changes how one of them looks and cannot build another.

Run on one machine with `infra/tectonic/compare.sh`, which builds each fixture with both
engines and with no network, and prints the table below. Tectonic 0.15.0, from its release
binary, pinned by checksum in `infra/tectonic/Dockerfile`. TeX Live is the image the service
uses (`infra/tex`: TeX Live 2022 from Debian, pdfLaTeX through latexmk).

## What came out

| Paper            | Engine            | Built | Seconds | Pages | Words |
| ---------------- | ----------------- | ----- | ------- | ----- | ----- |
| `article-basic`  | TeX Live, latexmk | yes   | 1.3     | 2     | 289   |
| `article-basic`  | Tectonic          | yes   | 1.4     | 2     | 289   |
| `ieee-multifile` | TeX Live, latexmk | yes   | 1.0     | 1     | 420   |
| `ieee-multifile` | Tectonic          | yes   | 1.5     | 1     | 412   |
| `ams-multifile`  | TeX Live, latexmk | yes   | 3.3     | 1     | 240   |
| `ams-multifile`  | Tectonic          | no    |         |       |       |

Neither engine left an unresolved reference or citation (`??`) in a paper it built. Times are
of one run each and include starting the container; read them as "about the same".

## What differs

- **The IEEE paper looks different.** Built with pdfLaTeX it is set in Times (Nimbus Roman),
  with section headings in small capitals, as the IEEEtran class intends. Built with Tectonic
  it is set in Latin Modern and the headings are in ordinary capitals and lower case. Tectonic
  is built on XeTeX, and this class chooses its fonts differently there. The page count is the
  same and the words are the same apart from the headings, but it is not the paper a
  conference that asks for pdfLaTeX expects.
- **The AMS paper does not build.** It uses biblatex with Biber. Tectonic runs BibTeX itself
  but calls an external `biber`, which is not part of it and would have to be supplied in a
  version that matches the biblatex in its bundle.
- **It needs the network the first time.** Tectonic fetches each TeX file a paper needs when
  it first needs it (324 files, 45 MB, for these three papers). The service builds with no
  network at all, on purpose. To use Tectonic that way, every file any paper might need would
  have to be fetched ahead and kept in the image, and a paper that used something not fetched
  would fail.
- **Size.** The Tectonic image is 0.22 GB, plus what it fetches. The TeX Live image is
  1.5 GB.
- **SyncTeX.** Tectonic writes a SyncTeX file when asked. Whether it works with the
  source-to-PDF navigation here has not been tried.

## Not tried

- Error messages. The service reads pdfLaTeX's log for errors with their file and line.
  Tectonic reports errors in its own format, which is not read.
- Reproducible output. TeX Live builds here are stamped with the revision's time so that the
  same revision gives the same bytes. Whether Tectonic's output can be held as still was not
  checked.
- XeLaTeX and LuaLaTeX papers. The fixtures are all pdfLaTeX papers. A paper written for
  XeLaTeX might suit Tectonic better than these do.
- The three templates. They are close to the fixtures; the IEEE one would show the same
  difference.

## Why stay

A paper must come out as its authors and their venue expect. For pdfLaTeX papers, which the
fixtures and all three templates are, TeX Live gives that and Tectonic does not always. The
size of the image is a cost paid once per machine; a paper that looks wrong is a cost paid
by an author at a deadline. Tectonic would be worth another look as an extra choice of
compiler for papers written for XeLaTeX, once the need for the network is dealt with.
