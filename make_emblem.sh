#!/usr/bin/env bash
# make_emblem.sh — crop the round "Capuchin" emblem out of the full logo art
# (1408x768) and resize it to a square PNG for use as an app icon / favicon /
# brand mark.
#
# NOTE: the webapp does NOT load this PNG at runtime. The emblem is embedded as
# a base64 data URI in the `.brand-logo` rule in Styles.html. Pass --embed to
# regenerate that data URI from a freshly-cropped emblem after changing the art.
#
# Usage:
#   ./make_emblem.sh [-s SRC] [-z SIZE] [-o OUT] [--embed]
#
# Options:
#   -s, --src   Source logo PNG      (default: logo/Logo_Candidate_3.png)
#   -z, --size  Output square size px (default: 96)
#   -o, --out   Output emblem PNG    (default: logo/capuchin_emblem.png)
#       --embed Also replace the data URI in Styles.html with the new emblem
#   -h, --help  Show this help
#
# The crop window (CROP, below) is fixed to the green circle's bounding box in
# the 1408x768 source art. Override it via the CROP env var if the art changes.
set -euo pipefail

CROP="${CROP:-700x700+354+34}"   # WxH+X+Y bounding box of the green circle
SRC="logo/Logo_Candidate_3.png"
SIZE=96
OUT="logo/capuchin_emblem.png"
STYLES="Styles.html"
EMBED=0

while [ $# -gt 0 ]; do
  case "$1" in
    -s|--src)  SRC="$2";  shift 2;;
    -z|--size) SIZE="$2"; shift 2;;
    -o|--out)  OUT="$2";  shift 2;;
    --embed)   EMBED=1;   shift;;
    -h|--help) grep '^#' "$0" | grep -v '^#!' | sed -e 's/^#//' -e 's/^ //'; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

# ImageMagick v7 ships `magick`; v6 ships `convert`.
if command -v magick  >/dev/null 2>&1; then IM=magick
elif command -v convert >/dev/null 2>&1; then IM=convert
else echo "ImageMagick not found (need 'magick' or 'convert')." >&2; exit 1; fi

[ -f "$SRC" ] || { echo "Source not found: $SRC" >&2; exit 1; }

# -strip removes timestamps/metadata so regenerating gives byte-identical output.
"$IM" "$SRC" -crop "$CROP" +repage -resize "${SIZE}x${SIZE}" -strip "$OUT"
echo "Wrote $OUT (${SIZE}x${SIZE}) from $SRC  [crop $CROP]"

if [ "$EMBED" = "1" ]; then
  [ -f "$STYLES" ] || { echo "$STYLES not found; cannot embed." >&2; exit 1; }
  # base64 on macOS (BSD) and Linux (GNU) both accept stdin; strip any newlines.
  B64="$(base64 < "$OUT" | tr -d '\n')"
  python3 - "$STYLES" "$B64" <<'PY'
import re, sys
path, b64 = sys.argv[1], sys.argv[2]
css = open(path).read()
new, n = re.subn(r'url\(data:image/png;base64,[^)]*\)',
                 'url(data:image/png;base64,' + b64 + ')', css)
if n != 1:
    sys.exit("Expected exactly 1 data URI in %s, found %d" % (path, n))
open(path, 'w').write(new)
print("Embedded emblem into %s (.brand-logo data URI updated)" % path)
PY
fi
