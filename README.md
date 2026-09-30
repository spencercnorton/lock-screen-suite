<h1 align="center">Lock Screen Suite</h1>

<p align="center">
  <strong>A lock screen worth looking at: your wallpapers, a big clock and the weather.</strong><br>
  A GNOME Shell extension that gives the lock screen a wallpaper per monitor with blur and dim, its own clock layout, and the current weather with an animated icon.
</p>

<p align="center">
  <a href="https://github.com/spencercnorton/norvi-os"><img alt="Part of NorviOS" src="https://img.shields.io/badge/NorviOS-component-FD8024.svg"></a>
  <a href="https://github.com/spencercnorton/lock-screen-suite/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/spencercnorton/lock-screen-suite/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/spencercnorton/lock-screen-suite/tags"><img alt="Latest release" src="https://img.shields.io/github/v/tag/spencercnorton/lock-screen-suite?label=release&sort=semver"></a>
  <a href="#install"><img alt="Install for GNOME Shell" src="https://img.shields.io/badge/install-GNOME%20Shell-4a86cf.svg"></a>
  <a href="LICENSE"><img alt="Licence" src="https://img.shields.io/badge/licence-GPL--3.0--or--later-blue.svg"></a>
  <a href="https://buy.stripe.com/8x26oH2U44f65TRe574wM04"><img alt="Donate" src="https://img.shields.io/badge/donate-Stripe-635bff.svg?logo=stripe&logoColor=white"></a>
</p>

<p align="center">
  <img alt="The NorviOS lock screen: a large clock with seconds, the date, and the current weather over a softened wallpaper." src="https://raw.githubusercontent.com/spencercnorton/norvi-os/main/docs/screenshots/lock-screen.png" width="700">
</p>

The screenshot is the [NorviOS](https://github.com/spencercnorton/norvi-os) lock screen on a fresh Ubuntu 26.04 virtual machine with a demo account and a generated wallpaper.

Lock Screen Suite restyles GNOME Shell's unlock dialog without replacing it: GNOME still owns the lock itself, the password prompt and the notifications. It supports GNOME Shell 48, 49 and 50.

## What it does

**A wallpaper per monitor.** Pick an image for each of up to four monitors, with a blur radius and a dim level, or leave a monitor on the system lock-screen wallpaper.

**Its own clock.** Twelve- or 24-hour time with optional seconds and date, in the size, weight, colour, letter spacing and date format you choose.

**The current weather.** Temperature and conditions with an animated icon, refreshed on an interval you set, from [Open-Meteo](https://open-meteo.com/). The last result is cached, so the lock screen has something to show as soon as the machine wakes.

**Your location stays yours.** The weather is fetched only for a place you pick from a search in the preferences, or for latitude and longitude you enter. The extension never looks your location up by itself, and the lock screen makes no request other than the forecast.

## Install

### GNOME Shell — the release zip

Download `lock-screen-suite.shell-extension.zip` and `SHA256SUMS.txt` from the [latest release](https://github.com/spencercnorton/lock-screen-suite/releases/latest), then:

```bash
sha256sum --check --ignore-missing SHA256SUMS.txt
gnome-extensions install --force lock-screen-suite.shell-extension.zip
```

Log out and back in once so GNOME Shell sees the new extension, then enable it and choose a place for the weather:

```bash
gnome-extensions enable lock-screen-suite@spencercnorton.github.io
gnome-extensions prefs lock-screen-suite@spencercnorton.github.io
```

### Ubuntu 26.04 — the release package

The same release carries `gnome-shell-extension-lock-screen-suite_*_all.deb`, which installs the extension for every user and its settings schema system-wide: `sudo apt install ./gnome-shell-extension-lock-screen-suite_*_all.deb`. Then log out and in and enable it as above.

## Documentation

- [CHANGELOG.md](CHANGELOG.md): one entry per release
- [NOTICE](NOTICE): provenance, artwork and data credits

## Where your data lives

| Path | Purpose |
|---|---|
| dconf `/org/gnome/shell/extensions/lock-screen-suite/` | Your settings, the chosen place and its coordinates, and the last weather result |

The only network requests are the forecast for your chosen coordinates, and the place search when you use it in preferences, both to Open-Meteo.

## Contributing and support

- Bugs and feature requests: [open an issue](https://github.com/spencercnorton/lock-screen-suite/issues/new/choose). Questions: [Discussions](https://github.com/spencercnorton/lock-screen-suite/discussions).
- Security reports: [private vulnerability reporting](https://github.com/spencercnorton/lock-screen-suite/security/advisories/new). See [SECURITY.md](SECURITY.md). There is no e-mail address; that is deliberate.
- Pull requests are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first. Changes are reviewed and merged on GitHub, then shipped in tagged releases.
- If this saves you time, you can [support its development](https://buy.stripe.com/8x26oH2U44f65TRe574wM04).

## Development

```bash
python3 -m unittest discover -s tests      # what CI runs, with tests/static-check.py
python3 tests/static-check.py
scripts/build.sh                           # the release zip and .deb, into dist/
```

## Licence

[GPL-3.0-or-later](LICENSE) © Spencer Norton

Weather data by [Open-Meteo.com](https://open-meteo.com/), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
