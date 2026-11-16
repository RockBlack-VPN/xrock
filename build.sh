#!/bin/sh
# Сборка xrock: бинарники под Entware (arm64/mips/mipsel) + архив с установщиком.
# Использование: ./build.sh [версия]
set -e
cd "$(dirname "$0")"
VER="${1:-$(grep -m1 '^const version' src/*.go | sed 's/.*"\(.*\)".*/\1/')}"
DIST="dist"
rm -rf "$DIST"
mkdir -p "$DIST"
cd src

targets="arm64:mips:mipsle"
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

cd ..
# архив: бинарник + установщик + README (как xray-selector)
STAGE="$DIST/stage"
mkdir -p "$STAGE/xrock"
cp "$DIST/xrock-arm64"  "$STAGE/xrock/xrock-arm64"
cp "$DIST/xrock-mips"   "$STAGE/xrock/xrock-mips"
cp "$DIST/xrock-mipsel" "$STAGE/xrock/xrock-mipsel"
cp src/packaging/install.sh "$STAGE/xrock/install.sh"
cp README.md "$STAGE/xrock/README.md"
chmod +x "$STAGE/xrock/install.sh"
(cd "$STAGE" && tar czf "../xrock-$VER.tar.gz" xrock)
rm -rf "$STAGE"
echo "готово: dist/xrock-$VER.tar.gz"
ls -la "$DIST"
