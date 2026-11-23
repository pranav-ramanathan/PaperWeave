# TeX Live toolchain for compile jobs, and rsvg-convert with one font family for drawing charts.
# The base image is pinned by digest and the packages come from that Debian release, so the same
# Dockerfile gives the same toolchain.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

# tex-gyre (tgtermes, tgpagella, tgheros ...) is only recommended by texlive-fonts-recommended, and its
# OpenType files (TeX Gyre Termes by name, TeX Gyre Pagella Math) are in fonts-texgyre and
# fonts-texgyre-math, which tex-gyre only recommends; they go under /usr/share/fonts, which fontconfig
# reads already. texlive-humanities: qtree, dramatist, gb4e, linguex.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      latexmk biber \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra \
      texlive-xetex texlive-luatex \
      texlive-publishers texlive-science texlive-fonts-recommended texlive-fonts-extra \
      texlive-bibtex-extra \
      cm-super texlive-plain-generic \
      tex-gyre fonts-texgyre fonts-texgyre-math texlive-humanities \
      texlive-lang-german texlive-lang-french texlive-lang-spanish texlive-lang-italian \
      texlive-lang-portuguese texlive-lang-european texlive-lang-polish texlive-lang-cyrillic \
      librsvg2-bin fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# XeLaTeX finds fonts by name through fontconfig, which does not know the TeX Live font folders.
# Register them and build the cache now, as the root is read-only when jobs run.
RUN printf '<?xml version="1.0"?>\n<fontconfig>\n  <dir>/usr/share/texlive/texmf-dist/fonts/opentype</dir>\n  <dir>/usr/share/texlive/texmf-dist/fonts/truetype</dir>\n</fontconfig>\n' \
      > /etc/fonts/conf.d/09-texlive-fonts.conf \
 && fc-cache -f

# Jobs run as an unprivileged user with a read-only root; only /work and /tmp are writable.
RUN useradd --uid 10001 --no-create-home tex
USER tex
WORKDIR /work
