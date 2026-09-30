# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/spencercnorton/lock-screen-suite/security/advisories/new)**.
Do not open a public issue, and do not include real credentials, your location or
personal paths in the report — a description and a minimal reproduction are enough.

There is no e-mail address for security reports; the advisory form is the
only channel, and it is the one that is monitored. You will get an
acknowledgement within a week. Fixes ship as a tagged release; the advisory
is published once the release is out, and credits you unless you ask
otherwise.

## Supported versions

Only the latest tagged release is supported.

## What the extension does

- It runs inside GNOME Shell's unlock dialog and restyles it. GNOME still owns
  the lock, the password prompt and authentication; the extension never sees
  a password.
- It reads the wallpaper images you choose and stores its settings and the
  last weather result in dconf.
- Network: the forecast for your chosen coordinates from
  `api.open-meteo.com`, and, only when you search in preferences, the place
  search at `geocoding-api.open-meteo.com`. No key or account is involved,
  and it never looks your location up by itself.
