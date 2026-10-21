#!/usr/bin/env bash
# Builds the LGPL ffmpeg/ffprobe the macOS app bundles (spec §3: no --enable-gpl, no --enable-nonfree, no x264).
# Upstream publishes no LGPL macOS build, so CI builds this from the pinned source tarball. Only system
# frameworks are linked (VideoToolbox for H.264, AudioToolbox, zlib, bzip2); the network protocols are off.
# Usage: build-macos.sh <arm64|x86_64> <output folder>
set -euo pipefail
ARCH="${1:?arch (arm64 or x86_64)}"
OUT="${2:?output folder}"
HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(node -p "require('$HERE/manifest.json').version")"
URL="$(node -p "require('$HERE/manifest.json').source.url")"
SHA="$(node -p "require('$HERE/manifest.json').source.sha256")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -sSfL -o "$WORK/ffmpeg.tar.xz" "$URL"
echo "$SHA  $WORK/ffmpeg.tar.xz" | shasum -a 256 -c -
tar -xf "$WORK/ffmpeg.tar.xz" -C "$WORK"
cd "$WORK/ffmpeg-$VERSION"
CROSS=()
if [ "$ARCH" != "$(uname -m)" ]; then CROSS=(--enable-cross-compile --target-os=darwin); fi
CONFIGURE=(--prefix="$WORK/out" --arch="$ARCH" ${CROSS[@]+"${CROSS[@]}"} --cc=clang
  --extra-cflags="-arch $ARCH -mmacosx-version-min=11.0" --extra-ldflags="-arch $ARCH -mmacosx-version-min=11.0"
  --disable-autodetect --enable-videotoolbox --enable-audiotoolbox --enable-zlib --enable-bzlib
  --disable-network --disable-doc --disable-ffplay --disable-debug --enable-static --disable-shared)
./configure "${CONFIGURE[@]}"
make -j"$(sysctl -n hw.ncpu)"
make install
mkdir -p "$OUT"
cp "$WORK/out/bin/ffmpeg" "$WORK/out/bin/ffprobe" "$OUT/"
cp "$HERE/LGPL-2.1.txt" "$OUT/LICENSE.txt"
{
  echo "FFmpeg $VERSION, built from source for macOS $ARCH by apps/desktop/ffmpeg/build-macos.sh."
  echo "License: GNU Lesser General Public License 2.1 or later (no GPL or non-free components)."
  echo "Source: $URL"
  echo "Source SHA-256: $SHA"
  echo "Build script SHA-256: $(shasum -a 256 "$HERE/build-macos.sh" | cut -d' ' -f1)"
  echo "Configure: ${CONFIGURE[*]}" | sed "s#$WORK#<build>#g"
} > "$OUT/SOURCE.txt"
echo "build-macos: $OUT"
