# syntax=docker/dockerfile:1
# Tectonic, for comparing with the TeX Live toolchain in infra/tex. Not used by the service.
# Tectonic fetches the TeX files a paper needs when it first builds it, so building this image
# needs the network; the comparison then runs with none (`--only-cached`).
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

ARG TECTONIC_VERSION=0.15.0
ARG TECTONIC_SHA256=dfb82876f2986862996e564fa507a9e576e0c1e3bee63c2c1bd677c2543e6407
# Behind a proxy that re-signs HTTPS, pass its certificate to the build:
#   docker build --secret id=ca,src=/path/to/ca.crt -t paperweave-tectonic infra/tectonic
RUN --mount=type=secret,id=ca,required=false \
    apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && if [ -s /run/secrets/ca ]; then export CURL_CA_BUNDLE=/run/secrets/ca; fi \
 && curl -fsSL -o /tmp/tectonic.tar.gz \
      "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
 && echo "${TECTONIC_SHA256}  /tmp/tectonic.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic \
 && rm /tmp/tectonic.tar.gz

RUN useradd --uid 10001 --create-home tex
USER tex
WORKDIR /work
