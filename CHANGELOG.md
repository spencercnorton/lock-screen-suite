# Changelog

All notable changes to Lock Screen Suite are documented here.

## 2.0.0 — 2026-09-30

The first public release.

- A lock-screen wallpaper per monitor with blur and dim, a configurable clock, and the current weather with an animated icon.
- The weather location comes only from a place search in preferences or coordinates you enter. The automatic IP lookup is gone, and so is its setting.
- The weather row appears only once a place is chosen. A place change costs one request, and a lock within the refresh interval reuses the cached forecast instead of fetching again.
- Open-Meteo is credited in preferences for the forecasts and the place search, with a link to the CC BY 4.0 licence.
- Eased icon animations, and a moon drawn at its real phase. Each animation runs only while its icon is on screen, pauses while the monitors are off, and stops when the icon is replaced; the clock stops updating behind dark monitors too.
- Self-sized clock and weather labels never drop their last glyph.
- The UUID is `lock-screen-suite@spencercnorton.github.io`.
