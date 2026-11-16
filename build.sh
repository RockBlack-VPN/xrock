#!/bin/sh
# Сборка xrock: бинарники (arm64/mips/mipsel) + архив установки + архив UI для mihomo.
#   dist/xrock-$VER.tar.gz   — бинарники + install.sh + web + README
#   dist/xrock-latest.tar.gz — то же (постоянная ссылка, для самообновления панели)
#   dist/xrock-ui.zip        — только UI (для external-ui-url в config.yaml mihomo)
set -e
cd "$(dirname "$0")"
VER="${1:-$(grep -m1 '^const version' src/*.go | sed 's/.*"\(.*\)".*/\1/')}"
DIST="dist"
rm -rf "$DIST"
mkdir -p "$DIST"
cd src

for arch in arm64 mips mipsle; do
  case "$arch" in
    arm64)  out="xrock-arm64" ;;
    mips)   out="xrock-mips" ;;
    mipsle) out="xrock-mipsel" ;;
  esac
  echo "сборка $arch…"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
    go build -trimpath -ldflags="-s -w" -o "../$DIST/$out" .
done

cad=..
# 1. архив установки: бинарники + установщик + UI + README
STAGE="$cad/$DIST/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/xrock"
cp "$cad/$DIST/xrock-arm64"  "$STAGE/xrock/xrock-arm64"
cp "$cad/$DIST/xrock-mips"   "$STAGE/xrock/xrock-mips"
cp "$cad/$DIST/xrock-mipsel" "$STAGE/xrock/xrock-mipsel"
cp "$cad/src/packaging/install.sh" "$STAGE/xrock/install.sh"
cp "$cad/README.md" "$STAGE/xrock/README.md"
cp -r "$cad/src/web" "$STAGE/xrock/web"
chmod +x "$STAGE/xrock/install.sh"
(cd "$STAGE" && tar czf "../xrock-$VER.tar.gz" xrock)
cp "$cad/$DIST/xrock-$VER.tar.gz" "$cad/$DIST/xrock-latest.tar.gz"
rm -rf "$STAGE"

# 2. архив UI для external-ui-url (файлы в корне zip, как dist.zip у zashboard)
cd "$cad/src/web"
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -n "$PY" ]; then
  "$PY" - "$cad/$DIST/xrock-ui.zip" <<'PY'
import os, sys, zipfile
dst = sys.argv[1]
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for name in sorted(os.listdir(".")):
        if os.path.isfile(name) and name != "xrock-ui.zip":
            z.write(name, name)
PY
elif command -v zip >/dev/null 2>&1; then
  zip -q -r "$cad/$DIST/xrock-ui.zip" index.html app.css app.js logo.svg manifest.webmanifest
else
  echo "нет python3 и zip — UI-архив не собран" >&2
  exit 1
fi

cd "$cad"
echo "готово: dist/xrock-$VER.tar.gz, dist/xrock-latest.tar.gz, dist/xrock-ui.zip"
ls -la "$DIST"
