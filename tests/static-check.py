#!/usr/bin/env python3
"""Release invariants that need no GNOME Shell: one version everywhere, the
public UUID everywhere, and an extension.js that parses as an ES module."""
import json, pathlib, re, shutil, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
UUID = "lock-screen-suite@spencercnorton.github.io"
meta = json.loads((ROOT / "metadata.json").read_text())
failures = []

def check(ok, message):
    if not ok:
        failures.append(message)

check(meta["uuid"] == UUID, f"metadata uuid is {meta['uuid']}, not {UUID}")
check(re.fullmatch(r"\d+\.\d+\.\d+", meta.get("version-name", "")), "version-name is not X.Y.Z")
check(all(re.fullmatch(r"\d+", v) for v in meta["shell-version"]), "shell-version must list major versions")
check(meta.get("url") == "https://github.com/spencercnorton/lock-screen-suite", "url is not the public repository")
version = meta.get("version-name", "")
changelog = (ROOT / "CHANGELOG.md").read_text()
check(f"## {version} — " in changelog, f"CHANGELOG.md has no entry for {version}")
deb = (ROOT / "debian/changelog").read_text().splitlines()[0]
check(f"({version})" in deb, f"debian/changelog does not start at {version}")
for line in (ROOT / "debian/install").read_text().splitlines():
    dest = line.split()[-1]
    check(dest == "usr/share/glib-2.0/schemas" or dest == f"usr/share/gnome-shell/extensions/{UUID}"
          or dest.startswith(f"usr/share/gnome-shell/extensions/{UUID}/"),
          f"debian/install installs outside {UUID} and the schema directory")
schema_id = meta.get("settings-schema", "")
schema = ROOT / "schemas" / f"{schema_id}.gschema.xml"
check(schema.is_file(), f"no schema file for settings-schema {schema_id!r}")
if schema.is_file():
    path = "/" + schema_id.replace(".", "/") + "/"
    declared = re.search(r'<schema\b[^>]*\bid="([^"]+)"[^>]*\bpath="([^"]+)"', schema.read_text())
    check(declared is not None and declared.groups() == (schema_id, path),
          f"{schema.name} does not declare {schema_id} at {path}")
check(f"gnome-extensions enable {UUID}" in (ROOT / "debian/control").read_text(), "debian/control names another UUID")

check("unlock-dialog" in meta.get("session-modes", []), "the extension must declare the unlock-dialog session mode")
if shutil.which("node"):
    with tempfile.TemporaryDirectory() as tmp:
        for source in sorted(ROOT.glob("*.js")):
            module = pathlib.Path(tmp, source.stem + ".mjs")
            module.write_text(source.read_text())
            result = subprocess.run(["node", "--check", str(module)], capture_output=True, text=True)
            check(result.returncode == 0, f"{source.name} does not parse: " + result.stderr.strip())
elif "--allow-missing-node" not in sys.argv:
    failures.append("node is not installed, so extension.js was not parsed")

for failure in failures:
    print("FAIL -", failure)
print(f"static check: {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
