#!/bin/sh
# Build each fixture paper with the TeX Live toolchain the service uses and with Tectonic, and
# print what came out of each as a Markdown table. Usage: infra/tectonic/compare.sh [ca.crt]
# Needs Docker and both images:
#   docker build -t paperweave-tex infra/tex
#   docker build -t paperweave-tectonic infra/tectonic
# Tectonic fetches the TeX files a paper needs the first time it builds it, so each paper is
# built once with the network to fill a cache, and then timed with no network at all. Behind a
# proxy that re-signs HTTPS, give its certificate as the argument.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
fixtures="$here/../../fixtures"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
docker volume create paperweave-tectonic-cache >/dev/null
ca=""
[ -n "${1:-}" ] && ca="-v $1:/ca.crt:ro -e SSL_CERT_FILE=/ca.crt"

# Seconds a command took, to a tenth.
timed() {
  start=$(date +%s.%N)
  # Whether it worked goes to a file: this runs where a variable would not be seen afterwards.
  if "$@" >"$work/log" 2>&1; then echo yes >"$work/ok"; else echo no >"$work/ok"; fi
  end=$(date +%s.%N)
  echo "$start $end" | awk '{ printf "%.1f", $2 - $1 }'
}
# Pages and words of a PDF, read with the tools in the Tectonic image.
facts() {
  docker run --rm --network none -v "$1":/work paperweave-tectonic sh -c \
    'p=$(pdfinfo main.pdf 2>/dev/null | awk "/^Pages:/ {print \$2}"); w=$(pdftotext main.pdf - 2>/dev/null | wc -w); u=$(pdftotext main.pdf - 2>/dev/null | grep -c "??" || true); echo "${p:-0} ${w:-0} ${u:-0}"'
}

echo "| Paper | Engine | Built | Seconds | Pages | Words | Lines with ?? |"
echo "| --- | --- | --- | --- | --- | --- | --- |"
for paper in article-basic ieee-multifile ams-multifile; do
  for engine in texlive tectonic; do
    rm -rf "$work/$engine" && cp -r "$fixtures/$paper" "$work/$engine" && chmod -R a+rwX "$work/$engine"
  done
  seconds=$(timed docker run --rm --network none -v "$work/texlive":/work paperweave-tex \
    latexmk -norc -cd -pdf -no-shell-escape -interaction=nonstopmode -synctex=1 main.tex)
  set -- $(facts "$work/texlive")
  echo "| $paper | TeX Live, latexmk | $(cat "$work/ok") | $seconds | $1 | $2 | $3 |"

  # Once with the network, to fetch what this paper needs. Not timed.
  # shellcheck disable=SC2086
  docker run --rm -v paperweave-tectonic-cache:/home/tex/.cache -v "$work/tectonic":/work $ca \
    --user 0:0 -e HOME=/home/tex paperweave-tectonic tectonic -X compile main.tex \
    >"$work/warm" 2>&1 || true
  rm -f "$work/tectonic/main.pdf"
  seconds=$(timed docker run --rm --network none -v paperweave-tectonic-cache:/home/tex/.cache \
    -v "$work/tectonic":/work --user 0:0 -e HOME=/home/tex paperweave-tectonic \
    tectonic -X compile --only-cached --synctex main.tex)
  set -- $(facts "$work/tectonic")
  echo "| $paper | Tectonic 0.15.0 | $(cat "$work/ok") | $seconds | $1 | $2 | $3 |"
  [ "$(cat "$work/ok")" = yes ] || { echo; echo "Tectonic on $paper said:"; echo; echo '```'; tail -8 "$work/log"; echo '```'; echo; }
done
