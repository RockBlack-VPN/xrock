#!/bin/sh
# Сборка xrock: бинарники (arm64/mips/mipsel) + архив установки + архив UI для mihomo.
#   dist/xrock-$VER.tar.gz   — бинарники + install.sh + web + README
#   dist/xrock-latest.tar.gz — то же (постоянная ссылка, для самообновления панели)
#   dist/xrock-ui.zip        — только UI (для external-ui-url в config.yaml mihomo)
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"
VER="${1:-$(grep -m1 '^const version' src/*.go | sed 's/.*"\(.*\)".*/\1/')}"
DIST="$ROOT/dist"
rm -rf "$DIST"
mkdir -p "$DIST"

cd "$ROOT/src"
for arch in arm64 mips mipsle; do
  case "$arch" in
    arm64)  out="xrock-arm64" ;;
    mips)   out="xrock-mips" ;;
    mipsle) out="xrock-mipsel" ;;
  esac
  echo "сборка $arch…"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
    go build -trimpath -ldflags="-s -w" -o "$DIST/$out" .
done

# 1. архив установки
STAGE="$DIST/stage/xrock"
rm -rf "$DIST/stage"
mkdir -p "$STAGE"
cp "$DIST/xrock-arm64"  "$STAGE/xrock-arm64"
cp "$DIST/xrock-mips"   "$STAGE/xrock-mips"
cp "$DIST/xrock-mipsel" "$STAGE/xrock-mipsel"
cp "$ROOT/src/packaging/install.sh" "$STAGE/install.sh"
cp "$ROOT/README.md" "$STAGE/README.md"
cp -r "$ROOT/src/web/." "$STAGE/web/"
chmod +x "$STAGE/install.sh"
(cd "$DIST/stage" && tar czf "$DIST/xrock-$VER.tar.gz" xrock)
cp "$DIST/xrock-$VER.tar.gz" "$DIST/xrock-latest.tar.gz"
rm -rf "$DIST/stage"

# 2. архив UI для external-ui-url (файлы в корне zip, как dist.zip у zashboard)
cd "$ROOT/src/web"
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -n "$PY" ]; then
  "$PY" - "$DIST/xrock-ui.zip" <<'PY'
import os, sys, zipfile
dst = sys.argv[1]
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for name in sorted(os.listdir(".")):
        if os.path.isfile(name):
            z.write(name, name)
PY
elif command -v zip >/dev/null 2>&1; then
  zip -q -r "$DIST/xrock-ui.zip" index.html app.css app.js logo.svg manifest.webmanifest
else
  echo "нет python3 и zip — UI-архив не собран" >&2
  exit 1
fi

cd "$ROOT"
echo "готово:"
ls -la "$DIST"
