# TeX Live toolchain for compile jobs. The base image is pinned by digest and the TeX packages come
# from that Debian release, so the same Dockerfile gives the same toolchain.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      latexmk biber \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra \
      texlive-publishers texlive-science texlive-fonts-recommended texlive-bibtex-extra \
 && rm -rf /var/lib/apt/lists/*

# Jobs run as an unprivileged user with a read-only root; only /work and /tmp are writable.
RUN useradd --uid 10001 --no-create-home tex
USER tex
WORKDIR /work
