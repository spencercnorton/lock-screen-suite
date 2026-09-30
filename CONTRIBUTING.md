# Contributing to Lock Screen Suite

Thanks for your interest. This is a small project with one maintainer, so the
process is deliberately light.

## How changes land

GitHub is the development home. Branch from `main` and open a pull request
into `main`. The checks must pass before merge. Changes ship in tagged
releases.

Use a GitHub noreply address for commit authorship if you prefer to keep your
personal address private. Public history is public data.

## Working on the code

```bash
python3 -m unittest discover -s tests   # what CI runs
scripts/build.sh                    # build the release zip and .deb
```

- Test a change on a real lock screen, and say which GNOME Shell version in the
  pull request. Lock the screen with Super+L; a mistake there shows up only
  on the lock screen.
- Keep a change to one concern.
- Commits carry a `Signed-off-by:` line (`git commit -s`, the Developer
  Certificate of Origin). There is no CLA.
- No secrets, hostnames, personal data or personal paths in the diff; the
  privacy check rejects them.

## Out of scope

- Replacing the unlock dialog or anything that authenticates.
- Looking the location up automatically; the user chooses the place.

## Pull request checklist

- [ ] `python3 -m unittest discover -s tests` and `python3 tests/static-check.py` pass
- [ ] Tested in GNOME Shell (say which version)
- [ ] Commits are signed off
- [ ] `CHANGELOG.md` updated under `## Unreleased` if behaviour changed
