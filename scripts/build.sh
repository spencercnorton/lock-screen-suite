#!/usr/bin/env bash
# Build the release assets from this tree: the extension zip that
# `gnome-extensions install` takes (with compiled schemas, which a per-user
# install needs), and a Debian package that installs the extension
# system-wide with its schema in the system schema directory.
# Reproducible under SOURCE_DATE_EPOCH.
#   scripts/build.sh [out-dir]      (default: dist/)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=$(realpath -m "${1:-$root/dist}")
pkg=gnome-shell-extension-lock-screen-suite
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$root/metadata.json" "$1"; }
version=$(field version-name)
uuid=$(field uuid)
stamp=${SOURCE_DATE_EPOCH:-$(git -C "$root" log -1 --format=%ct 2>/dev/null || date +%s)}
export SOURCE_DATE_EPOCH="$stamp"
mkdir -p "$out"

stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
cp "$root"/*.js "$root/metadata.json" "$root/stylesheet.css" "$stage/"
mkdir -p "$stage/icons/weather" "$stage/schemas"
cp "$root"/icons/weather/*.svg "$stage/icons/weather/"
cp "$root"/schemas/*.gschema.xml "$stage/schemas/"
glib-compile-schemas "$stage/schemas"
find "$stage" -exec touch -h -d "@$stamp" {} +
(cd "$stage" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | TZ=UTC zip -qX "$out/lock-screen-suite.shell-extension.zip" -@)

(cd "$root" && dpkg-buildpackage -us -uc -b)
# No grep -q below: it exits at the first match, dpkg-deb dies of SIGPIPE, and
# pipefail turns a good package into a failed build.
mv "$root/../${pkg}_${version}_all.deb" "$out/"
rm -f "$root/../${pkg}_${version}"_*.buildinfo "$root/../${pkg}_${version}"_*.changes
dpkg-deb -c "$out/${pkg}_${version}_all.deb" | grep -F "usr/share/gnome-shell/extensions/$uuid/extension.js" >/dev/null
dpkg-deb -c "$out/${pkg}_${version}_all.deb" | grep -F "usr/share/glib-2.0/schemas/org.gnome.shell.extensions.lock-screen-suite.gschema.xml" >/dev/null
ls -l "$out"
