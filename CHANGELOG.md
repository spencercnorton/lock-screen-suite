# Changelog

All notable changes to Lock Screen Suite are documented here.

## 2.2.0 — 2026-10-15

- The atmosphere moves in with the clock. Instead of a full-screen layer on every monitor, the weather now lives in a bounded stage around the clock cluster on the primary monitor, and the cluster itself is an invisible box in the scene: rain splashes on its roof, rolls to a corner, and drips off; snow settles on the roof and melts; clouds and their shadows drift behind and above it; fog gathers at its base; lightning lights the stage rather than the whole room. Sky placement (stars, moon, glow, clouds) is now sampled inside the stage's own rectangle. Other monitors keep the graded wallpaper only.
- Waking to the password prompt no longer lags behind the weather: the per-frame redraw damages only the stage rectangle instead of every monitor, particle counts drop by roughly an order of magnitude, positions update at 30fps, and the animation loop pauses outright while the prompt is up.

## 2.1.1 — 2026-10-14

Packaging fix for the 2.1.0 tag: adds the missing `debian/changelog` entry so the release pipeline can build the package. No functional change from 2.1.0.

## 2.1.0 — 2026-10-14

- The animated weather icon is replaced by a full-screen atmosphere: rain slanted by the real wind, drifting snow, ground fog, clouds and their shadows, and a starfield with the moon at its real phase, across every monitor between the blurred wallpaper and the clock.
- Stars, the moon, sun glow, and clouds are placed only in sky detected in the wallpaper itself, computed once per wallpaper and cached; a wallpaper with no visible sky gets no stars on its trees. Night scenes dim the wallpaper by an amount measured from that sky.
- The weather row is now a slim line — symbolic icon, temperature, condition, and today's high and low (one extra field in the same Open-Meteo request, along with the wind direction the fetch always asked for but never stored).
- The wallpaper is graded per condition on top of your own blur and dim settings (cooler for rain, softer for fog), the atmosphere quiets while the password prompt is up, and density, grading, and lightning each have their own switch. The bundled weather artwork is gone; the icon is the theme's symbolic one.

## 2.0.0 — 2026-09-30

The first public release.

- A lock-screen wallpaper per monitor with blur and dim, a configurable clock, and the current weather with an animated icon.
- The weather location comes only from a place search in preferences or coordinates you enter. The automatic IP lookup is gone, and so is its setting.
- The weather row appears only once a place is chosen. A place change costs one request, and a lock within the refresh interval reuses the cached forecast instead of fetching again.
- Open-Meteo is credited in preferences for the forecasts and the place search, with a link to the CC BY 4.0 licence.
- Eased icon animations, and a moon drawn at its real phase. Each animation runs only while its icon is on screen, pauses while the monitors are off, and stops when the icon is replaced; the clock stops updating behind dark monitors too.
- Self-sized clock and weather labels never drop their last glyph.
- The UUID is `lock-screen-suite@spencercnorton.github.io`.
