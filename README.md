# mixtape

Your YouTube Music listening habits, from the terminal. macOS only.

```
$ mixtape

  Today · Sat 10 Oct

  6 listens  ·  24m listened  ·  1 skipped

  #  Track               Artist             Plays  Time
  1  Feel It Still       Portugal. The Man      3    8m
  2  Speed of Sound      Coldplay               2   10m
  3  Wish You Were Here  Pink Floyd             1    6m
```

- **`mixtape`** / **`mixtape today`**: listens, total listening time, and every song you played today with how many times you played it
- **`mixtape week`**: the last 7 days, with listening time per day and your top tracks and artists
- **`mixtape log`**: every play today in order, including skips
- **`mixtape now`**: what's playing right now
- **`mixtape status`**: whether the recorder is running and where the data lives

`today`, `week` and `log` accept `--date YYYY-MM-DD` (or `yesterday`). `week` uses it as the last day of the 7. Add `--json` to any of them to get the raw data.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/AyushSaini00/mixtape/main/install.sh | bash
```

The script needs [Homebrew](https://brew.sh). It installs `media-control` (and Node, if you don't have 22.13 or newer), installs the latest release of `mixtape` with npm, and starts the recorder as a LaunchAgent, so it runs now and at every login. That's the only setup. You don't need to sign in to YouTube Music, install a browser extension or grant any extra permissions.

If you'd rather run the steps yourself:

```sh
brew install media-control
npm install -g https://github.com/AyushSaini00/mixtape/releases/latest/download/mixtape.tgz
mixtape service install
```

To **update**, run the same `npm install -g` command again, then `mixtape service install` to restart the recorder. To **uninstall**, run `mixtape service uninstall && npm uninstall -g mixtape`. Your history stays in `~/.local/share/mixtape` until you delete it.

The LaunchAgent remembers the Node binary you installed with. If you later remove that Node version, for example with nvm, run `mixtape service install` again.

<details>
<summary>Homebrew formula (needs up-to-date Xcode Command Line Tools)</summary>

```sh
brew tap ayushsaini00/mixtape https://github.com/AyushSaini00/mixtape
brew install mixtape
brew services start mixtape
```

Homebrew builds this formula from source, and it refuses to build anything while the Command Line Tools are out of date.
</details>

## How it works

macOS keeps a system-wide **Now Playing** record: the track shown in Control Center and on the media keys. Chrome publishes YouTube Music's current track there, including title, artist, album, length, position and play/pause state.

`mixtape daemon` (the recorder the LaunchAgent runs) subscribes to that record through [`media-control`](https://github.com/ungive/media-control) and turns it into listen records:

- Only the **YouTube Music app** is tracked, meaning `music.youtube.com` installed as an app from Chrome. Other audio, including YouTube or YouTube Music in an ordinary tab, is ignored. Installed apps are discovered from `~/Applications/*Apps.localized`. Set `MIXTAPE_SOURCES` to a comma-separated list of bundle IDs to override.
- Played time only accrues while the track is actually playing. Pauses, gaps between tracks and time the Mac spends asleep don't count.
- Looping a track counts each loop as a separate play.

A play **counts as a listen** once you've heard half the track or 4 minutes, whichever comes first. Tracks of 30 seconds or less never count. This is Last.fm's scrobbling rule. Shorter plays show up as *skipped*. Listening time includes everything you heard, skips included.

Everything stays on your Mac in a SQLite database at `~/.local/share/mixtape/mixtape.db` (or under `$XDG_DATA_HOME`, or `$MIXTAPE_HOME`). It keeps growing, so your history is never thrown away.

### Caveats

- Since macOS 15.4, Apple restricts reading Now Playing to its own apps. `media-control` works around this, and it works on macOS 27, but a future macOS update could break it until `media-control` catches up.
- YouTube Music doesn't always report an album, so album info is best-effort.

## Development

```sh
npm install
npm test           # node:test, runs the TypeScript sources directly
npm run typecheck
npm run build      # TypeScript 7 → dist/
npm run dev -- week
```

There are no runtime dependencies: storage uses `node:sqlite`, which is built into Node.

Releasing: bump `version` in `package.json`, commit, then tag `vX.Y.Z` and push the tag. The release workflow tests the code, then attaches `mixtape.tgz` to a GitHub release, which is what `install.sh` installs. Finally, update `url` and `sha256` in `Formula/mixtape.rb`.
